// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

contract LegalManagerFactoryTest is Test {
    LegalManagerFactory internal factory;
    MockIdentityRegistry internal registry;
    address internal manager = address(0xA11CE);
    address internal guardian = address(0x60A12D);
    address internal operator = address(0x0EEEA7);
    address internal beaconOwner = address(0xB1A);

    function setUp() public {
        registry = new MockIdentityRegistry();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry), beaconOwner);
    }

    function _defaultTreasuryCfg() internal returns (LegalManagerFactory.TreasuryConfig memory) {
        MockUSDC u = new MockUSDC();
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(u),
            payoutAddress: makeAddr("payout"),
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
    }

    function test_createEntityRegistersAgentAndDeploysProxy() public {
        (uint256 agentId, address proxy,) = factory.createEntity(
            manager, guardian, operator, 2 days, "ipfs://meta", "EIN-1", 1, keccak256("oa"), _defaultTreasuryCfg()
        );

        // Canonical registry assigns sequential ids starting at 0.
        assertEq(agentId, 0);
        assertTrue(proxy != address(0));

        LegalManager lm = LegalManager(payable(proxy));
        assertEq(lm.manager(), manager);
        (, , bytes32 oaHash, uint256 storedId) = lm.meta();
        assertEq(oaHash, keccak256("oa"));
        assertEq(storedId, 0);
    }

    function test_identityNftHandedToManager() public {
        (uint256 agentId, ,) = factory.createEntity(
            manager, guardian, operator, 2 days, "ipfs://meta", "EIN-1", 1, keccak256("oa"), _defaultTreasuryCfg()
        );
        // Register-only: the factory must not keep custody; the manager owns its identity.
        assertEq(registry.ownerOf(agentId), manager);
    }

    function test_beaconOwnerIsParameterized() public view {
        // H1: a configurable owner (multisig/timelock), not the deployer EOA.
        assertEq(factory.beacon().owner(), beaconOwner);
    }

    function test_registryTracksEntities() public {
        factory.createEntity(manager, guardian, operator, 1 days, "ipfs://a", "EIN-1", 1, keccak256("a"), _defaultTreasuryCfg());
        factory.createEntity(manager, guardian, operator, 1 days, "ipfs://b", "EIN-2", 2, keccak256("b"), _defaultTreasuryCfg());

        assertEq(factory.entitiesCount(), 2);
        assertTrue(factory.entityByAgentId(0) != address(0));
        assertTrue(factory.entityByAgentId(1) != address(0));
        assertTrue(factory.entityByAgentId(0) != factory.entityByAgentId(1));
    }

    function test_emitsEntityCreated() public {
        vm.recordLogs();
        (uint256 agentId, address proxy,) = factory.createEntity(
            manager, guardian, operator, 1 days, "ipfs://a", "EIN-1", 1, keccak256("a"), _defaultTreasuryCfg()
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("EntityCreated(uint256,address,address)")) {
                found = true;
                assertEq(uint256(logs[i].topics[1]), agentId);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), proxy);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), manager);
            }
        }
        assertTrue(found);
        assertTrue(proxy != address(0));
    }

    function test_nonOwnerCannotCreateEntity() public {
        LegalManagerFactory.TreasuryConfig memory cfg = _defaultTreasuryCfg();
        vm.prank(address(0xBAD));
        vm.expectRevert(); // OZ Ownable: OwnableUnauthorizedAccount
        factory.createEntity(manager, guardian, operator, 2 days, "ipfs://x", "EIN", 1, keccak256("x"), cfg);
    }

    function test_ownerIsDeployer() public view {
        assertEq(factory.owner(), address(this));
    }

    // ── Audit hardening (finding 4): two-step ownership + no accidental renounce ──

    /// renounceOwnership is disabled: it would permanently brick onboarding (no new legal bodies).
    function test_renounceOwnershipReverts() public {
        vm.expectRevert(LegalManagerFactory.OwnershipRenounceDisabled.selector);
        factory.renounceOwnership();
    }

    /// Ownership transfer is two-step: the new owner must accept, so a typo'd address can't
    /// silently lock the factory.
    function test_ownershipTransferIsTwoStep() public {
        address newOwner = makeAddr("newFactoryOwner");
        factory.transferOwnership(newOwner);
        // Not transferred until accepted.
        assertEq(factory.owner(), address(this));
        assertEq(factory.pendingOwner(), newOwner);

        vm.prank(newOwner);
        factory.acceptOwnership();
        assertEq(factory.owner(), newOwner);
        assertEq(factory.pendingOwner(), address(0));
    }

    /// Only the pending owner may accept.
    function test_onlyPendingOwnerAccepts() public {
        factory.transferOwnership(makeAddr("newFactoryOwner"));
        vm.prank(address(0xBAD));
        vm.expectRevert(); // OZ Ownable2Step: OwnableUnauthorizedAccount
        factory.acceptOwnership();
    }

    function test_constructorRejectsZeroBeaconOwner() public {
        LegalManager impl = new LegalManager();
        // OZ Ownable rejects the zero owner inside the UpgradeableBeacon constructor.
        vm.expectRevert();
        new LegalManagerFactory(address(impl), address(registry), address(0));
    }

    function test_invalidDelayBubblesUpFromInitialize() public {
        // amendmentDelay below the floor must revert the whole createEntity.
        LegalManagerFactory.TreasuryConfig memory cfg = _defaultTreasuryCfg();
        vm.expectRevert(LegalManager.DelayTooShort.selector);
        factory.createEntity(manager, guardian, operator, 1 minutes, "ipfs://x", "EIN", 1, keccak256("x"), cfg);
    }
}

