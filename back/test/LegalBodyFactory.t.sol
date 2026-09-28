// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

abstract contract LegalBodyFactoryTestBase is Test {
    MockIdentityRegistry internal registry;
    LegalManager internal impl;
    LegalBodyFactory internal factory;

    /// @dev Stand-in for the NoviController: the factory's owner.
    address internal novi = makeAddr("novi");
    address internal stranger = makeAddr("stranger");

    uint256 internal ownerPk = 0xA11CE;
    address internal idOwner;
    uint256 internal guardianPk = 0xB0B;
    address internal guardian;
    uint256 internal agentId;

    bytes32 internal constant OA = keccak256("oa-manifest-v1");
    uint256 internal constant DELAY = 48 hours;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        registry = new MockIdentityRegistry();
        impl = new LegalManager();
        factory = new LegalBodyFactory(address(impl), address(registry), novi);
        idOwner = vm.addr(ownerPk);
        guardian = vm.addr(guardianPk);
        vm.prank(makeAddr("burn")); // a test contract cannot receive the registry's _safeMint
        registry.register("ipfs://burn-id-0"); // agentId 0 goes to a throwaway EOA, so real ids are non-zero
        vm.prank(idOwner);
        agentId = registry.register("ipfs://agent");
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signLink(uint256 pk, uint256 id, address g, uint256 delay, bytes32 oa, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, factory.linkDigest(id, g, delay, oa, deadline));
    }

    function _create() internal returns (address body) {
        return _createWith(block.timestamp + 1 hours);
    }

    function _createWith(uint256 deadline) internal returns (address body) {
        bytes memory sig = _signLink(ownerPk, agentId, guardian, DELAY, OA, deadline);
        vm.prank(novi);
        body = factory.createLegalBody(agentId, guardian, DELAY, OA, deadline, sig);
    }

    function _expectCreateRevert(
        bytes memory err,
        address g,
        uint256 delay,
        uint256 deadline,
        bytes memory sig
    ) internal {
        vm.prank(novi);
        vm.expectRevert(err);
        factory.createLegalBody(agentId, g, delay, OA, deadline, sig);
    }
}

contract LegalBodyFactoryConstructionTest is LegalBodyFactoryTestBase {
    function test_constructor_setsImmutablesAndOwner() public view {
        assertEq(factory.implementation(), address(impl));
        assertEq(address(factory.identityRegistry()), address(registry));
        assertEq(factory.owner(), novi);
    }

    function test_constructor_refusesNonContracts() public {
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotContract.selector, address(0xBEEF)));
        new LegalBodyFactory(address(0xBEEF), address(registry), novi);
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotContract.selector, address(0xBEEF)));
        new LegalBodyFactory(address(impl), address(0xBEEF), novi);
    }

    function test_constructor_acceptsLockedImplementation() public {
        LegalManager locked = new LegalManager();
        LegalBodyFactory f = new LegalBodyFactory(address(locked), address(registry), novi);
        assertEq(f.implementation(), address(locked));
    }

    /// An existing full-product body is a BeaconProxy. Cloning it would forward every body to an
    /// upgradeable beacon, so it must be refused.
    function test_constructor_refusesInitialisedBeaconProxy() public {
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(impl), address(this));
        bytes memory init = abi.encodeCall(
            LegalManager.initialize, (makeAddr("platform"), makeAddr("fpGuardian"), 1 hours, 7, "", 0, bytes32(0))
        );
        address proxy = address(new BeaconProxy(address(beacon), init));
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotImplementation.selector, proxy));
        new LegalBodyFactory(proxy, address(registry), novi);
    }

    /// An uninitialised proxy has an empty `manager` too; the initialisation probe catches it,
    /// and the constructor's revert rolls the probe's initialisation back.
    function test_constructor_refusesUninitialisedBeaconProxy() public {
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(impl), address(this));
        address proxy = address(new BeaconProxy(address(beacon), ""));
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotImplementation.selector, proxy));
        new LegalBodyFactory(proxy, address(registry), novi);
        assertEq(LegalManager(payable(proxy)).manager(), address(0), "the probe left no trace");
    }

    function test_constructor_refusesUninitialisedClone() public {
        address clone = Clones.clone(address(impl));
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotImplementation.selector, clone));
        new LegalBodyFactory(clone, address(registry), novi);
    }

    function test_constructor_refusesNonLegalManager() public {
        vm.expectRevert(); // the registry has no manager(): the call itself reverts
        new LegalBodyFactory(address(registry), address(registry), novi);
    }

    function test_constructor_refusesBeaconItself() public {
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(impl), address(this));
        vm.expectRevert(); // a beacon has no manager(): the call itself reverts
        new LegalBodyFactory(address(beacon), address(registry), novi);
    }

    function test_constructor_refusesZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LegalBodyFactory(address(impl), address(registry), address(0));
    }

    function test_renounceOwnership_disabled() public {
        vm.prank(novi);
        vm.expectRevert(LegalBodyFactory.OwnershipRenounceDisabled.selector);
        factory.renounceOwnership();
    }

    function test_ownership_twoStepHandover() public {
        address next = makeAddr("nextController");
        vm.prank(novi);
        factory.transferOwnership(next);
        assertEq(factory.owner(), novi);
        vm.prank(next);
        factory.acceptOwnership();
        assertEq(factory.owner(), next);
    }
}

