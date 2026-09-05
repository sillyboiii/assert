// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Commitment} from "../src/Commitment.sol";

contract Deploy is Script {
    function run() external returns (Commitment commitment) {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        commitment = new Commitment({
            feeBps_: 200,
            treasury_: vm.envAddress("TREASURY"),
            minStake_: 0.001 ether,
            maxStake_: 5 ether
        });
        vm.stopBroadcast();

        console2.log("Commitment deployed at:", address(commitment));
    }
}