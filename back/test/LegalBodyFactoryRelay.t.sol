// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ControllerRelayHarness} from "./helpers/ControllerRelayHarness.sol";
import {ControllerSelectors} from "../src/libraries/ControllerSelectors.sol";
import {NoviController} from "../src/NoviController.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract LegalBodyFactoryRelayTest is ControllerRelayHarness {
    MockIdentityRegistry internal registry;
    LegalManager internal impl;
    LegalBodyFactory internal factory;
    address internal stranger = makeAddr("stranger");
    uint256 internal ownerPk = 0xA11CE;
    uint256 internal guardianPk = 0xB0B;
    address internal guardian;
    uint256 internal agentId;
    bytes32 internal constant OA = keccak256("oa-manifest-v1");
    uint256 internal constant DELAY = 48 hours;

    function setUp() public {
        vm.warp(1_700_000_000);
        registry = new MockIdentityRegistry();
        (bytes4[] memory ps, address[] memory pt) = _registryPins(address(registry));
        controller = new NoviController(24 hours, admin, executor, _grantedSelectors(), ps, pt);
        impl = new LegalManager();
        factory = new LegalBodyFactory(address(impl), address(registry), address(controller));
        guardian = vm.addr(guardianPk);
        vm.prank(makeAddr("burn")); // a test contract cannot receive the registry's _safeMint
        registry.register("ipfs://burn-id-0");
        vm.prank(vm.addr(ownerPk));
        agentId = registry.register("ipfs://agent");
        _minimalCeremony(address(factory));
    }

    function _sig(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    function _createCall(uint256 deadline) internal view returns (bytes memory) {
        bytes memory link = _sig(ownerPk, factory.linkDigest(agentId, guardian, DELAY, OA, deadline));
        return abi.encodeCall(LegalBodyFactory.createLegalBody, (agentId, guardian, DELAY, OA, deadline, link));
    }

    function _createViaRelay() internal returns (address body) {
        body = abi.decode(_relayOk(executor, address(factory), _createCall(block.timestamp + 1 hours)), (address));
    }

    /// @dev The deploy script labels the printed ceremony by position, so this order is load-bearing.
    function test_minimalGrantsOrder() public pure {
        bytes4[] memory s = ControllerSelectors.minimalGrants();
        assertEq(s.length, 2);
        assertEq(s[0], LegalBodyFactory.createLegalBody.selector);
        assertEq(s[1], LegalBodyFactory.scheduleOperatingAgreementUpdate.selector);
    }

    function test_ceremony_pinsAndGrants() public view {
        bytes4[] memory s = ControllerSelectors.minimalGrants();
        for (uint256 i = 0; i < s.length; i++) {
            assertEq(controller.boundTarget(s[i]), address(factory));
            assertTrue(controller.hasRole(bytes32(s[i]), executor));
        }
        assertEq(factory.owner(), address(controller), "owned from construction, no acceptOwnership ceremony");
    }

    function test_executorRelaysCreate() public {
        address body = _createViaRelay();
        assertEq(LegalManager(payable(body)).manager(), address(factory));
        assertEq(factory.identityOwnerAtCreation(body), vm.addr(ownerPk));
    }

    function test_createIsPinnedToTheFactory() public {
        LegalBodyFactory decoy = new LegalBodyFactory(address(impl), address(registry), address(controller));
        (bool ok, bytes memory ret) = _relay(executor, address(decoy), _createCall(block.timestamp + 1 hours));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                NoviController.TargetNotBound.selector, LegalBodyFactory.createLegalBody.selector, address(decoy)
            )
        );
    }

    function test_strangerAndDirectCallsRefused() public {
        bytes memory data = _createCall(block.timestamp + 1 hours);
        (bool ok,) = _relay(stranger, address(factory), data);
        assertFalse(ok);
        vm.prank(executor);
        (ok,) = address(factory).call(data); // the executor is not the factory's owner
        assertFalse(ok);
    }

    function test_executorRelaysGuardianSignedAmendment() public {
        address body = _createViaRelay();
        bytes32 h = keccak256("oa-manifest-v2");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory gsig = _sig(guardianPk, factory.amendmentDigest(body, h, 0, deadline));
        _relayOk(
            executor,
            address(factory),
            abi.encodeCall(LegalBodyFactory.scheduleOperatingAgreementUpdate, (body, h, deadline, gsig))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(stranger);
        factory.executeOperatingAgreementUpdate(body, h);
        (,, bytes32 oa,) = LegalManager(payable(body)).meta();
        assertEq(oa, h);
    }

    function test_executorCannotAmendWithoutGuardian() public {
        address body = _createViaRelay();
        bytes32 h = keccak256("attacker-oa");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory notGuardian = _sig(0xE0E0, factory.amendmentDigest(body, h, 0, deadline));
        (bool ok, bytes memory ret) = _relay(
            executor,
            address(factory),
            abi.encodeCall(LegalBodyFactory.scheduleOperatingAgreementUpdate, (body, h, deadline, notGuardian))
        );
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector));
    }

    function test_standingLegalManagerGrantDoesNotReachMinimalBodies() public {
        // The executor already holds LegalManager.scheduleOperatingAgreementUpdate for
        // full-product bodies. A Minimal body's manager is the factory, so the relay is refused.
        address body = _createViaRelay();
        (bool ok, bytes memory ret) =
            _relay(executor, body, abi.encodeCall(LegalManager.scheduleOperatingAgreementUpdate, (keccak256("x"))));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(LegalManager.NotManager.selector));
    }

    function test_adminWithWildcardCannotDissolveOrSweep() public {
        address body = _createViaRelay();
        bytes32 wildcard = controller.WILDCARD_ROLE(); // read BEFORE the prank: a call in the arguments would consume it
        vm.prank(admin);
        controller.grantRole(wildcard, admin);

        (bool ok, bytes memory ret) = _relay(admin, body, abi.encodeCall(LegalManager.initiateDissolution, ()));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(LegalManager.NotAuthorized.selector));

        // Relaying a dissolution selector at the factory finds no such function.
        (ok,) = _relay(admin, address(factory), abi.encodeCall(LegalManager.initiateDissolution, ()));
        assertFalse(ok);

        // The guardian dissolves alone; nobody can cancel it.
        vm.prank(guardian);
        LegalManager(payable(body)).initiateDissolution();
        (ok, ret) = _relay(admin, body, abi.encodeCall(LegalManager.cancelDissolution, ()));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(LegalManager.NotAuthorized.selector));

        vm.warp(block.timestamp + DELAY);
        address[] memory tokens = new address[](0);
        (ok, ret) = _relay(admin, body, abi.encodeCall(LegalManager.sweep, (tokens, admin)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(LegalManager.NotAuthorized.selector));
    }
}