contract LegalBodyFactoryCreateTest is LegalBodyFactoryTestBase {
    function test_linkDigest_matchesIndependentEncoding() public view {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 typeHash = keccak256(
            "LegalBodyLink(uint256 agentId,address guardian,uint256 amendmentDelay,bytes32 operatingAgreementHash,uint256 deadline)"
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Novi LegalBodyFactory")),
                keccak256(bytes("1")),
                block.chainid,
                address(factory)
            )
        );
        bytes32 structHash = keccak256(abi.encode(typeHash, agentId, guardian, DELAY, OA, deadline));
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        assertEq(factory.linkDigest(agentId, guardian, DELAY, OA, deadline), expected);
        assertEq(factory.LINK_TYPEHASH(), typeHash);
    }

    function test_create_happyPath() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = factory.linkDigest(agentId, guardian, DELAY, OA, deadline);
        address predicted = factory.predictLegalBody(digest);

        vm.expectEmit(true, true, true, true, address(factory));
        emit LegalBodyFactory.LegalBodyCreated(agentId, predicted, idOwner, guardian, digest);
        address body = _createWith(deadline);

        assertEq(body, predicted, "deterministic address");
        LegalManager lm = LegalManager(payable(body));
        assertEq(lm.manager(), address(factory));
        assertEq(lm.guardian(), guardian);
        assertEq(lm.amendmentDelay(), DELAY);
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
        (string memory ein, uint64 formationDate, bytes32 oaHash, uint256 bodyAgentId) = lm.meta();
        assertEq(bytes(ein).length, 0);
        assertEq(formationDate, 0);
        assertEq(oaHash, OA);
        assertEq(bodyAgentId, agentId);
        assertEq(factory.identityOwnerAtCreation(body), idOwner);
        assertTrue(factory.isLegalBody(body));
        assertEq(body.code.length, 45, "EIP-1167 minimal proxy");
    }

    function test_create_cloneCannotBeReinitialised() public {
        address body = _create();
        vm.expectRevert(); // Initializable: InvalidInitialization
        LegalManager(payable(body)).initialize(stranger, stranger, DELAY, agentId, "", 0, OA);
    }

    function test_create_onlyOwner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(ownerPk, agentId, guardian, DELAY, OA, deadline);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.createLegalBody(agentId, guardian, DELAY, OA, deadline, sig);
    }

    function test_create_deadlineWindow() public {
        uint256 past = block.timestamp - 1;
        _expectCreateRevert(
            abi.encodeWithSelector(LegalBodyFactory.BadDeadline.selector), guardian, DELAY, past,
            _signLink(ownerPk, agentId, guardian, DELAY, OA, past)
        );
        uint256 tooFar = block.timestamp + 24 hours + 1;
        _expectCreateRevert(
            abi.encodeWithSelector(LegalBodyFactory.BadDeadline.selector), guardian, DELAY, tooFar,
            _signLink(ownerPk, agentId, guardian, DELAY, OA, tooFar)
        );
        // Both edges are inclusive.
        _createWith(block.timestamp);
        _createWith(block.timestamp + 24 hours);
    }

    function test_create_delayBounds() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256[2] memory bad = [uint256(48 hours - 1), uint256(30 days + 1)];
        for (uint256 i = 0; i < bad.length; i++) {
            _expectCreateRevert(
                abi.encodeWithSelector(LegalBodyFactory.BadDelay.selector), guardian, bad[i], deadline,
                _signLink(ownerPk, agentId, guardian, bad[i], OA, deadline)
            );
        }
        uint256[2] memory good = [uint256(48 hours), uint256(30 days)];
        for (uint256 i = 0; i < good.length; i++) {
            bytes memory sig = _signLink(ownerPk, agentId, guardian, good[i], OA, deadline);
            vm.prank(novi);
            factory.createLegalBody(agentId, guardian, good[i], OA, deadline, sig);
        }
    }

    function test_create_maxDelayStillLetsGuardianDissolve() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(ownerPk, agentId, guardian, 30 days, OA, deadline);
        vm.prank(novi);
        address body = factory.createLegalBody(agentId, guardian, 30 days, OA, deadline, sig);
        vm.prank(guardian);
        LegalManager(payable(body)).initiateDissolution();
        vm.warp(block.timestamp + 30 days);
        vm.prank(guardian);
        LegalManager(payable(body)).finalizeDissolution();
        assertEq(uint8(LegalManager(payable(body)).status()), uint8(LegalManager.Status.Dissolved));
    }

    function test_create_refusesUnusableGuardians() public {
        uint256 deadline = block.timestamp + 1 hours;
        address[3] memory bad = [address(0), novi, address(factory)];
        for (uint256 i = 0; i < bad.length; i++) {
            _expectCreateRevert(
                abi.encodeWithSelector(LegalBodyFactory.BadGuardian.selector), bad[i], DELAY, deadline,
                _signLink(ownerPk, agentId, bad[i], DELAY, OA, deadline)
            );
        }
    }

    function test_create_guardianMayEqualIdentityOwner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(ownerPk, agentId, idOwner, DELAY, OA, deadline);
        vm.prank(novi);
        address body = factory.createLegalBody(agentId, idOwner, DELAY, OA, deadline, sig);
        assertEq(LegalManager(payable(body)).guardian(), idOwner);
    }

    function test_create_everySignedFieldIsBinding() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(ownerPk, agentId, guardian, DELAY, OA, deadline);
        bytes memory err = abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector);
        // A different guardian, delay, OA hash or deadline than signed.
        _expectCreateRevert(err, makeAddr("otherGuardian"), DELAY, deadline, sig);
        _expectCreateRevert(err, guardian, DELAY + 1, deadline, sig);
        _expectCreateRevert(err, guardian, DELAY, deadline - 1, sig);
        vm.prank(novi);
        vm.expectRevert(err);
        factory.createLegalBody(agentId, guardian, DELAY, keccak256("other-oa"), deadline, sig);
        // A different agentId (owned by the same key, so only the signed field differs).
        vm.prank(idOwner);
        uint256 otherId = registry.register("ipfs://other");
        vm.prank(novi);
        vm.expectRevert(err);
        factory.createLegalBody(otherId, guardian, DELAY, OA, deadline, sig);
    }

    function test_create_signerMustBeCurrentOwner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory byStranger = _signLink(0xBAD, agentId, guardian, DELAY, OA, deadline);
        _expectCreateRevert(
            abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector), guardian, DELAY, deadline, byStranger
        );
        // A link signed by the owner, then the identity is transferred before the deploy: refused.
        bytes memory byOldOwner = _signLink(ownerPk, agentId, guardian, DELAY, OA, deadline);
        vm.prank(idOwner);
        registry.transferFrom(idOwner, makeAddr("buyer"), agentId);
        _expectCreateRevert(
            abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector), guardian, DELAY, deadline, byOldOwner
        );
    }

    function test_create_revertsOnMalformedSignatures() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = factory.linkDigest(agentId, guardian, DELAY, OA, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        bytes memory err = abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector);
        // 64-byte compact (EIP-2098) form is not accepted.
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        _expectCreateRevert(err, guardian, DELAY, deadline, abi.encodePacked(r, vs));
        // Wrong v.
        _expectCreateRevert(err, guardian, DELAY, deadline, abi.encodePacked(r, s, uint8(29)));
        // High-s twin of a valid signature.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        _expectCreateRevert(err, guardian, DELAY, deadline, abi.encodePacked(r, highS, flippedV));
        // Empty.
        _expectCreateRevert(err, guardian, DELAY, deadline, "");
    }

    function test_create_replayRevertsWithExistingAddress() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(ownerPk, agentId, guardian, DELAY, OA, deadline);
        vm.prank(novi);
        address body = factory.createLegalBody(agentId, guardian, DELAY, OA, deadline, sig);
        vm.prank(novi);
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.LegalBodyExists.selector, body));
        factory.createLegalBody(agentId, guardian, DELAY, OA, deadline, sig);
    }

    function test_create_secondLinkMakesSecondBody() public {
        address first = _createWith(block.timestamp + 1 hours);
        address second = _createWith(block.timestamp + 2 hours);
        assertTrue(first != second);
        assertTrue(factory.isLegalBody(first) && factory.isLegalBody(second));
    }

    function test_create_erc1271Owner() public {
        uint256 walletSignerPk = 0xC0FFEE;
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(walletSignerPk));
        vm.prank(vm.addr(walletSignerPk));
        bytes memory ret = wallet.execute(address(registry), abi.encodeCall(registry.register, ("ipfs://wallet")));
        uint256 walletAgent = abi.decode(ret, (uint256));

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(walletSignerPk, factory.linkDigest(walletAgent, guardian, DELAY, OA, deadline));
        vm.prank(novi);
        address body = factory.createLegalBody(walletAgent, guardian, DELAY, OA, deadline, sig);
        assertEq(factory.identityOwnerAtCreation(body), address(wallet));

        vm.prank(vm.addr(walletSignerPk));
        wallet.setRefuseAll(true);
        uint256 d2 = block.timestamp + 2 hours;
        bytes memory sig2 = _sign(walletSignerPk, factory.linkDigest(walletAgent, guardian, DELAY, OA, d2));
        vm.prank(novi);
        vm.expectRevert(LegalBodyFactory.BadSignature.selector);
        factory.createLegalBody(walletAgent, guardian, DELAY, OA, d2, sig2);
    }

    function test_create_unknownAgentIdReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(ownerPk, 999, guardian, DELAY, OA, deadline);
        vm.prank(novi);
        vm.expectRevert(); // registry: nonexistent token
        factory.createLegalBody(999, guardian, DELAY, OA, deadline, sig);
    }

    function test_create_gasRegressionGuard() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(ownerPk, agentId, guardian, DELAY, OA, deadline);
        vm.prank(novi);
        uint256 before = gasleft();
        factory.createLegalBody(agentId, guardian, DELAY, OA, deadline, sig);
        uint256 used = before - gasleft();
        assertLt(used, 320_000, "createLegalBody grew; re-measure and justify");
    }
}

