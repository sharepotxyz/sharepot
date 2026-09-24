// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {SharePot} from "../src/SharePot.sol";
import {MockStock} from "../src/MockStock.sol";

/// Deploys SharePot with the config given by environment variables, mirroring the Solana devnet-setup defaults:
///   PROPOSER, TREASURY        addresses (required)
///   FEE_BPS                   default 500 (5 %)
///   EARLY_BIRD_DISCOUNT_BPS   default 200
///   EARLY_BIRD_SECS           default 7200
///   DISPUTE_WINDOW_SECS       default 3600
///   MIN_BET                   default 1e16 raw (0.01 share of an 18-decimal token)
///   MOCK_STOCKS               optional, comma-free list like "TSLA NVDA SPY": deploys a MockStock per symbol
///                             (for a testnet where the real tokens are faucet-rationed)
contract Deploy is Script {
    function run() external {
        SharePot.ConfigArgs memory a = SharePot.ConfigArgs({
            proposer: vm.envAddress("PROPOSER"),
            treasury: vm.envAddress("TREASURY"),
            feeBps: uint16(vm.envOr("FEE_BPS", uint256(500))),
            earlyBirdDiscountBps: uint16(vm.envOr("EARLY_BIRD_DISCOUNT_BPS", uint256(200))),
            earlyBirdSecs: uint64(vm.envOr("EARLY_BIRD_SECS", uint256(7200))),
            disputeWindowSecs: uint64(vm.envOr("DISPUTE_WINDOW_SECS", uint256(3600))),
            minBet: vm.envOr("MIN_BET", uint256(1e16))
        });
        vm.startBroadcast();
        SharePot pot = new SharePot(a);
        console.log("SharePot", address(pot));
        string memory mocks = vm.envOr("MOCK_STOCKS", string(""));
        if (bytes(mocks).length > 0) {
            string[] memory syms = vm.split(mocks, " ");
            for (uint256 i = 0; i < syms.length; i++) {
                MockStock t = new MockStock(string.concat(syms[i], " (SharePot testnet mock)"), syms[i], 18);
                console.log(syms[i], address(t));
            }
        }
        vm.stopBroadcast();
    }
}
