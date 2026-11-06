// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity 0.8.30;

import {CreditSale} from "../src/CreditSale.sol";
import {RootRegistry} from "../src/RootRegistry.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {TestBase} from "./Vm.sol";

contract DeployTest is TestBase {
    function test_deploy_reads_environment() public {
        vm.setEnv("ISSUER_ADDRESS", "0x0000000000000000000000000000000000001551");
        vm.setEnv("BATCH_PRICE_WEI", "100000000000000");
        vm.setEnv("EPOCH_SECONDS", "30");
        (CreditSale sale, RootRegistry registry) = new Deploy().run();
        assertEq(sale.issuer(), address(0x1551), "sale issuer");
        assertEq(sale.batchPriceWei(), 100000000000000, "price");
        assertEq(registry.issuer(), address(0x1551), "registry issuer");
        assertEq(registry.epochSeconds(), 30, "epoch seconds");
    }
}
