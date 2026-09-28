// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ControllerRelayHarness} from "./helpers/ControllerRelayHarness.sol";
import {NoviController} from "../src/NoviController.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// @notice Rehearses the legal-body factory against live Arc testnet state: the live identity
///         registry, clones of the live LegalManager implementation, and the live controller
///         with its real admin performing the pin-then-grant ceremony. Nothing is broadcast.
contract LegalBodyFactoryForkTest is ControllerRelayHarness {
    address internal constant LIVE_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant LIVE_CONTROLLER = 0x9526E228E94A125843B2d010c1155780CBBAFb5c;
    address internal constant LIVE_FULL_FACTORY = 0x83D529E813Fe825b84250034A7A63f460A2ECA77;

    IIdentityRegistry internal registry = IIdentityRegistry(LIVE_REGISTRY);
    LegalBodyFactory internal factory;
    address internal liveImpl;
    bool internal forked;

    uint256 internal ownerPk = uint256(keccak256("minimal-fork-owner"));
    address internal idOwner;
    uint256 internal guardianPk = uint256(keccak256("minimal-fork-guardian"));
    address internal guardian;
    uint256 internal agentId;
    bytes32 internal constant OA = keccak256("oa-manifest-v1");
    uint256 internal constant DELAY = 48 hours;

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    function _supportsPush0() internal returns (bool ok) {
        bytes memory initcode = hex"5f";
        address probe;
        assembly {
            probe := create(0, add(initcode, 0x20), mload(initcode))
        }
        ok = probe != address(0);
    }

    function setUp() public {
        string memory url = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(url).length == 0 || !_supportsPush0()) {
            require(!vm.envOr("FORK_TESTS_REQUIRED", false), "fork tests required but would skip");
            return;
        }
        vm.createSelectFork(url);
        forked = true;

        controller = NoviController(LIVE_CONTROLLER);
        admin = controller.defaultAdmin(); // the real admin, read from chain
        executor = makeAddr("forkExecutor"); // a fresh key, granted by the ceremony below
        liveImpl = LegalManagerFactory(LIVE_FULL_FACTORY).beacon().implementation();
        require(liveImpl.code.length > 0, "live implementation missing");

        factory = new LegalBodyFactory(liveImpl, LIVE_REGISTRY, LIVE_CONTROLLER);
        _minimalCeremony(address(factory));

        idOwner = vm.addr(ownerPk);
        guardian = vm.addr(guardianPk);
        vm.prank(idOwner);
        agentId = registry.register("ipfs://minimal-novi-fork");
    }

    function _sig(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    function _createViaLiveController() internal returns (address body) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory link = _sig(ownerPk, factory.linkDigest(agentId, guardian, DELAY, OA, deadline));
        bytes memory ret = _relayOk(
            executor,
            address(factory),
            abi.encodeCall(LegalBodyFactory.createLegalBody, (agentId, guardian, DELAY, OA, deadline, link))
        );
        body = abi.decode(ret, (address));
    }

    function test_fork_createClonesLiveImplementation() public onlyFork {
        address body = _createViaLiveController();
        assertEq(body.code.length, 45);
        // EIP-1167 runtime embeds the implementation at bytes [10, 30).
        bytes memory code = body.code;
        address embedded;
        assembly {
            embedded := shr(96, mload(add(code, 0x2a)))
        }
        assertEq(embedded, liveImpl);
        assertEq(LegalManager(payable(body)).manager(), address(factory));
        assertEq(uint8(LegalManager(payable(body)).status()), 0);
    }

    function test_fork_ownerPointerLinks_transferAndClearUnlink() public onlyFork {
        address body = _createViaLiveController();
        bytes memory p = factory.encodePointer(body);
        vm.prank(idOwner);
        registry.setMetadata(agentId, "legalBody", p);
        assertEq(factory.linkedLegalBody(agentId), body);

        vm.prank(idOwner);
        registry.setMetadata(agentId, "legalBody", "");
        assertEq(factory.linkedLegalBody(agentId), address(0), "cleared pointer");

        vm.prank(idOwner);
        registry.setMetadata(agentId, "legalBody", p);
        address buyer = makeAddr("buyer");
        vm.prank(idOwner);
        registry.transferFrom(idOwner, buyer, agentId);
        assertEq(registry.getMetadata(agentId, "legalBody"), p, "pointer survives the transfer");
        assertEq(factory.linkedLegalBody(agentId), address(0), "but no longer links");
    }

    function test_fork_guardianSignedAmendmentThroughLiveController() public onlyFork {
        address body = _createViaLiveController();
        bytes32 h = keccak256("oa-manifest-v2");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory gsig = _sig(guardianPk, factory.amendmentDigest(body, h, 0, deadline));
        _relayOk(
            executor,
            address(factory),
            abi.encodeCall(LegalBodyFactory.scheduleOperatingAgreementUpdate, (body, h, deadline, gsig))
        );
        vm.warp(block.timestamp + DELAY);
        factory.executeOperatingAgreementUpdate(body, h);
        (,, bytes32 oa,) = LegalManager(payable(body)).meta();
        assertEq(oa, h);
    }

    function test_fork_liveAdminWithWildcardCannotDissolve() public onlyFork {
        address body = _createViaLiveController();
        bytes32 wildcard = controller.WILDCARD_ROLE(); // read BEFORE the prank
        vm.prank(admin);
        controller.grantRole(wildcard, admin);
        (bool ok, bytes memory ret) = _relay(admin, body, abi.encodeCall(LegalManager.initiateDissolution, ()));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(LegalManager.NotAuthorized.selector));
    }

    function test_fork_liveStandingGrantDoesNotReachMinimalBody() public onlyFork {
        address body = _createViaLiveController();
        _grant(LegalManager.scheduleOperatingAgreementUpdate.selector, executor);
        (bool ok, bytes memory ret) =
            _relay(executor, body, abi.encodeCall(LegalManager.scheduleOperatingAgreementUpdate, (keccak256("x"))));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(LegalManager.NotManager.selector));
    }
}
