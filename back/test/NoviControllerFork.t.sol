// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NoviController} from "../src/NoviController.sol";
import {BreakGlassOneShot} from "../src/BreakGlassOneShot.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {AgentTreasury} from "../src/AgentTreasury.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @dev EIP-5267 subset — the live registry exposes its EIP-712 domain on-chain, so the bind
///      test signs against the real domain instead of hardcoding it.
interface IERC5267Fork {
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
}

/// @notice DEPLOY GATE for the NoviController migration (design §6/§7): proves against LIVE Arc
///         testnet state that a contract manager can do the two registry things every onboarding
///         needs — `setAgentWallet` (the ERC-1271-adjacent bind) and `setMetadata` (the ENS
///         reverse-bind) — when the call arrives THROUGH the relay, with the controller as the
///         identity NFT's owner.
/// @dev    The known-unknown this closes: the live `AgentWalletSet` EIP-712 struct carries an
///         `owner` field, and production signs it from `rec.manager`. Once the manager is the
///         controller, that signature must be produced over **owner = CONTROLLER** or the live
///         verifier rejects it. `test_relayedBindRejectsSignatureOverWrongOwner` pins that.
///
///         Runs only when ARC_TESTNET_RPC_URL is set AND the interpreter supports PUSH0 (the live
///         registry's deployed bytecode uses it; the project pins evm_version = paris for Arc
///         deploys). Same self-skip + FORK_TESTS_REQUIRED tripwire as IdentityRegistryFork.t.sol.
///         Pure local simulation — nothing is broadcast, nothing is spent.
contract NoviControllerForkTest is Test {
    address internal constant LIVE_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    /// @dev Literal duplicate of MockIdentityRegistry.AGENT_WALLET_SET_TYPEHASH for the same
    ///      solc/via_ir reason documented in IdentityRegistryFork.t.sol:44.
    bytes32 internal constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    uint256 internal constant MAX_DEADLINE_DELAY = 5 minutes;
    uint48 internal constant ADMIN_DELAY = 24 hours;

    IIdentityRegistry internal registry = IIdentityRegistry(LIVE_REGISTRY);
    NoviController internal controller;
    LegalManagerFactory internal factory;
    bool internal forked;

    address internal admin = makeAddr("noviAdmin");
    address internal executor = makeAddr("noviExecutor");
    address internal guardian = makeAddr("agentGuardian");
    address internal operator = makeAddr("agentOperator");
    address internal payout = makeAddr("agentPayout");

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    /// @dev See IdentityRegistryFork.t.sol:68-80 — runtime PUSH0 probe.
    function _supportsPush0() internal returns (bool ok) {
        bytes memory initcode = hex"5f";
        address probe;
        assembly {
            probe := create(0, add(initcode, 0x20), mload(initcode))
        }
        ok = probe != address(0);
    }

    function _grantedSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = AgentTreasury.schedulePolicyUpdate.selector;
        s[1] = AgentTreasury.executePolicyUpdate.selector;
        s[2] = LegalManager.scheduleOperatingAgreementUpdate.selector;
        s[3] = LegalManager.executeOperatingAgreementUpdate.selector;
        s[4] = LegalManagerFactory.createEntity.selector;
        s[5] = IIdentityRegistry.setAgentWallet.selector;
        s[6] = IIdentityRegistry.setMetadata.selector;
    }

    function setUp() public {
        string memory url = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(url).length == 0 || !_supportsPush0()) {
            require(!vm.envOr("FORK_TESTS_REQUIRED", false), "fork tests required but would skip");
            return; // every test self-skips via onlyFork
        }
        vm.createSelectFork(url);
        forked = true;

        // Deploy sequence of script/DeployController.s.sol, rehearsed against live state.
        controller = new NoviController(ADMIN_DELAY, admin, executor, _grantedSelectors());
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), LIVE_REGISTRY, address(controller));
        factory.transferOwnership(address(controller));
        _breakGlass(address(factory), abi.encodeCall(Ownable2Step.acceptOwnership, ()));

        // M5: pin the two registry selectors to the live registry address.
        vm.startPrank(admin);
        controller.setBoundTarget(IIdentityRegistry.setAgentWallet.selector, LIVE_REGISTRY);
        controller.setBoundTarget(IIdentityRegistry.setMetadata.selector, LIVE_REGISTRY);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _sel(bytes memory data) internal pure returns (bytes4 s) {
        assembly {
            s := mload(add(data, 0x20))
        }
    }

    /// @dev The design's ceremony: grant to a single-use helper, which acts and self-revokes.
    function _breakGlass(address target, bytes memory data) internal returns (bytes memory) {
        BreakGlassOneShot helper = new BreakGlassOneShot(controller, target, data);
        bytes32 role = bytes32(_sel(data));
        vm.prank(admin);
        controller.grantRole(role, address(helper));
        bytes memory ret = helper.execute();
        assertFalse(controller.hasRole(role, address(helper)), "grant outlived the ceremony");
        return ret;
    }

    function _relay(address caller, address target, bytes memory inner) internal returns (bool ok, bytes memory ret) {
        vm.prank(caller);
        (ok, ret) = address(controller).call(abi.encodePacked(inner, target));
    }

    function _relayOk(address caller, address target, bytes memory inner) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = _relay(caller, target, inner);
        assertTrue(ok, "relay reverted against live state");
        return ret;
    }

    function _createAgentThroughRelay() internal returns (uint256 agentId, address proxy, address treasury) {
        MockUSDC usdc = new MockUSDC(); // the treasury's token is incidental to the registry paths
        LegalManagerFactory.TreasuryConfig memory cfg = LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc), payoutAddress: payout, cap: 500e6, period: 1 days, allowlistEnabled: false
        });
        bytes memory data = abi.encodeCall(
            LegalManagerFactory.createEntity,
            (
                address(controller),
                guardian,
                operator,
                2 days,
                "ipfs://novi-controller-fork",
                "EIN-FORK",
                1,
                keccak256("oa"),
                cfg
            )
        );
        bytes memory ret = _relayOk(executor, address(factory), data);
        (agentId, proxy, treasury) = abi.decode(ret, (uint256, address, address));
    }

    /// @dev Signs AgentWalletSet over the registry's LIVE EIP-712 domain (read on-chain).
    function _signWalletSet(uint256 walletPk, uint256 agentId, address newWallet, address owner_, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IERC5267Fork(LIVE_REGISTRY).eip712Domain();
        require(fields == bytes1(0x0f), "unexpected EIP-712 domain shape");
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        bytes32 structHash = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner_, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── the migration, rehearsed on live state ───────────────────────────

    function test_forkPreconditions() public onlyFork {
        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID);
        assertEq(factory.owner(), address(controller));
        assertEq(factory.beacon().owner(), address(controller));
        assertTrue(LIVE_REGISTRY.code.length > 0);
    }

    /// @notice DEPLOY GATE 0: an agent is registered on the LIVE ERC-8004 registry by a factory
    ///         the controller owns, driven entirely through the relay, and the identity NFT ends
    ///         up in the controller's custody.
    function test_createEntityThroughRelayOnLiveRegistry() public onlyFork {
        (uint256 agentId, address proxy, address treasury) = _createAgentThroughRelay();

        assertEq(registry.ownerOf(agentId), address(controller));
        assertEq(factory.entityByAgentId(agentId), proxy);
        assertEq(factory.treasuryByAgentId(agentId), treasury);
        assertEq(LegalManager(payable(proxy)).manager(), address(controller));
        assertEq(AgentTreasury(treasury).manager(), address(controller));
    }

    /// @notice DEPLOY GATE 1: `setAgentWallet` relayed by the controller-as-NFT-owner against the
    ///         live verifier, with the EIP-712 signature produced over owner = CONTROLLER.
    ///         If this fails, the cutover breaks every wallet bind — do not deploy.
    function test_relayedSetAgentWalletBindsOnLiveRegistry() public onlyFork {
        (uint256 agentId,,) = _createAgentThroughRelay();
        // Live clears the binding on the factory's NFT hand-off (IdentityRegistryFork.t.sol:133).
        assertEq(registry.getAgentWallet(agentId), address(0));

        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;
        bytes memory sig = _signWalletSet(walletPk, agentId, wallet, address(controller), deadline);

        _relayOk(
            executor, LIVE_REGISTRY, abi.encodeCall(IIdentityRegistry.setAgentWallet, (agentId, wallet, deadline, sig))
        );

        assertEq(registry.getAgentWallet(agentId), wallet);
        assertEq(registry.ownerOf(agentId), address(controller)); // custody unchanged by the bind
    }

    /// @notice The corollary that makes the backend change load-bearing: a signature produced over
    ///         the OLD owner (the executor/manager EOA) is rejected by the live verifier once the
    ///         controller owns the identity. This is walletSet.ts's standing caveat, confirmed.
    function test_relayedBindRejectsSignatureOverWrongOwner() public onlyFork {
        (uint256 agentId,,) = _createAgentThroughRelay();
        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;
        bytes memory wrongSig = _signWalletSet(walletPk, agentId, wallet, executor, deadline);

        (bool ok,) = _relay(
            executor,
            LIVE_REGISTRY,
            abi.encodeCall(IIdentityRegistry.setAgentWallet, (agentId, wallet, deadline, wrongSig))
        );
        assertFalse(ok, "live registry accepted a signature over the wrong owner");
        assertEq(registry.getAgentWallet(agentId), address(0));
    }

    /// @notice DEPLOY GATE 2: `setMetadata` relayed as the owner — the ENS reverse-bind performed
    ///         in EVERY onboarding (arcAdapter.ts:201). Omitting this selector, or having the
    ///         live registry refuse a contract owner, breaks onboarding at cutover.
    function test_relayedSetMetadataOnLiveRegistry() public onlyFork {
        (uint256 agentId,,) = _createAgentThroughRelay();
        bytes memory value = bytes("novi-fork-test.novicorpus.eth");

        _relayOk(executor, LIVE_REGISTRY, abi.encodeCall(IIdentityRegistry.setMetadata, (agentId, "ensName", value)));

        assertEq(registry.getMetadata(agentId, "ensName"), value);
    }

    /// @notice M5 against the real registry: the bound selector refuses any other target, so a
    ///         future registry-ABI collision cannot be aimed somewhere else.
    function test_boundRegistrySelectorRejectsOtherTargetsOnFork() public onlyFork {
        (uint256 agentId,,) = _createAgentThroughRelay();
        (bool ok, bytes memory ret) = _relay(
            executor,
            address(factory), // a contract, but not the bound registry
            abi.encodeCall(IIdentityRegistry.setMetadata, (agentId, "ensName", bytes("x")))
        );
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                NoviController.TargetNotBound.selector, IIdentityRegistry.setMetadata.selector, address(factory)
            )
        );
    }

    /// @notice Identity moves stay admin-only on live state too: the executor cannot transfer the
    ///         NFT out (which would also clear the wallet binding — see the drift finding in
    ///         IdentityRegistryFork.t.sol:133).
    function test_executorCannotTransferIdentityOnFork() public onlyFork {
        (uint256 agentId,,) = _createAgentThroughRelay();
        (bool ok,) = _relay(
            executor,
            LIVE_REGISTRY,
            abi.encodeCall(IIdentityRegistry.transferFrom, (address(controller), executor, agentId))
        );
        assertFalse(ok);
        assertEq(registry.ownerOf(agentId), address(controller));
    }
}
