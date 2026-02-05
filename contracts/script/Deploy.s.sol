// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {GhostwaterRegistrar} from "../src/GhostwaterRegistrar.sol";

/// @notice Deploy GhostwaterRegistrar to Base (or Base Sepolia). Then call registry.addRegistrar(registrar) as registry owner.
contract Deploy is Script {
    function run() external {
        address registry = vm.envAddress("L2_REGISTRY_ADDRESS");

        vm.startBroadcast();
        GhostwaterRegistrar registrar = new GhostwaterRegistrar(registry);
        vm.stopBroadcast();

        console.log("GhostwaterRegistrar deployed at:", address(registrar));
        console.log("Next: as L2 Registry owner, call addRegistrar(%s)", address(registrar));
    }
}