contract LegalBodyFactoryAmendmentTest is LegalBodyFactoryTestBase {
    address internal body;
    bytes32 internal constant NEW = keccak256("oa-manifest-v2");

    function setUp() public override {
        super.setUp();
        body = _create();
    }

    function _signAmendment(uint256 pk, address lb, bytes32 h, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, factory.amendmentDigest(lb, h, nonce, deadline));
    }

    function _schedule(bytes32 h) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAmendment(guardianPk, body, h, factory.amendmentNonce(body), deadline);
        vm.prank(novi);
        factory.scheduleOperatingAgreementUpdate(body, h, deadline, sig);
    }

    function test_amendmentDigest_matchesIndependentEncoding() public view {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 typeHash =
            keccak256("OperatingAgreementUpdate(address legalBody,bytes32 newHash,uint256 nonce,uint256 deadline)");
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Novi LegalBodyFactory")),
                keccak256(bytes("1")),
                block.chainid,
                address(factory)
            )
        );
        bytes32 structHash = keccak256(abi.encode(typeHash, body, NEW, uint256(0), deadline));
        assertEq(
            factory.amendmentDigest(body, NEW, 0, deadline),
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash))
        );
        assertEq(factory.AMENDMENT_TYPEHASH(), typeHash);
    }

    function test_schedule_thenStrangerExecutesAfterDelay() public {
        _schedule(NEW);
        assertEq(factory.amendmentNonce(body), 1);
        assertEq(LegalManager(payable(body)).scheduledAt(NEW), block.timestamp + DELAY);

        vm.prank(stranger);
        vm.expectRevert(LegalManager.TooEarly.selector);
        factory.executeOperatingAgreementUpdate(body, NEW);

        vm.warp(block.timestamp + DELAY);
        vm.prank(stranger); // permissionless: nobody can sit on a guardian-approved amendment
        factory.executeOperatingAgreementUpdate(body, NEW);
        (,, bytes32 oaHash,) = LegalManager(payable(body)).meta();
        assertEq(oaHash, NEW);
    }

    function test_schedule_onlyOwner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAmendment(guardianPk, body, NEW, 0, deadline);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.scheduleOperatingAgreementUpdate(body, NEW, deadline, sig);
    }

    function test_schedule_requiresGuardianSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256[2] memory wrongKeys = [ownerPk, uint256(0xBAD)];
        for (uint256 i = 0; i < wrongKeys.length; i++) {
            bytes memory sig = _signAmendment(wrongKeys[i], body, NEW, 0, deadline);
            vm.prank(novi);
            vm.expectRevert(LegalBodyFactory.BadSignature.selector);
            factory.scheduleOperatingAgreementUpdate(body, NEW, deadline, sig);
        }
        // Signed for a different hash, nonce or body.
        bytes memory otherHash = _signAmendment(guardianPk, body, keccak256("x"), 0, deadline);
        bytes memory otherNonce = _signAmendment(guardianPk, body, NEW, 1, deadline);
        address otherBody = _createWith(block.timestamp + 2 hours);
        bytes memory forOtherBody = _signAmendment(guardianPk, otherBody, NEW, 0, deadline);
        bytes[3] memory sigs = [otherHash, otherNonce, forOtherBody];
        for (uint256 i = 0; i < sigs.length; i++) {
            vm.prank(novi);
            vm.expectRevert(LegalBodyFactory.BadSignature.selector);
            factory.scheduleOperatingAgreementUpdate(body, NEW, deadline, sigs[i]);
        }
    }

    function test_schedule_signatureCannotBeReplayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAmendment(guardianPk, body, NEW, 0, deadline);
        vm.prank(novi);
        factory.scheduleOperatingAgreementUpdate(body, NEW, deadline, sig);
        vm.prank(novi);
        vm.expectRevert(LegalBodyFactory.BadSignature.selector); // nonce moved to 1
        factory.scheduleOperatingAgreementUpdate(body, NEW, deadline, sig);
    }

    function test_schedule_deadlineWindow() public {
        uint256 tooFar = block.timestamp + 24 hours + 1;
        bytes memory sig = _signAmendment(guardianPk, body, NEW, 0, tooFar);
        vm.prank(novi);
        vm.expectRevert(LegalBodyFactory.BadDeadline.selector);
        factory.scheduleOperatingAgreementUpdate(body, NEW, tooFar, sig);
    }

    function test_schedule_andExecute_refuseForeignBodies() public {
        LegalManager foreign = LegalManager(payable(Clones_clone(address(impl))));
        foreign.initialize(address(factory), guardian, DELAY, agentId, "", 0, OA); // look-alike naming us as manager
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAmendment(guardianPk, address(foreign), NEW, 0, deadline);
        vm.prank(novi);
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotLegalBody.selector, address(foreign)));
        factory.scheduleOperatingAgreementUpdate(address(foreign), NEW, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotLegalBody.selector, address(foreign)));
        factory.executeOperatingAgreementUpdate(address(foreign), NEW);
    }

    function test_guardianVetoAfterScheduleBlocksExecute() public {
        _schedule(NEW);
        vm.prank(guardian);
        LegalManager(payable(body)).cancelOperatingAgreementUpdate(NEW);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(LegalManager.NotScheduled.selector);
        factory.executeOperatingAgreementUpdate(body, NEW);
        // A vetoed hash cannot be scheduled again, even with a fresh guardian signature...
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAmendment(guardianPk, body, NEW, factory.amendmentNonce(body), deadline);
        vm.prank(novi);
        vm.expectRevert(LegalManager.Vetoed.selector);
        factory.scheduleOperatingAgreementUpdate(body, NEW, deadline, sig);
        // ...until the guardian lifts the veto; then a signature for the current nonce works.
        vm.prank(guardian);
        LegalManager(payable(body)).liftVeto(NEW);
        vm.prank(novi);
        factory.scheduleOperatingAgreementUpdate(body, NEW, deadline, sig);
    }

    function _oa() internal view returns (bytes32 h) {
        (,, h,) = LegalManager(payable(body)).meta();
    }

    /// The guardian approves A, then approves B to replace it and never vetoes A. Once B has run,
    /// A must never run, however long anyone waits.
    function test_supersededAmendmentNeverExecutes() public {
        bytes32 a = keccak256("oa-v2-with-typo");
        bytes32 b = keccak256("oa-v2-fixed");
        _schedule(a);
        assertEq(factory.pendingAmendment(body), a);
        vm.warp(block.timestamp + 1 hours);
        _schedule(b);
        assertEq(factory.pendingAmendment(body), b, "a new schedule supersedes the older one");
        vm.warp(block.timestamp + DELAY);
        factory.executeOperatingAgreementUpdate(body, b);
        assertEq(_oa(), b);

        vm.warp(block.timestamp + 90 days);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotPendingAmendment.selector, a));
        factory.executeOperatingAgreementUpdate(body, a);
        assertEq(_oa(), b, "the agreement never rolls back");
    }

    /// Both approvals matured at once: nobody can pick the order; only the last one runs.
    function test_onlyLastScheduledAmendmentExecutes() public {
        bytes32 a = keccak256("older");
        bytes32 b = keccak256("newer");
        _schedule(a);
        vm.warp(block.timestamp + 1 hours);
        _schedule(b);
        vm.warp(block.timestamp + DELAY);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotPendingAmendment.selector, a));
        factory.executeOperatingAgreementUpdate(body, a);
        vm.prank(stranger);
        factory.executeOperatingAgreementUpdate(body, b);
        assertEq(_oa(), b);
    }

    function test_executedAmendmentCannotExecuteAgain() public {
        _schedule(NEW);
        vm.warp(block.timestamp + DELAY);
        factory.executeOperatingAgreementUpdate(body, NEW);
        assertEq(factory.pendingAmendment(body), bytes32(0), "cleared on execution");
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotPendingAmendment.selector, NEW));
        factory.executeOperatingAgreementUpdate(body, NEW);
    }

    /// A veto of the pending hash blocks it; the next signed schedule of another hash works.
    function test_vetoedPendingAmendment_thenNewScheduleWorks() public {
        _schedule(NEW);
        vm.prank(guardian);
        LegalManager(payable(body)).cancelOperatingAgreementUpdate(NEW);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(LegalManager.NotScheduled.selector);
        factory.executeOperatingAgreementUpdate(body, NEW);

        bytes32 other = keccak256("oa-manifest-v3");
        _schedule(other);
        assertEq(factory.pendingAmendment(body), other);
        vm.warp(block.timestamp + DELAY);
        factory.executeOperatingAgreementUpdate(body, other);
        assertEq(_oa(), other);
    }

    function test_executeZeroHashReverts() public {
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.NotPendingAmendment.selector, bytes32(0)));
        factory.executeOperatingAgreementUpdate(body, bytes32(0));
    }

    function test_erc1271Guardian() public {
        uint256 walletSignerPk = 0xD00D;
        MockERC1271Wallet gWallet = new MockERC1271Wallet(vm.addr(walletSignerPk));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory link = _signLink(ownerPk, agentId, address(gWallet), DELAY, OA, deadline);
        vm.prank(novi);
        address wBody = factory.createLegalBody(agentId, address(gWallet), DELAY, OA, deadline, link);
        bytes memory sig = _sign(walletSignerPk, factory.amendmentDigest(wBody, NEW, 0, deadline));
        vm.prank(novi);
        factory.scheduleOperatingAgreementUpdate(wBody, NEW, deadline, sig);
        assertEq(factory.amendmentNonce(wBody), 1);
    }

    function test_factoryExposesNoDissolutionSweepOrVetoPath() public {
        string memory json = vm.readFile("out/LegalBodyFactory.sol/LegalBodyFactory.json");
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        for (uint256 i = 0; i < sigs.length; i++) {
            bytes memory s = bytes(sigs[i]);
            assertFalse(_contains(s, "issolution"), sigs[i]);
            assertFalse(_contains(s, "weep"), sigs[i]);
            assertFalse(_contains(s, "eto"), sigs[i]);
            assertFalse(_contains(s, "cancel"), sigs[i]);
        }
        // Behavioural half: the body's manager-only dissolution powers are unreachable.
        vm.prank(novi);
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        LegalManager(payable(body)).initiateDissolution();
        vm.prank(guardian);
        LegalManager(payable(body)).initiateDissolution();
        vm.prank(guardian); // the initiator cannot cancel, and the manager (the factory) never will
        vm.expectRevert(LegalManager.NotAuthorized.selector);
        LegalManager(payable(body)).cancelDissolution();
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i = 0; i <= hay.length - needle.length; i++) {
            bool m = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    m = false;
                    break;
                }
            }
            if (m) return true;
        }
        return false;
    }

    function Clones_clone(address implementation_) internal returns (address) {
        return Clones.clone(implementation_);
    }
}

