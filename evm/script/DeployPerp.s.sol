// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {SharePotPerp} from "../src/SharePotPerp.sol";
import {MockStock} from "../src/MockStock.sol";

/// Deploys the SharePot Perp pool on one stock token. Environment:
///   OPERATOR, TREASURY        addresses (required); the broadcasting key becomes the admin unless ADMIN is set
///   GUARDIAN                  the independent checker's reject-only key (default: none)
///   TOKEN                     the stock token; if unset a MockStock is deployed (testnet: anyone may mint it,
///                             MOCK_MINT_CAP tokens a call at most, default 10000, so it cannot fill MAX_POOL)
///   MOCK_SYMBOL, MOCK_DECIMALS default "NVDAc", 8 (Coinbase's NVDAc on Base has 8 decimals)
///   FEE_BPS                   default 10 (0.1 % on entry and on exit)
///   FUNDING_BPS               default 10 (0.1 % a day at full imbalance)
///   DISPUTE_WINDOW_SECS       default 21600 (6 h)
///   TIER_CS, TIER_LONGS       default "1 1 2 3" and "1 0 0 0": long 2x, hedge, short 1x, short 2x (the Base launch)
///   HEDGE_TIER                default 1
contract DeployPerp is Script {
    function run() external {
        address operator = vm.envAddress("OPERATOR");
        address treasury = vm.envAddress("TREASURY");
        string[] memory cs = vm.split(vm.envOr("TIER_CS", string("1 1 2 3")), " ");
        string[] memory ls = vm.split(vm.envOr("TIER_LONGS", string("1 0 0 0")), " ");
        require(cs.length == ls.length, "TIER_CS and TIER_LONGS differ in length");
        uint8[] memory c = new uint8[](cs.length);
        bool[] memory longs = new bool[](cs.length);
        for (uint256 i = 0; i < cs.length; i++) {
            c[i] = uint8(vm.parseUint(cs[i]));
            longs[i] = vm.parseUint(ls[i]) == 1;
        }

        vm.startBroadcast();
        address token = vm.envOr("TOKEN", address(0));
        if (token == address(0)) {
            string memory sym = vm.envOr("MOCK_SYMBOL", string("NVDAc"));
            uint8 dec = uint8(vm.envOr("MOCK_DECIMALS", uint256(8)));
            MockStock mock = new MockStock(string.concat(sym, " (SharePot testnet mock)"), sym, dec);
            mock.setMintCap(vm.envOr("MOCK_MINT_CAP", uint256(10_000)) * 10 ** dec);
            token = address(mock);
            console.log("MockStock", sym, token);
        }
        address admin = vm.envOr("ADMIN", msg.sender);
        SharePotPerp perp = new SharePotPerp(
            token,
            admin,
            operator,
            vm.envOr("GUARDIAN", address(0)),
            treasury,
            uint16(vm.envOr("FEE_BPS", uint256(10))),
            uint16(vm.envOr("FUNDING_BPS", uint256(10))),
            uint64(vm.envOr("DISPUTE_WINDOW_SECS", uint256(21_600))),
            c,
            longs,
            uint8(vm.envOr("HEDGE_TIER", uint256(1)))
        );
        console.log("SharePotPerp", address(perp));
        vm.stopBroadcast();
    }
}
