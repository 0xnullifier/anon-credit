// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity 0.8.30;

import {CreditSale} from "../src/CreditSale.sol";
import {RootRegistry} from "../src/RootRegistry.sol";
import {Vm} from "../test/Vm.sol";

/// @notice Deploy CreditSale and RootRegistry.
/// Environment:
/// - ISSUER_ADDRESS (required): the issuer. It withdraws revenue and publishes roots.
/// - BATCH_PRICE_WEI (required): the price of one batch. Testnet: 100000000000000.
/// - EPOCH_SECONDS (optional, default 30): the epoch length. Production: 900.
/// The broadcaster is the key given with `--private-key`. It does not have to be the issuer.
contract Deploy {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (CreditSale sale, RootRegistry registry) {
        address issuer = vm.envAddress("ISSUER_ADDRESS");
        uint256 batchPriceWei = vm.envUint("BATCH_PRICE_WEI");
        uint256 epochSeconds = vm.envOr("EPOCH_SECONDS", uint256(30));
        require(epochSeconds > 0 && epochSeconds <= type(uint64).max, "EPOCH_SECONDS out of range");
        vm.startBroadcast();
        sale = new CreditSale(issuer, batchPriceWei);
        registry = new RootRegistry(issuer, uint64(epochSeconds));
        vm.stopBroadcast();
    }
}