contract LegalBodyFactoryPredicateTest is LegalBodyFactoryTestBase {
    address internal body;

    function setUp() public override {
        super.setUp();
        body = _create();
    }

    function _point(bytes memory value) internal {
        vm.prank(idOwner);
        registry.setMetadata(agentId, "legalBody", value);
    }

    function test_encodePointer_isAbiTuple() public view {
        bytes memory p = factory.encodePointer(body);
        assertEq(p.length, 96);
        assertEq(p, abi.encode(uint8(1), block.chainid, body));
    }

    function test_linked_whenOwnerPointsAtBody() public {
        assertEq(factory.linkedLegalBody(agentId), address(0), "no pointer yet");
        _point(factory.encodePointer(body));
        assertEq(factory.linkedLegalBody(agentId), body);
    }

    function test_pointerDecidesBetweenSeveralBodies() public {
        address second = _createWith(block.timestamp + 2 hours);
        _point(factory.encodePointer(second));
        assertEq(factory.linkedLegalBody(agentId), second);
        _point(factory.encodePointer(body));
        assertEq(factory.linkedLegalBody(agentId), body);
    }

    function test_malformedPointersNeverRevertAndNeverLink() public {
        bytes[] memory bad = new bytes[](9);
        bad[0] = "";
        bad[1] = abi.encodePacked(uint8(1), uint64(block.chainid), body);              // packed 29 bytes
        bad[2] = abi.encode(uint8(2), block.chainid, body);                            // wrong version
        bad[3] = abi.encode(uint8(1), block.chainid + 1, body);                        // another chain
        bad[4] = abi.encodePacked(abi.encode(uint8(1), block.chainid, body), uint8(0)); // 97 bytes
        bad[5] = abi.encode(uint8(1), block.chainid, uint256(uint160(body)) | (uint256(1) << 200)); // dirty high bits
        bad[6] = abi.encode(uint8(1), block.chainid, address(impl));                    // not made here
        bad[7] = abi.encode(uint8(1), block.chainid, makeAddr("eoa"));                  // no code
        bad[8] = abi.encode(uint256(1) << 8 | 1, block.chainid, body);                  // version word with extra bits
        for (uint256 i = 0; i < bad.length; i++) {
            _point(bad[i]);
            assertEq(factory.linkedLegalBody(agentId), address(0));
        }
    }

    function test_pointerCopiedOntoAnotherAgentDoesNotLink() public {
        vm.prank(idOwner);
        uint256 otherId = registry.register("ipfs://other");
        bytes memory pointer = factory.encodePointer(body); // read before the prank, which the next call consumes
        vm.prank(idOwner);
        registry.setMetadata(otherId, "legalBody", pointer);
        assertEq(factory.linkedLegalBody(otherId), address(0), "body names a different agentId");
    }

    function test_identityTransferBreaksLinkButPointerSurvives() public {
        bytes memory p = factory.encodePointer(body);
        _point(p);
        address buyer = makeAddr("buyer");
        vm.prank(idOwner);
        registry.transferFrom(idOwner, buyer, agentId);
        assertEq(registry.getMetadata(agentId, "legalBody"), p);
        assertEq(factory.linkedLegalBody(agentId), address(0));
    }

    function test_dissolutionBreaksLink() public {
        _point(factory.encodePointer(body));
        vm.prank(guardian);
        LegalManager(payable(body)).initiateDissolution();
        assertEq(factory.linkedLegalBody(agentId), address(0), "winding down is not linked");
    }

    function test_clearedPointerUnlinks() public {
        _point(factory.encodePointer(body));
        _point("");
        assertEq(factory.linkedLegalBody(agentId), address(0));
    }

    function test_unknownAgentIdReturnsZero() public view {
        assertEq(factory.linkedLegalBody(424242), address(0));
    }
}
