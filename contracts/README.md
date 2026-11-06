# Contracts

Foundry project for the Sepolia contracts. No library is vendored: `test/Vm.sol` declares the
few cheatcodes that the tests and the deploy script use.

| Contract | Use |
|---|---|
| `src/CreditSale.sol` | Sells batches for native ETH. Emits `Purchased`. The issuer withdraws revenue. |
| `src/RootRegistry.sol` | The issuer publishes one MMR root for each closed epoch. The gateway reads it. |
| `script/Deploy.s.sol` | Deploys both contracts. |

## ABI summary

`CreditSale(address issuer, uint256 batchPriceWei)`

| Member | Description |
|---|---|
| `buy(bytes32[] commitments) payable returns (uint256 purchaseId)` | `msg.value` must equal `batchPriceWei * commitments.length`. 1 to 100 commitments. No duplicates in one call. Each commitment must be less than the BN254 scalar field modulus. |
| `withdraw(address to, uint256 amount)` | Issuer only. `to` must not be zero. `amount` must not be more than the balance. |
| `issuer()`, `batchPriceWei()` | Immutable. |
| `nextPurchaseId()` | The identifier of the next purchase. The first purchase has identifier 0. |
| `MAX_BATCHES_PER_PURCHASE()`, `FIELD_MODULUS()` | Constants: 100 and the BN254 scalar field modulus. |
| `event Purchased(address indexed payer, uint256 indexed purchaseId, bytes32[] commitments, uint256 amount)` | One for each purchase. |
| `event Withdrawn(address indexed to, uint256 amount)` | One for each withdrawal. |
| Errors | `NotIssuer`, `ZeroAddress`, `ZeroPrice`, `EmptyPurchase`, `TooManyBatches(count)`, `WrongPayment(expected, received)`, `DuplicateCommitment(index)`, `CommitmentNotInField(index)`, `InsufficientBalance(requested, available)`, `TransferFailed` |

A plain ETH transfer to `CreditSale` reverts (no `receive` or `fallback` function).

`RootRegistry(address issuer, uint64 epochSeconds)`

| Member | Description |
|---|---|
| `postRoot(uint64 epoch, bytes32 root, uint64 leafCount)` | Issuer only. The root must not be zero. The epoch must be after `latestEpoch` and closed: `(epoch + 1) * epochSeconds <= block.timestamp`. `leafCount` must not decrease and must be at most `2^32 - 1`. |
| `rootAt(uint64 epoch) view returns (bytes32 root, uint64 leafCount)` | Both values are zero for an epoch that is not published. |
| `latestEpoch()`, `latestLeafCount()` | The last published epoch and its leaf count. Zero before the first publication. |
| `issuer()`, `epochSeconds()`, `MAX_LEAF_COUNT()` | Immutable values and the constant `2^32 - 1`. |
| `event RootPosted(uint64 indexed epoch, bytes32 root, uint64 leafCount)` | One for each publication. |
| Errors | `NotIssuer`, `ZeroAddress`, `ZeroEpochSeconds`, `ZeroRoot`, `EpochAlreadyPosted(epoch)`, `EpochNotAfterLatest(epoch, latest)`, `EpochNotClosed(epoch)`, `LeafCountDecreased(leafCount, latest)`, `LeafCountTooLarge(leafCount)` |

Epochs increase strictly. If the issuer does not publish an epoch, that epoch stays empty. The
issuer cannot publish it later. Thus a late publication cannot give an earlier epoch a newer
root.

## Test

```sh
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts
forge test
```

The tests use the in-process EVM. They do not start a network.

## Deploy to Sepolia

The user deploys. The agents and the checks never broadcast.

1. Fund the deployer key with Sepolia ETH. The deployer can be the issuer key or a different
   key. The issuer key must also have Sepolia ETH, because it sends one `postRoot`
   transaction for each epoch (about 2,880 transactions each day with 30 second epochs).
2. Set the environment. Do not write these values into tracked files.

   ```sh
   export SEPOLIA_RPC_URL=https://...           # secret if it has an API key
   export ISSUER_PRIVATE_KEY=0x...              # secret
   export ISSUER_ADDRESS=0x...                  # the address of ISSUER_PRIVATE_KEY
   export BATCH_PRICE_WEI=100000000000000
   export EPOCH_SECONDS=30                      # optional; default 30; production 900
   ```

3. Simulate, then broadcast:

   ```sh
   cd contracts
   forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC_URL
   forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $ISSUER_PRIVATE_KEY
   ```

   The script prints the two addresses. `broadcast/Deploy.s.sol/11155111/run-latest.json` has
   the transaction hashes and the block numbers.

4. Verify on Etherscan (`ETHERSCAN_API_KEY` is a secret):

   ```sh
   forge verify-contract --chain sepolia --watch --etherscan-api-key $ETHERSCAN_API_KEY \
     --constructor-args $(cast abi-encode "constructor(address,uint256)" $ISSUER_ADDRESS $BATCH_PRICE_WEI) \
     <CREDIT_SALE_ADDRESS> src/CreditSale.sol:CreditSale

   forge verify-contract --chain sepolia --watch --etherscan-api-key $ETHERSCAN_API_KEY \
     --constructor-args $(cast abi-encode "constructor(address,uint64)" $ISSUER_ADDRESS $EPOCH_SECONDS) \
     <ROOT_REGISTRY_ADDRESS> src/RootRegistry.sol:RootRegistry
   ```

5. Record the deployment. Copy `deployments/sepolia.example.json` to
   `deployments/sepolia.json` and fill in the addresses, transaction hashes, and blocks.
6. Copy `config/deployment.testnet.template.toml` and set `sale_address`,
   `root_registry_address`, and `issuer_address` in lowercase hex. Set `ISSUER_START_BLOCK`
   for the issuer to the `CreditSale` deployment block. See the issuer section of the root
   README.

Compiler: solc 0.8.30, EVM version `cancun`, optimizer on with 200 runs (`foundry.toml`).