/// @notice Exercises the separate, manager-signed wallet-binding step that replaces the
///         factory's old (unbuildable) inline setAgentWallet call. Proves the canonical
///         ERC-8004 flow actually works end-to-end against the faithful mock.
contract WalletBindingTest is Test {
    LegalManagerFactory internal factory;
    MockIdentityRegistry internal registry;
    address internal guardian = address(0x60A12D);
    address internal operator = address(0x0EEEA7);

    uint256 internal managerPk = 0xA11CE;
    address internal manager;

    function setUp() public {
        manager = vm.addr(managerPk);
        registry = new MockIdentityRegistry();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry), address(0xB1A));
    }

    function _defaultTreasuryCfg() internal returns (LegalManagerFactory.TreasuryConfig memory) {
        MockUSDC u = new MockUSDC();
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(u),
            payoutAddress: makeAddr("payout"),
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
    }

    function test_managerBindsWalletWithEip712Signature() public {
        (uint256 agentId, ,) = factory.createEntity(
            manager, guardian, operator, 2 days, "ipfs://meta", "EIN-1", 1, keccak256("oa"), _defaultTreasuryCfg()
        );
        assertEq(registry.ownerOf(agentId), manager);

        address walletToBind = vm.addr(managerPk); // manager binds its own wallet
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 digest = registry.walletSetDigest(agentId, walletToBind, manager, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(managerPk, digest);

        vm.prank(manager); // owner of the identity NFT
        registry.setAgentWallet(agentId, walletToBind, deadline, abi.encodePacked(r, s, v));

        assertEq(registry.getAgentWallet(agentId), walletToBind);
    }

    function test_bindingRejectsWrongSigner() public {
        (uint256 agentId, ,) = factory.createEntity(
            manager, guardian, operator, 2 days, "ipfs://meta", "EIN-1", 1, keccak256("oa"), _defaultTreasuryCfg()
        );
        address walletToBind = vm.addr(managerPk);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 digest = registry.walletSetDigest(agentId, walletToBind, manager, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xDEAD), digest); // wrong key

        vm.prank(manager);
        // Faithful to live: a wrong ECDSA sig falls through to the ERC-1271 path on an EOA -> this.
        vm.expectRevert(bytes("invalid wallet sig"));
        registry.setAgentWallet(agentId, walletToBind, deadline, abi.encodePacked(r, s, v));
    }

    function test_bindingRejectsDeadlineBeyondMaxWindow() public {
        (uint256 agentId,,) = factory.createEntity(
            manager, guardian, operator, 2 days, "ipfs://meta", "EIN-1", 1, keccak256("oa"), _defaultTreasuryCfg()
        );
        address walletToBind = vm.addr(managerPk);
        // One second past the registry's MAX_DEADLINE_DELAY (mirrors the live Arc 300s cap). The
        // signature is otherwise valid, so the deadline guard is the only reason this reverts.
        uint256 deadline = block.timestamp + 5 minutes + 1;
        bytes32 digest = registry.walletSetDigest(agentId, walletToBind, manager, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(managerPk, digest);

        vm.prank(manager);
        vm.expectRevert(bytes("deadline too far"));
        registry.setAgentWallet(agentId, walletToBind, deadline, abi.encodePacked(r, s, v));
    }
}

