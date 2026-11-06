// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity 0.8.30;

/// @title RootRegistry
/// @notice The issuer publishes one MMR root for a closed epoch. A published epoch cannot change.
/// The gateway reads finalized roots from this contract. It does not trust the issuer HTTP API.
/// @dev Rules:
/// - Only the issuer can publish.
/// - An epoch can be published one time only.
/// - Epochs increase strictly. An epoch that is skipped cannot be published later.
/// - An epoch must be closed: `(epoch + 1) * epochSeconds <= block.timestamp`.
/// - The leaf count must not decrease, because the MMR is append-only.
/// - A root must not be zero. Thus `rootAt` returns a zero root only for an epoch that is not
///   published.
contract RootRegistry {
    /// @notice Largest leaf count of the MMR (`2^32 - 1`).
    uint64 public constant MAX_LEAF_COUNT = type(uint32).max;

    struct Record {
        bytes32 root;
        uint64 leafCount;
    }

    /// @notice The only address that can publish roots.
    address public immutable issuer;

    /// @notice Epoch length in seconds. Epoch `e` covers `[e * epochSeconds, (e + 1) * epochSeconds)`.
    uint64 public immutable epochSeconds;

    /// @notice The last published epoch, or zero if no epoch is published.
    uint64 public latestEpoch;

    /// @notice The leaf count of the last published epoch.
    uint64 public latestLeafCount;

    mapping(uint64 epoch => Record record) private records;

    /// @notice The issuer published `root` with `leafCount` leaves for `epoch`.
    event RootPosted(uint64 indexed epoch, bytes32 root, uint64 leafCount);

    /// @notice The caller is not the issuer.
    error NotIssuer();
    /// @notice The issuer address is zero.
    error ZeroAddress();
    /// @notice The epoch length is zero.
    error ZeroEpochSeconds();
    /// @notice The root is zero.
    error ZeroRoot();
    /// @notice The epoch is already published.
    error EpochAlreadyPosted(uint64 epoch);
    /// @notice The epoch is not after the latest published epoch.
    error EpochNotAfterLatest(uint64 epoch, uint64 latest);
    /// @notice The epoch is not closed at the current block time.
    error EpochNotClosed(uint64 epoch);
    /// @notice The leaf count is less than the leaf count of the latest published epoch.
    error LeafCountDecreased(uint64 leafCount, uint64 latest);
    /// @notice The leaf count is more than `MAX_LEAF_COUNT`.
    error LeafCountTooLarge(uint64 leafCount);

    /// @param issuer_ The issuer address. It must not be zero.
    /// @param epochSeconds_ The epoch length in seconds. It must not be zero.
    constructor(address issuer_, uint64 epochSeconds_) {
        if (issuer_ == address(0)) revert ZeroAddress();
        if (epochSeconds_ == 0) revert ZeroEpochSeconds();
        issuer = issuer_;
        epochSeconds = epochSeconds_;
    }

    /// @notice Publish the root of `epoch`. Only the issuer can call this function.
    function postRoot(uint64 epoch, bytes32 root, uint64 leafCount) external {
        if (msg.sender != issuer) revert NotIssuer();
        if (root == bytes32(0)) revert ZeroRoot();
        if (records[epoch].root != bytes32(0)) revert EpochAlreadyPosted(epoch);
        uint64 latest = latestEpoch;
        if (epoch <= latest) revert EpochNotAfterLatest(epoch, latest);
        if ((uint256(epoch) + 1) * epochSeconds > block.timestamp) revert EpochNotClosed(epoch);
        if (leafCount > MAX_LEAF_COUNT) revert LeafCountTooLarge(leafCount);
        if (leafCount < latestLeafCount) revert LeafCountDecreased(leafCount, latestLeafCount);
        records[epoch] = Record({root: root, leafCount: leafCount});
        latestEpoch = epoch;
        latestLeafCount = leafCount;
        emit RootPosted(epoch, root, leafCount);
    }

    /// @notice The root and leaf count of `epoch`. Both are zero if the epoch is not published.
    function rootAt(uint64 epoch) external view returns (bytes32 root, uint64 leafCount) {
        Record storage record = records[epoch];
        return (record.root, record.leafCount);
    }
}
