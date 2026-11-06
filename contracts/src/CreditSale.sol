// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity 0.8.30;

/// @title CreditSale
/// @notice Sells anonymous credit batches for native ETH. Each batch costs `batchPriceWei`.
/// The buyer sends one commitment `c` for each batch. The issuer indexes `Purchased` events and
/// appends one tree leaf for each commitment. This contract does not build the tree.
/// @dev Funds are custodial issuer revenue. Only the issuer can withdraw them.
/// Plain ETH transfers revert, because the contract has no receive or fallback function.
contract CreditSale {
    /// @notice Maximum number of batches in one purchase.
    uint256 public constant MAX_BATCHES_PER_PURCHASE = 100;

    /// @notice BN254 scalar field modulus. A commitment must be a canonical field element.
    uint256 public constant FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    /// @notice The address that can withdraw funds. It also publishes roots in RootRegistry.
    address public immutable issuer;

    /// @notice Price of one batch in wei.
    uint256 public immutable batchPriceWei;

    /// @notice Identifier of the next purchase. The first purchase has identifier 0.
    uint256 public nextPurchaseId;

    /// @notice One purchase of `commitments.length` batches for `amount` wei.
    event Purchased(address indexed payer, uint256 indexed purchaseId, bytes32[] commitments, uint256 amount);

    /// @notice The issuer withdrew `amount` wei to `to`.
    event Withdrawn(address indexed to, uint256 amount);

    /// @notice The caller is not the issuer.
    error NotIssuer();
    /// @notice A constructor argument is the zero address.
    error ZeroAddress();
    /// @notice The batch price is zero.
    error ZeroPrice();
    /// @notice The purchase has no commitments.
    error EmptyPurchase();
    /// @notice The purchase has more than `MAX_BATCHES_PER_PURCHASE` commitments.
    error TooManyBatches(uint256 count);
    /// @notice The payment is not exactly `batchPriceWei * commitments.length`.
    error WrongPayment(uint256 expected, uint256 received);
    /// @notice The commitment at `index` is equal to an earlier commitment in the same purchase.
    error DuplicateCommitment(uint256 index);
    /// @notice The commitment at `index` is not less than the field modulus.
    error CommitmentNotInField(uint256 index);
    /// @notice The withdrawal amount is more than the balance.
    error InsufficientBalance(uint256 requested, uint256 available);
    /// @notice The ETH transfer of a withdrawal failed.
    error TransferFailed();

    /// @param issuer_ The issuer address. It must not be zero.
    /// @param batchPriceWei_ The price of one batch in wei. It must not be zero.
    constructor(address issuer_, uint256 batchPriceWei_) {
        if (issuer_ == address(0)) revert ZeroAddress();
        if (batchPriceWei_ == 0) revert ZeroPrice();
        issuer = issuer_;
        batchPriceWei = batchPriceWei_;
    }

    /// @notice Buy one batch for each commitment. Send exactly `batchPriceWei * commitments.length`.
    /// @return purchaseId The identifier of this purchase.
    function buy(bytes32[] calldata commitments) external payable returns (uint256 purchaseId) {
        uint256 count = commitments.length;
        if (count == 0) revert EmptyPurchase();
        if (count > MAX_BATCHES_PER_PURCHASE) revert TooManyBatches(count);
        uint256 expected = batchPriceWei * count;
        if (msg.value != expected) revert WrongPayment(expected, msg.value);
        for (uint256 i = 0; i < count; ++i) {
            bytes32 commitment = commitments[i];
            if (uint256(commitment) >= FIELD_MODULUS) revert CommitmentNotInField(i);
            for (uint256 j = 0; j < i; ++j) {
                if (commitments[j] == commitment) revert DuplicateCommitment(i);
            }
        }
        purchaseId = nextPurchaseId;
        nextPurchaseId = purchaseId + 1;
        emit Purchased(msg.sender, purchaseId, commitments, msg.value);
    }

    /// @notice Send `amount` wei of revenue to `to`. Only the issuer can call this function.
    function withdraw(address to, uint256 amount) external {
        if (msg.sender != issuer) revert NotIssuer();
        if (to == address(0)) revert ZeroAddress();
        uint256 available = address(this).balance;
        if (amount > available) revert InsufficientBalance(amount, available);
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