contract FactoryTreasuryWiringTest is Test {
    LegalManagerFactory internal factory;
    MockIdentityRegistry internal registry;
    MockUSDC internal usdc;

    address internal beaconOwner = makeAddr("beaconOwner");
    address internal manager  = makeAddr("manager");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal payout   = makeAddr("payout");

    function setUp() public {
        registry = new MockIdentityRegistry();
        usdc = new MockUSDC();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry), beaconOwner);
    }

    function test_createEntityDeploysWiredTreasury() public {
        LegalManagerFactory.TreasuryConfig memory cfg = LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc),
            payoutAddress: payout,
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
        (uint256 agentId, address proxy, address treasury) =
            factory.createEntity(manager, guardian, operator, 2 days, "ipfs://meta", "EIN-1", 1748476800, keccak256("oa"), cfg);

        assertEq(factory.treasuryByAgentId(agentId), treasury);
        AgentTreasury t = AgentTreasury(treasury);
        assertEq(t.manager(), manager);
        assertEq(t.guardian(), guardian);
        assertEq(t.operator(), operator);
        assertEq(t.legalManager(), proxy);
        assertEq(address(t.usdc()), address(usdc));
        assertEq(t.cap(), 500e6);
        assertEq(t.policyDelay(), 2 days); // reuses amendmentDelay
    }

    function test_emitsTreasuryCreated() public {
        LegalManagerFactory.TreasuryConfig memory cfg = LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc),
            payoutAddress: payout,
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
        vm.recordLogs();
        (uint256 agentId, , address treasury) =
            factory.createEntity(manager, guardian, operator, 2 days, "ipfs://meta", "EIN-1", 1748476800, keccak256("oa"), cfg);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("TreasuryCreated(uint256,address,address)")) {
                found = true;
                assertEq(uint256(logs[i].topics[1]), agentId);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), treasury);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), operator);
            }
        }
        assertTrue(found);
    }
}

/// @dev A deliberately misbehaving registry that always returns the SAME agentId. The canonical
///      ERC-8004 registry is monotonic (_lastId++) and cannot do this, but an upgraded/buggy
///      registry could — this exercises the factory's collision guard (audit finding 4).
contract ConstantIdRegistry is IIdentityRegistry {
    mapping(uint256 => address) internal _owners;

    function register(string calldata) external pure returns (uint256) { return 0; }
    function transferFrom(address, address to, uint256 tokenId) external { _owners[tokenId] = to; }
    function ownerOf(uint256 tokenId) external view returns (address) { return _owners[tokenId]; }
    function setMetadata(uint256, string calldata, bytes calldata) external {}
    function getMetadata(uint256, string calldata) external pure returns (bytes memory) { return ""; }
    function setAgentWallet(uint256, address, uint256, bytes calldata) external {}
    function getAgentWallet(uint256) external pure returns (address) { return address(0); }
}

contract FactoryAgentIdCollisionTest is Test {
    LegalManagerFactory internal factory;

    function setUp() public {
        ConstantIdRegistry registry = new ConstantIdRegistry();
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), address(registry), makeAddr("beaconOwner"));
    }

    function _cfg() internal returns (LegalManagerFactory.TreasuryConfig memory) {
        MockUSDC u = new MockUSDC();
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(u), payoutAddress: makeAddr("payout"), cap: 500e6, period: 1 days, allowlistEnabled: false
        });
    }

    function test_duplicateAgentIdFromRegistryReverts() public {
        factory.createEntity(makeAddr("m1"), makeAddr("g1"), makeAddr("o1"), 2 days, "a", "E1", 1, keccak256("a"), _cfg());
        assertEq(factory.entityByAgentId(0), factory.entities(0)); // entity #0 recorded under id 0

        // Pre-compute args so vm.expectRevert binds to createEntity itself (not the _cfg() deploy).
        LegalManagerFactory.TreasuryConfig memory cfg = _cfg();
        address m2 = makeAddr("m2");
        address g2 = makeAddr("g2");
        address o2 = makeAddr("o2");
        // The registry hands back id 0 again; the guard must reject rather than orphan entity #1.
        vm.expectRevert(abi.encodeWithSelector(LegalManagerFactory.AgentIdAlreadyUsed.selector, uint256(0)));
        factory.createEntity(m2, g2, o2, 2 days, "b", "E2", 2, keccak256("b"), cfg);
        assertEq(factory.entitiesCount(), 1); // second creation fully rolled back
    }
}
