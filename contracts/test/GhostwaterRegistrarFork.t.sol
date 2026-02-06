// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {GhostwaterRegistrar} from "../src/GhostwaterRegistrar.sol";
import {IL2Registry} from "../src/interfaces/IL2Registry.sol";

/// @title GhostwaterRegistrar fork tests
/// @notice Run on Base mainnet fork to debug register/setPreferences against real registry.
/// @dev Requires in contracts/.env: BASE_RPC_URL, GHOSTWATER_REGISTRAR_ADDRESS (and GHOSTWATER_L2_REGISTRY_ADDRESS for reference).
///      Run: cd contracts && forge test --match-contract GhostwaterRegistrarFork -vvv
contract GhostwaterRegistrarForkTest is Test {
    GhostwaterRegistrar public registrar;
    IL2Registry public registry;

    address public user1;
    address public user2;
    uint256 public user1Key;
    uint256 public user2Key;

    function setUp() public {
        // Use fork from --fork-url if provided, else create from named "base" (reads BASE_RPC_URL from contracts/.env)
        if (vm.activeFork() == 0) {
            uint256 forkId = vm.createSelectFork("base");
            require(forkId != 0, "Fork failed. Use --fork-url <URL> or set BASE_RPC_URL in contracts/.env");
        }

        // Use deployed registrar only to get registry address; then deploy our (new) code and add it to registry
        address deployedRegistrarAddress = vm.envAddress("GHOSTWATER_REGISTRAR_ADDRESS");
        registry = IL2Registry(GhostwaterRegistrar(deployedRegistrarAddress).registry());
        require(address(registry) != address(0), "Registry not set on registrar");

        GhostwaterRegistrar newRegistrar = new GhostwaterRegistrar(address(registry));
        address registryOwner = registry.owner();
        vm.prank(registryOwner);
        registry.addRegistrar(address(newRegistrar));
        registrar = newRegistrar;

        user1Key = 0xA11CE;
        user2Key = 0xB0B;
        user1 = vm.addr(user1Key);
        user2 = vm.addr(user2Key);

        vm.deal(user1, 1 ether);
        vm.deal(user2, 1 ether);
    }

    /// @notice Revert: setPreferences without claiming first
    function testFork_setPreferences_revertsWhenNotClaimed() public {
        vm.prank(user1);
        vm.expectRevert(GhostwaterRegistrar.NotClaimed.selector);
        registrar.setPreferences("Base", "USDC", "");
    }

    /// @notice Revert: label too short
    function testFork_register_revertsWhenLabelTooShort() public {
        vm.prank(user1);
        vm.expectRevert(GhostwaterRegistrar.LabelTooShort.selector);
        registrar.register("ab");
    }

    /// @notice Full flow: register then setPreferences (use a unique label to avoid LabelUnavailable on mainnet)
    function testFork_register_then_setPreferences() public {
        // Use a label that's likely available (change if you hit LabelUnavailable)
        string memory label = "testfork999";

        vm.prank(user1);
        registrar.register(label);

        assertTrue(registrar.hasSubdomain(user1));
        assertEq(registrar.addressToLabel(user1), label);

        vm.prank(user1);
        registrar.setPreferences("Base", "USDC", "");

        // If we get here, setPreferences did not revert (registry.setText accepted).
        // Optionally read back via ITextResolver.text(node, key) if the registry implements it.
        bytes32 baseNode = registry.baseNode();
        bytes32 node = registry.makeNode(baseNode, label);
        (bool okChain, bytes memory chainBytes) = address(registry).staticcall(
            abi.encodeWithSignature("text(bytes32,string)", node, "com.ghostwater.preferredChain")
        );
        if (okChain && chainBytes.length > 0) {
            string memory chain = abi.decode(chainBytes, (string));
            assertEq(chain, "Base");
        }
        (bool okToken, bytes memory tokenBytes) = address(registry).staticcall(
            abi.encodeWithSignature("text(bytes32,string)", node, "com.ghostwater.preferredToken")
        );
        if (okToken && tokenBytes.length > 0) {
            string memory token = abi.decode(tokenBytes, (string));
            assertEq(token, "USDC");
        }
    }

    /// @notice Revert: second register from same address
    function testFork_register_revertsWhenAlreadyClaimed() public {
        string memory label = "testfork998";
        vm.prank(user1);
        registrar.register(label);

        vm.prank(user1);
        vm.expectRevert(GhostwaterRegistrar.AlreadyClaimed.selector);
        registrar.register("other");
    }

    /// @notice Revert: different user tries to register same label (LabelUnavailable after first claim)
    function testFork_register_revertsWhenLabelUnavailable() public {
        string memory label = "testfork997";
        vm.prank(user1);
        registrar.register(label);

        vm.prank(user2);
        vm.expectRevert(GhostwaterRegistrar.LabelUnavailable.selector);
        registrar.register(label);
    }

    /// @notice Check registrar is allowed to create subnodes on the registry
    function testFork_registrarIsAllowedOnRegistry() public view {
        require(
            registry.registrars(address(registrar)),
            "Registrar not in registry.registrars() - add it via registry.addRegistrar(registrar) as registry owner"
        );
    }

    // --- registerWithPreferences (name + chain/token in one tx) ---

    /// @notice One tx: register name and set preferences
    function testFork_registerWithPreferences_oneTx() public {
        string memory label = "testfork996";
        vm.prank(user1);
        registrar.registerWithPreferences(label, "Arbitrum", "USDT", "");

        assertTrue(registrar.hasSubdomain(user1));
        assertEq(registrar.addressToLabel(user1), label);

        bytes32 baseNode = registry.baseNode();
        bytes32 node = registry.makeNode(baseNode, label);
        (bool okChain, bytes memory chainBytes) = address(registry).staticcall(
            abi.encodeWithSignature("text(bytes32,string)", node, "com.ghostwater.preferredChain")
        );
        assertTrue(okChain && chainBytes.length > 0);
        assertEq(abi.decode(chainBytes, (string)), "Arbitrum");
        (bool okToken, bytes memory tokenBytes) = address(registry).staticcall(
            abi.encodeWithSignature("text(bytes32,string)", node, "com.ghostwater.preferredToken")
        );
        assertTrue(okToken && tokenBytes.length > 0);
        assertEq(abi.decode(tokenBytes, (string)), "USDT");
    }

    /// @notice registerWithPreferences stores suiAddress text record when provided
    function testFork_registerWithPreferences_setsSuiAddress() public {
        string memory label = "testfork993";
        string memory suiAddr = "0x1234567890abcdef1234567890abcdef12345678";
        vm.prank(user1);
        registrar.registerWithPreferences(label, "Sui", "USDC", suiAddr);

        bytes32 baseNode = registry.baseNode();
        bytes32 node = registry.makeNode(baseNode, label);
        (bool okSui, bytes memory suiBytes) = address(registry).staticcall(
            abi.encodeWithSignature("text(bytes32,string)", node, "com.ghostwater.suiAddress")
        );
        assertTrue(okSui && suiBytes.length > 0);
        assertEq(abi.decode(suiBytes, (string)), suiAddr);
    }

    /// @notice registerWithPreferences reverts when label too short
    function testFork_registerWithPreferences_revertsWhenLabelTooShort() public {
        vm.prank(user1);
        vm.expectRevert(GhostwaterRegistrar.LabelTooShort.selector);
        registrar.registerWithPreferences("ab", "Base", "USDC", "");
    }

    /// @notice registerWithPreferences reverts when already claimed
    function testFork_registerWithPreferences_revertsWhenAlreadyClaimed() public {
        vm.prank(user1);
        registrar.registerWithPreferences("testfork995", "Base", "ETH", "");

        vm.prank(user1);
        vm.expectRevert(GhostwaterRegistrar.AlreadyClaimed.selector);
        registrar.registerWithPreferences("other", "Sui", "USDC", "");
    }

    /// @notice registerWithPreferences reverts when label taken
    function testFork_registerWithPreferences_revertsWhenLabelUnavailable() public {
        vm.prank(user1);
        registrar.registerWithPreferences("testfork994", "Base", "USDC", "");

        vm.prank(user2);
        vm.expectRevert(GhostwaterRegistrar.LabelUnavailable.selector);
        registrar.registerWithPreferences("testfork994", "Arbitrum", "USDT", "");
    }
}
