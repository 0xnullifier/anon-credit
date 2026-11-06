// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity 0.8.30;

import {CreditSale} from "../src/CreditSale.sol";
import {TestBase} from "./Vm.sol";

/// @notice A receiver that rejects ETH. It makes the withdrawal transfer fail.
contract RejectingReceiver {
    receive() external payable {
        revert("no");
    }
}

contract CreditSaleTest is TestBase {
    event Purchased(address indexed payer, uint256 indexed purchaseId, bytes32[] commitments, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    uint256 internal constant PRICE = 100000000000000;
    address internal constant ISSUER = address(0x1551);
    address internal constant BUYER = address(0xB0B);
    address internal constant OTHER = address(0x0BAD);

    CreditSale internal sale;

    function setUp() public {
        sale = new CreditSale(ISSUER, PRICE);
        vm.deal(BUYER, 1000 ether);
    }

    function commitments(uint256 count) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            list[i] = bytes32(i + 1);
        }
    }

    function test_constructor_sets_immutables() public view {
        assertEq(sale.issuer(), ISSUER, "issuer");
        assertEq(sale.batchPriceWei(), PRICE, "price");
        assertEq(sale.nextPurchaseId(), 0, "first purchase id");
        assertEq(sale.MAX_BATCHES_PER_PURCHASE(), 100, "max batches");
    }

    function test_constructor_rejects_zero_issuer() public {
        vm.expectRevert(abi.encodeWithSelector(CreditSale.ZeroAddress.selector));
        new CreditSale(address(0), PRICE);
    }

    function test_constructor_rejects_zero_price() public {
        vm.expectRevert(abi.encodeWithSelector(CreditSale.ZeroPrice.selector));
        new CreditSale(ISSUER, 0);
    }

    function test_buy_emits_purchased_and_keeps_funds() public {
        bytes32[] memory list = commitments(3);
        vm.expectEmit(true, true, true, true, address(sale));
        emit Purchased(BUYER, 0, list, 3 * PRICE);
        vm.prank(BUYER);
        uint256 id = sale.buy{value: 3 * PRICE}(list);
        assertEq(id, 0, "purchase id");
        assertEq(sale.nextPurchaseId(), 1, "next purchase id");
        assertEq(address(sale).balance, 3 * PRICE, "balance");
    }

    function test_buy_increments_purchase_id() public {
        vm.prank(BUYER);
        sale.buy{value: PRICE}(commitments(1));
        bytes32[] memory list = commitments(2);
        vm.expectEmit(true, true, true, true, address(sale));
        emit Purchased(BUYER, 1, list, 2 * PRICE);
        vm.prank(BUYER);
        uint256 id = sale.buy{value: 2 * PRICE}(list);
        assertEq(id, 1, "second purchase id");
    }

    function test_buy_accepts_max_batches() public {
        vm.prank(BUYER);
        sale.buy{value: 100 * PRICE}(commitments(100));
        assertEq(address(sale).balance, 100 * PRICE, "balance");
    }

    function test_buy_accepts_largest_field_element() public {
        bytes32[] memory list = new bytes32[](1);
        list[0] = bytes32(sale.FIELD_MODULUS() - 1);
        vm.prank(BUYER);
        sale.buy{value: PRICE}(list);
    }

    function test_buy_rejects_empty_purchase() public {
        vm.expectRevert(abi.encodeWithSelector(CreditSale.EmptyPurchase.selector));
        vm.prank(BUYER);
        sale.buy{value: 0}(new bytes32[](0));
    }

    function test_buy_rejects_too_many_batches() public {
        vm.expectRevert(abi.encodeWithSelector(CreditSale.TooManyBatches.selector, 101));
        vm.prank(BUYER);
        sale.buy{value: 101 * PRICE}(commitments(101));
    }

    function test_buy_rejects_underpayment() public {
        vm.expectRevert(abi.encodeWithSelector(CreditSale.WrongPayment.selector, 2 * PRICE, 2 * PRICE - 1));
        vm.prank(BUYER);
        sale.buy{value: 2 * PRICE - 1}(commitments(2));
    }

    function test_buy_rejects_overpayment() public {
        vm.expectRevert(abi.encodeWithSelector(CreditSale.WrongPayment.selector, 2 * PRICE, 2 * PRICE + 1));
        vm.prank(BUYER);
        sale.buy{value: 2 * PRICE + 1}(commitments(2));
    }

    function test_buy_rejects_duplicate_commitment() public {
        bytes32[] memory list = commitments(4);
        list[3] = list[1];
        vm.expectRevert(abi.encodeWithSelector(CreditSale.DuplicateCommitment.selector, 3));
        vm.prank(BUYER);
        sale.buy{value: 4 * PRICE}(list);
    }

    function test_buy_rejects_adjacent_duplicate() public {
        bytes32[] memory list = commitments(2);
        list[1] = list[0];
        vm.expectRevert(abi.encodeWithSelector(CreditSale.DuplicateCommitment.selector, 1));
        vm.prank(BUYER);
        sale.buy{value: 2 * PRICE}(list);
    }

    function test_buy_rejects_commitment_not_in_field() public {
        bytes32[] memory list = commitments(2);
        list[1] = bytes32(sale.FIELD_MODULUS());
        vm.expectRevert(abi.encodeWithSelector(CreditSale.CommitmentNotInField.selector, 1));
        vm.prank(BUYER);
        sale.buy{value: 2 * PRICE}(list);
    }

    function test_plain_transfer_reverts() public {
        vm.prank(BUYER);
        (bool ok,) = address(sale).call{value: PRICE}("");
        require(!ok, "plain transfer must revert");
    }

    function test_withdraw_by_issuer() public {
        vm.prank(BUYER);
        sale.buy{value: 5 * PRICE}(commitments(5));
        address payable to = payable(address(0xCAFE));
        vm.expectEmit(true, true, true, true, address(sale));
        emit Withdrawn(to, 2 * PRICE);
        vm.prank(ISSUER);
        sale.withdraw(to, 2 * PRICE);
        assertEq(to.balance, 2 * PRICE, "receiver balance");
        assertEq(address(sale).balance, 3 * PRICE, "sale balance");
    }

    function test_withdraw_rejects_non_issuer() public {
        vm.prank(BUYER);
        sale.buy{value: PRICE}(commitments(1));
        vm.expectRevert(abi.encodeWithSelector(CreditSale.NotIssuer.selector));
        vm.prank(OTHER);
        sale.withdraw(OTHER, PRICE);
    }

    function test_withdraw_rejects_buyer() public {
        vm.prank(BUYER);
        sale.buy{value: PRICE}(commitments(1));
        vm.expectRevert(abi.encodeWithSelector(CreditSale.NotIssuer.selector));
        vm.prank(BUYER);
        sale.withdraw(BUYER, PRICE);
    }

    function test_withdraw_rejects_zero_receiver() public {
        vm.expectRevert(abi.encodeWithSelector(CreditSale.ZeroAddress.selector));
        vm.prank(ISSUER);
        sale.withdraw(address(0), 0);
    }

    function test_withdraw_rejects_more_than_balance() public {
        vm.prank(BUYER);
        sale.buy{value: PRICE}(commitments(1));
        vm.expectRevert(abi.encodeWithSelector(CreditSale.InsufficientBalance.selector, PRICE + 1, PRICE));
        vm.prank(ISSUER);
        sale.withdraw(ISSUER, PRICE + 1);
    }

    function test_withdraw_reports_failed_transfer() public {
        vm.prank(BUYER);
        sale.buy{value: PRICE}(commitments(1));
        RejectingReceiver receiver = new RejectingReceiver();
        vm.expectRevert(abi.encodeWithSelector(CreditSale.TransferFailed.selector));
        vm.prank(ISSUER);
        sale.withdraw(address(receiver), PRICE);
    }
}
