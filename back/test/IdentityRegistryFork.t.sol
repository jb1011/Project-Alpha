// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @dev EIP-5267 subset — the live registry exposes its EIP-712 domain on-chain, so the
///      re-bind tests can sign against the real domain instead of hardcoding it.
interface IERC5267 {
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

/// @notice Fork tests of the REAL canonical ERC-8004 IdentityRegistry on Arc testnet
///         (V2 roadmap Tier 1 #4). Every other suite runs against MockIdentityRegistry;
///         these pin the mock's fidelity claims (deadline cap, EIP-712 domain, the
///         wallet-binding lifecycle) to the live contract so CI catches real-registry drift.
/// @dev    Runs only when ARC_TESTNET_RPC_URL is set (CI sets the public RPC; tests
///         self-skip locally without it). Forks the LATEST block deliberately: a pinned
///         block would never see a registry proxy upgrade. Pure local simulation — no
///         transaction is broadcast, nothing is spent.
contract IdentityRegistryForkTest is Test {
    /// @dev The live proxy, same address the deployed factory is wired to
    ///      (src/interfaces/IIdentityRegistry.sol:6, .env.example IDENTITY_REGISTRY).
    address internal constant LIVE_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    /// @dev Solidity cannot initialize a constant from another contract's public constant under
    ///      this solc/via_ir config (tried; "Member ... not found" at compile time), so this
    ///      stays a literal duplicate of MockIdentityRegistry.AGENT_WALLET_SET_TYPEHASH.
    ///      test_liveDomainMatchesMockAssumptions asserts equality against the mock so mock
    ///      drift still fails here.
    bytes32 internal constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    /// @dev Same constraint as above: literal duplicate of MockIdentityRegistry.MAX_DEADLINE_DELAY;
    ///      the live value was verified 2026-06-16 and test_rebindDeadlineCapMatchesMock asserts
    ///      equality against the mock so mock drift fails here too.
    uint256 internal constant MAX_DEADLINE_DELAY = 5 minutes;

    IIdentityRegistry internal registry = IIdentityRegistry(LIVE_REGISTRY);
    LegalManagerFactory internal factory;
    bool internal forked;

    uint256 internal managerPk = 0xA11CE;
    address internal manager;
    address internal guardian = address(0x60A12D);
    address internal operator = address(0x0EEEA7);

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    /// @dev The project pins evm_version = "paris" (Arc PUSH0 deploy note), but the LIVE
    ///      registry's deployed bytecode uses PUSH0, so simulating it needs a shanghai+
    ///      interpreter (CI runs these in a dedicated FOUNDRY_EVM_VERSION=shanghai step).
    ///      Runtime probe: deploying initcode {PUSH0} succeeds only when PUSH0 is a valid
    ///      opcode; under paris the CREATE fails and every fork test self-skips.
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
            // Tripwire for the dedicated CI step: skipping is fine locally, but the step whose
            // whole purpose is drift detection must never go green having run nothing. CI sets
            // FORK_TESTS_REQUIRED=1; if either env line is later dropped, this fails loudly.
            require(!vm.envOr("FORK_TESTS_REQUIRED", false), "fork tests required but would skip");
            return; // every test self-skips via onlyFork
        }
        vm.createSelectFork(url);
        forked = true;
        manager = vm.addr(managerPk);
        LegalManager impl = new LegalManager();
        factory = new LegalManagerFactory(address(impl), LIVE_REGISTRY, makeAddr("beaconOwner"));
    }

    function _defaultTreasuryCfg() internal returns (LegalManagerFactory.TreasuryConfig memory) {
        // The treasury's token is incidental to the registry paths under test; a mock
        // USDC deployed onto the fork keeps the real Arc USDC out of the loop.
        MockUSDC usdc = new MockUSDC();
        return LegalManagerFactory.TreasuryConfig({
            usdc: address(usdc),
            payoutAddress: makeAddr("payout"),
            cap: 500e6,
            period: 1 days,
            allowlistEnabled: false
        });
    }

    function _createEntity() internal returns (uint256 agentId, address proxy, address treasury) {
        (agentId, proxy, treasury) = factory.createEntity(
            manager, guardian, operator, 2 days, "ipfs://fork-test", "EIN-FORK", 1, keccak256("oa"), _defaultTreasuryCfg()
        );
    }

    // ---------------------------------------------------------------- register path

    /// @notice The full register path against the live registry: _safeMint to the factory
    ///         (IERC721Receiver), monotonic agentId, registry writes, NFT hand-off to the
    ///         manager, and the proxy initialized with the live-minted id.
    function test_createEntityRegistersOnLiveRegistry() public onlyFork {
        (uint256 agentId, address proxy, address treasury) = _createEntity();

        assertEq(registry.ownerOf(agentId), manager);
        assertEq(factory.entityByAgentId(agentId), proxy);
        assertEq(factory.treasuryByAgentId(agentId), treasury);
        assertEq(factory.entitiesCount(), 1);
        (,,, uint256 storedId) = LegalManager(payable(proxy)).meta();
        assertEq(storedId, agentId);
    }

    /// @notice DRIFT FINDING (verified by execution 2026-07-13): the live registry DOES
    ///         auto-bind register()'s caller as the agentWallet (matching
    ///         MockIdentityRegistry.sol:33-38), but it CLEARS the binding on ERC-721 transfer,
    ///         so after createEntity's NFT hand-off to the manager both getAgentWallet and the
    ///         "agentWallet" metadata are empty until an explicit setAgentWallet. The mock does
    ///         not clear on transfer, so post-createEntity it reports the factory where live
    ///         reports zero. Harmless to production (the backend always re-binds explicitly),
    ///         but nothing may rely on a post-transfer binding; this test pins the live behavior.
    function test_createEntityLeavesAgentWalletUnboundOnLive() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        assertEq(registry.getAgentWallet(agentId), address(0));
        assertEq(registry.getMetadata(agentId, "agentWallet").length, 0);
    }

    /// @notice Two entities from one factory get distinct live agentIds and distinct records
    ///         (the AgentIdAlreadyUsed guard's "cannot happen" premise: live ids are monotonic).
    function test_secondEntityGetsDistinctLiveAgentId() public onlyFork {
        (uint256 firstId, address firstProxy,) = _createEntity();
        (uint256 secondId, address secondProxy,) = _createEntity();

        assertTrue(secondId != firstId);
        assertEq(factory.entityByAgentId(firstId), firstProxy);
        assertEq(factory.entityByAgentId(secondId), secondProxy);
        assertEq(factory.entitiesCount(), 2);
    }

    /// @notice Pins the live EIP-712 domain + ERC-721 name the mock claims to mirror
    ///         (MockIdentityRegistry.sol:29-31). If the registry proxy is upgraded and any
    ///         of these drift, this fails before the drift reaches production signing code.
    function test_liveDomainMatchesMockAssumptions() public onlyFork {
        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID);
        // MockIdentityRegistry.AGENT_WALLET_SET_TYPEHASH isn't reachable as a bare type-level
        // member here (it inherits ERC721/EIP712, so solc requires an instance for the public
        // constant's getter); a throwaway local instance still pins mock drift at this literal.
        MockIdentityRegistry mockForConstants = new MockIdentityRegistry();
        assertEq(AGENT_WALLET_SET_TYPEHASH, mockForConstants.AGENT_WALLET_SET_TYPEHASH());

        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IERC5267(LIVE_REGISTRY).eip712Domain();
        assertEq(uint8(fields), 0x0f); // name + version + chainId + verifyingContract
        assertEq(name, "ERC8004IdentityRegistry");
        assertEq(version, "1");
        assertEq(chainId, ARC_TESTNET_CHAIN_ID);
        assertEq(verifying, LIVE_REGISTRY);

        // ERC-721 name is deliberately different from the EIP-712 domain name.
        assertEq(IERC721Metadata(LIVE_REGISTRY).name(), "AgentIdentity");
    }

    // ---------------------------------------------------------------- re-bind path

    /// @dev Signs AgentWalletSet over the registry's LIVE EIP-712 domain (read on-chain via
    ///      eip712Domain(), not hardcoded) with the key of the wallet being bound.
    function _signWalletSet(uint256 walletPk, uint256 agentId, address newWallet, address owner_, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IERC5267(LIVE_REGISTRY).eip712Domain();
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

    /// @notice The canonical re-bind: the manager (NFT owner) binds a new wallet with that
    ///         wallet's EIP-712 signature — the step the factory deliberately does NOT do
    ///         on-chain (LegalManagerFactory.sol:17-20), here against the live verifier.
    function test_managerRebindsWalletOnLiveRegistry() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;

        bytes memory sig = _signWalletSet(walletPk, agentId, wallet, manager, deadline);
        vm.prank(manager);
        registry.setAgentWallet(agentId, wallet, deadline, sig);

        assertEq(registry.getAgentWallet(agentId), wallet);
    }

    /// @notice Binding is repeatable: a second re-bind to a different wallet overwrites the first.
    function test_rebindSecondTimeOverwritesFirst() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;

        bytes memory sig1 = _signWalletSet(0xBEEF, agentId, vm.addr(0xBEEF), manager, deadline);
        vm.prank(manager);
        registry.setAgentWallet(agentId, vm.addr(0xBEEF), deadline, sig1);
        bytes memory sig2 = _signWalletSet(0xCAFE, agentId, vm.addr(0xCAFE), manager, deadline);
        vm.prank(manager);
        registry.setAgentWallet(agentId, vm.addr(0xCAFE), deadline, sig2);

        assertEq(registry.getAgentWallet(agentId), vm.addr(0xCAFE));
    }

    /// @notice Pins the live 5-minute deadline cap the mock encodes (verified live 2026-06-16,
    ///         MockIdentityRegistry.sol:20-22): one second past the cap reverts with the exact
    ///         live string; exactly at the cap succeeds. The production signer relies on this
    ///         bound (registry caps at 300s — see the coverage-audit TODO).
    function test_rebindDeadlineCapMatchesMock() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 cap = block.timestamp + MAX_DEADLINE_DELAY;

        // Same reachability constraint as test_liveDomainMatchesMockAssumptions: pin via a
        // throwaway instance rather than a bare type-level member.
        MockIdentityRegistry mockForConstants = new MockIdentityRegistry();
        assertEq(MAX_DEADLINE_DELAY, mockForConstants.MAX_DEADLINE_DELAY());

        bytes memory sigPastCap = _signWalletSet(walletPk, agentId, wallet, manager, cap + 1);
        vm.prank(manager);
        vm.expectRevert(bytes("deadline too far"));
        registry.setAgentWallet(agentId, wallet, cap + 1, sigPastCap);

        bytes memory sigAtCap = _signWalletSet(walletPk, agentId, wallet, manager, cap);
        vm.prank(manager);
        registry.setAgentWallet(agentId, wallet, cap, sigAtCap);
        assertEq(registry.getAgentWallet(agentId), wallet);
    }

    /// @notice A caller who is not the NFT owner (nor approved) cannot re-bind, even with a
    ///         valid wallet signature. Bare expectRevert: the exact live revert string for
    ///         this case was never verified, and the property is the rejection itself.
    function test_rebindRevertsForNonOwnerCaller() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        uint256 walletPk = 0xBEEF;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;
        bytes memory sig = _signWalletSet(walletPk, agentId, wallet, manager, deadline);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        registry.setAgentWallet(agentId, wallet, deadline, sig);
        // Still unbound: live clears agentWallet on createEntity's NFT hand-off (see the
        // drift finding at test_createEntityLeavesAgentWalletUnboundOnLive).
        assertEq(registry.getAgentWallet(agentId), address(0));
    }

    /// @notice A signature from a key other than the wallet being bound is rejected (ECDSA
    ///         recovers a different address; the EOA has no ERC-1271 fallback). Bare
    ///         expectRevert for the same reason as above.
    function test_rebindRevertsForWrongSigner() public onlyFork {
        (uint256 agentId,,) = _createEntity();
        address wallet = vm.addr(0xBEEF);
        uint256 deadline = block.timestamp + MAX_DEADLINE_DELAY;
        bytes memory sigFromWrongKey = _signWalletSet(0xD00D, agentId, wallet, manager, deadline);

        vm.prank(manager);
        vm.expectRevert();
        registry.setAgentWallet(agentId, wallet, deadline, sigFromWrongKey);
        assertEq(registry.getAgentWallet(agentId), address(0)); // still unbound, same as above
    }
}
