// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity 0.8.30;

import {RootRegistry} from "../src/RootRegistry.sol";
import {TestBase} from "./Vm.sol";

contract RootRegistryTest is TestBase {
    event RootPosted(uint64 indexed epoch, bytes32 root, uint64 leafCount);

    address internal constant ISSUER = address(0x1551);
    address internal constant OTHER = address(0x0BAD);
    uint64 internal constant EPOCH_SECONDS = 30;
    // Epoch 1000 closes at 30030. The tests start at 30030, so epoch 1000 is closed.
    uint64 internal constant FIRST = 1000;
    bytes32 internal constant ROOT_A = bytes32(uint256(0xaa));
    bytes32 internal constant ROOT_B = bytes32(uint256(0xbb));

    RootRegistry internal registry;

    function setUp() public {
        registry = new RootRegistry(ISSUER, EPOCH_SECONDS);
        vm.warp((uint256(FIRST) + 1) * EPOCH_SECONDS);
    }

    function test_constructor_sets_immutables() public view {
        assertEq(registry.issuer(), ISSUER, "issuer");
        assertEq(registry.epochSeconds(), EPOCH_SECONDS, "epoch seconds");
        assertEq(registry.latestEpoch(), 0, "no epoch published");
        assertEq(registry.latestLeafCount(), 0, "no leaves");
    }

    function test_constructor_rejects_zero_issuer() public {
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.ZeroAddress.selector));
        new RootRegistry(address(0), EPOCH_SECONDS);
    }

    function test_constructor_rejects_zero_epoch_seconds() public {
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.ZeroEpochSeconds.selector));
        new RootRegistry(ISSUER, 0);
    }

    function test_post_root_emits_and_stores() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit RootPosted(FIRST, ROOT_A, 7);
        vm.prank(ISSUER);
        registry.postRoot(FIRST, ROOT_A, 7);
        (bytes32 root, uint64 leafCount) = registry.rootAt(FIRST);
        assertEq(root, ROOT_A, "root");
        assertEq(leafCount, 7, "leaf count");
        assertEq(registry.latestEpoch(), FIRST, "latest epoch");
        assertEq(registry.latestLeafCount(), 7, "latest leaf count");
    }

    function test_root_at_unpublished_epoch_is_zero() public view {
        (bytes32 root, uint64 leafCount) = registry.rootAt(FIRST);
        assertEq(root, bytes32(0), "zero root");
        assertEq(leafCount, 0, "zero leaf count");
    }

    function test_post_root_accepts_later_epoch_and_skipped_epochs() public {
        vm.prank(ISSUER);
        registry.postRoot(FIRST, ROOT_A, 7);
        vm.warp((uint256(FIRST) + 6) * EPOCH_SECONDS);
        vm.prank(ISSUER);
        registry.postRoot(FIRST + 5, ROOT_B, 7);
        assertEq(registry.latestEpoch(), FIRST + 5, "latest epoch");
        (bytes32 skipped,) = registry.rootAt(FIRST + 2);
        assertEq(skipped, bytes32(0), "skipped epoch has no root");
    }

    function test_post_root_rejects_non_issuer() public {
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.NotIssuer.selector));
        vm.prank(OTHER);
        registry.postRoot(FIRST, ROOT_A, 1);
    }

    function test_post_root_rejects_zero_root() public {
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.ZeroRoot.selector));
        vm.prank(ISSUER);
        registry.postRoot(FIRST, bytes32(0), 1);
    }

    function test_post_root_rejects_epoch_already_posted() public {
        vm.prank(ISSUER);
        registry.postRoot(FIRST, ROOT_A, 1);
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.EpochAlreadyPosted.selector, FIRST));
        vm.prank(ISSUER);
        registry.postRoot(FIRST, ROOT_B, 2);
        (bytes32 root,) = registry.rootAt(FIRST);
        assertEq(root, ROOT_A, "root is not overwritten");
    }

    function test_post_root_rejects_earlier_epoch() public {
        vm.prank(ISSUER);
        registry.postRoot(FIRST, ROOT_A, 1);
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.EpochNotAfterLatest.selector, FIRST - 1, FIRST));
        vm.prank(ISSUER);
        registry.postRoot(FIRST - 1, ROOT_B, 1);
    }

    function test_post_root_rejects_epoch_zero() public {
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.EpochNotAfterLatest.selector, 0, 0));
        vm.prank(ISSUER);
        registry.postRoot(0, ROOT_A, 1);
    }

    function test_post_root_rejects_open_epoch() public {
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.EpochNotClosed.selector, FIRST + 1));
        vm.prank(ISSUER);
        registry.postRoot(FIRST + 1, ROOT_A, 1);
    }

    function test_post_root_rejects_open_epoch_one_second_before_close() public {
        vm.warp((uint256(FIRST) + 2) * EPOCH_SECONDS - 1);
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.EpochNotClosed.selector, FIRST + 1));
        vm.prank(ISSUER);
        registry.postRoot(FIRST + 1, ROOT_A, 1);
        vm.warp((uint256(FIRST) + 2) * EPOCH_SECONDS);
        vm.prank(ISSUER);
        registry.postRoot(FIRST + 1, ROOT_A, 1);
    }

    function test_post_root_rejects_decreasing_leaf_count() public {
        vm.prank(ISSUER);
        registry.postRoot(FIRST - 1, ROOT_A, 5);
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.LeafCountDecreased.selector, 4, 5));
        vm.prank(ISSUER);
        registry.postRoot(FIRST, ROOT_B, 4);
    }

    function test_post_root_rejects_too_large_leaf_count() public {
        uint64 tooLarge = uint64(type(uint32).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(RootRegistry.LeafCountTooLarge.selector, tooLarge));
        vm.prank(ISSUER);
        registry.postRoot(FIRST, ROOT_A, tooLarge);
    }

    function test_post_root_accepts_max_leaf_count() public {
        vm.prank(ISSUER);
        registry.postRoot(FIRST, ROOT_A, type(uint32).max);
        assertEq(registry.latestLeafCount(), type(uint32).max, "max leaf count");
    }
}
