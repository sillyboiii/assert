// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CommitmentV2} from "../src/CommitmentV2.sol";

contract DeployV2 is Script {
    function run() external returns (CommitmentV2 commitment) {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        commitment = new CommitmentV2({
            feeBps_: 200,
            treasury_: vm.envAddress("TREASURY"),
            usdc_: vm.envAddress("USDC"),
            minEthStake_: 0.001 ether,
            maxEthStake_: 5 ether,
            minUsdcStake_: 1e6,
            maxUsdcStake_: 5_000e6
        });
        vm.stopBroadcast();

        console2.log("CommitmentV2 deployed at:", address(commitment));
    }
}
