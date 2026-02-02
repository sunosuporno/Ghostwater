# DeepBook Margin + Privy Wallet Integration

This doc summarizes how margin accounts and transactions work per the [DeepBook Margin SDK](https://docs.sui.io/standards/deepbook-margin-sdk), and how to integrate with **Privy’s embedded Sui wallet** (no raw keypair).

---

## 0. Creating a New Margin Account – Quick Answers

**1. Is there one margin account per user–pool pair?**  
Yes. Each [MarginManager](https://docs.sui.io/standards/deepbook-margin/design#margin-manager-shared-object) is associated with a **specific DeepBook pool**. A user creates one margin manager per pool they want to trade on (e.g. one for SUI/USDC, another for DEEP/USDC). So conceptually: **(user, pool) → one margin account (MarginManager)**. One user can have many margin managers (one per pool).

**2. Does creating a margin account cost gas?**  
Yes. Creating a MarginManager is an on-chain transaction that creates a new object. On Sui, the **sender pays gas** by default (see [Gas in Sui](https://docs.sui.io/concepts/tokenomics/gas-in-sui)). The user needs SUI for gas unless you use [sponsored transactions](https://docs.sui.io/concepts/transactions/sponsored-transactions).

**3. Is the mapping (user + pool → margin_manager_id) stored on-chain or do I store it myself?**

- **On-chain:** The MarginManager **object** itself lives on-chain (it has an object ID, an owner, and is tied to a pool). So “this object exists and belongs to this pool” is on-chain.
- **From the indexer:** Yes. The [DeepBook Margin Indexer](https://docs.sui.io/standards/deepbook-margin-indexer#margin-manager-endpoints) exposes this. The **`/margin_manager_created`** endpoint returns creation events that include **`owner`**, **`margin_manager_id`**, and **`deepbook_pool_id`**. So the (user, pool) → margin_manager_id mapping is derivable from indexer data. If the indexer supports querying by **owner** (e.g. `?owner=0x...`), you can fetch “all margin managers for this user” and build the mapping without storing it yourself. The docs show query by `margin_manager_id`; try adding an `owner` param or use **`/margin_manager_states?deepbook_pool_id=...`** and filter by owner if the response includes it.
- **In practice:** You can **derive** the mapping from the indexer when owner-based query is available; otherwise **store it yourself** (e.g. SecureStore) when you create a manager so the app can quickly show “your margin account for SUI/USDC” without re-querying. Ghostwater currently stores it in `lib/margin-manager-storage.ts`.

---

## 1. DeepBook Margin SDK – How It Works

### Install

```bash
npm install @mysten/deepbook-v3
```

The SDK uses **SuiGrpcClient** extended with `deepbook()`. You pass:

- **address**: signer’s Sui address
- **marginManagers** (optional): map of manager key → `{ address, poolKey }`
- **marginMaintainerCap** (optional): for maintainer flows

Default coins/pools are in `utils/constants.ts`; you can override with custom `CoinMap` / `PoolMap`.

### Creating a Margin Manager (Margin Account)

Before margin trading you must have a **margin manager** for a pool.

1. **Create on-chain** (no existing manager):

   - Build a transaction: `tx.add(client.deepbook.marginManager.newMarginManager(poolKey))`
   - Sign and execute (e.g. `client.core.signAndExecuteTransaction({ transaction: tx, signer: keypair })`)
   - From the result, read the **created** `MarginManager` object id
   - Reinitialize the client with `marginManagers: { MARGIN_MANAGER_1: { address: marginManagerAddress, poolKey } }`

2. **Use existing manager**: if the user already has a margin manager (e.g. from another app or a previous create), pass its address and the same `poolKey` in `marginManagers`.

**Pool key format**: indexer uses names like `SUI_USDC`; SDK uses `poolKey` (e.g. `SUI_USDC`, `SUI_DBUSDC` on testnet). Your stored `deepbook_pool_id` / pool name should map to the SDK’s `poolKey`.

### Margin Manager Operations (Deposit, Borrow, Repay)

- **Deposit**: `client.deepbook.marginManager.deposit(marginManagerKey, coinKey, amount)(tx)`
- **Borrow**: `client.deepbook.marginManager.borrowBase(marginManagerKey, poolKey, amount)(tx)` (and similar for quote)
- Repay and other flows are in the [Margin Manager SDK](https://docs.sui.io/standards/deepbook-margin-sdk) and [Margin Pool SDK](https://docs.sui.io/standards/deepbook-margin-sdk/margin-pool).

All of these **add** to a `Transaction`; you then **sign and execute** that transaction.

### Placing Orders

- **Limit**: `client.deepbook.poolProxy.placeLimitOrder({ poolKey, marginManagerKey, clientOrderId, price, quantity, isBid, payWithDeep })(tx)`
- **Market**: `placeMarketOrder` with similar params (no price).
- Cancel: `cancelOrder(marginManagerKey, orderId)`, `cancelAllOrders(marginManagerKey)`, etc.

Again: build `tx`, then sign and execute.

### How the SDK Expects Signing

The examples use a **keypair** (e.g. `Ed25519Keypair`) and:

```ts
client.core.signAndExecuteTransaction({
  transaction: tx,
  signer: this.keypair,
  include: { effects: true, objectTypes: true },
});
```

So the SDK assumes you have a **Sui `Signer`** (keypair) that can sign transaction bytes. With Privy we **do not** have the private key; we only have an embedded wallet and a **raw sign** API.

---

## 2. Privy Complication: No Keypair, Only Raw Sign

With **Privy**:

- You **create** a Sui wallet via `useCreateWallet({ chainType: 'sui' })` and get `wallet.address` (and possibly `wallet.id`, `wallet.public_key` – see below).
- You **do not** get the private key. Signing is done via Privy’s **raw sign**:
  - **React / Expo**: `useSignRawHash()` from `@privy-io/expo/extended-chains` (or React equivalent).
  - **Server**: `privy.wallets().rawSign(walletId, { params: { ... } })`.

So we cannot pass a keypair to `signAndExecuteTransaction`. We must either:

1. **Custom signer** that implements Sui’s `Signer` and, when asked to sign, calls Privy’s raw sign and returns the serialized signature, or
2. **Build → Sign → Execute manually**: build the transaction (with DeepBook SDK or raw `Transaction`), get bytes, sign via Privy, then submit the signed transaction with the Sui client.

---

## 3. Sui Intent Signing (Required for Privy)

Sui uses **intent signing**. The bytes that must be signed are the **intent message**, not the raw transaction bytes.

From [Privy – Using chains with Tier 2 support (Sui)](https://docs.privy.io/recipes/use-tier-2#sui):

1. Build the transaction (e.g. `tx.build({ client })` → `rawBytes`).
2. Build intent message: `messageWithIntent('TransactionData', rawBytes)`.
3. Sign that message with Privy:
   - For Sui, the Tier 2 recipe says to pass the intent message **bytes** (hex) and `hash_function: 'blake2b256'` so Privy hashes then signs. (If your Privy client only supports `keccak256`/`sha256`, hash the intent message with blake2b256 yourself and pass the **hash** to raw sign.)
4. Get the wallet’s **public key** from Privy (base58 or raw), decode to bytes.
5. Build the serialized signature: `toSerializedSignature({ signature: rawSignature, signatureScheme: 'ED25519', publicKey })`.
6. Submit: e.g. `client.executeTransactionBlock({ transaction: signedTx, ... })` (exact API depends on Sui SDK version).

So any integration (custom signer or manual flow) must use this intent + blake2b256 + ED25519 path.

---

## 4. Do Privy Wallets Work Seamlessly? Do You Need a Backend?

**Short answer:** Yes, Privy Tier 2 Sui works **client-side** for signing. You **do not need your own backend** for normal user-initiated margin/order transactions.

- **Signing:** Privy’s [Tier 2 support for Sui](https://docs.privy.io/recipes/use-tier-2#sui) is designed for **client-side** flows. On Expo you use **`useSignRawHash`** from `@privy-io/expo/extended-chains` with `address` (Sui wallet address) and `chainType: 'sui'`. The user signs in the app; the private key never leaves Privy’s custody. No call to your server is required for the signature.
- **Build + submit:** Building the DeepBook transaction and submitting the signed tx to Sui can also be done in the app (e.g. with `@mysten/sui` client). So the full path is: **build (client) → sign with useSignRawHash (client) → execute (client)**. No backend needed.
- **“Seamless”:** Privy gives you the API; the DeepBook SDK does not know about Privy. You have to **wire** them once: either a custom Sui `Signer` that calls `signRawHash`, or a manual “build → intent message → signRawHash → serialize signature → execute” flow. After that, it’s seamless for the user.
- **When a backend _is_ needed:** Only for cases like (1) **server-triggered signing** (e.g. keeper bots using `PrivyClient` and `privy.wallets().rawSign(walletId, …)` with app secret), (2) **sponsored transactions** where your server is the gas sponsor, or (3) **wallet creation/lookup** via server with app secret. For “user taps Create margin account / Place order” in the app, **no backend**.

---

## 5. Privy Client-Side API (Expo)

From [Privy – Other chains](https://docs.privy.io/wallets/using-wallets/other-chains):

- **useSignRawHash** (React Native / Expo): `@privy-io/expo/extended-chains`

```ts
import { useSignRawHash } from "@privy-io/expo/extended-chains";

const { signRawHash } = useSignRawHash();

// Option 1: pre-computed hash
const { signature } = await signRawHash({
  address: "0x...", // Sui wallet address
  chainType: "sui",
  hash: "0x...",
});

// Option 2: bytes + hash function (for Sui intent message)
const { signature } = await signRawHash({
  address: suiWalletAddress,
  chainType: "sui",
  bytes: intentMessageHex,
  encoding: "hex",
  hash_function: "blake2b256", // Sui uses blake2b256 for intent
});
```

You need:

- **address**: Sui address (you already have this from `getSuiAddressFromUser` / `createSuiWallet`).
- **Wallet id**: For server-side raw sign you need the Privy wallet id; for client-side `signRawHash` you use `address` + `chainType: 'sui'`.
- **Public key**: To build `toSerializedSignature` you need the wallet’s public key. Privy’s Tier 2 Sui example uses `publicKeyFromRawBytes('ED25519', base58.decode(publicKeyString))`. Check whether `createSuiWallet` or “get wallet by address” returns `public_key` (and in what format).

---

## 6. Recommended Approach for Ghostwater

1. **Add dependencies**

   - `@mysten/deepbook-v3`
   - `@mysten/sui` (client, transactions, cryptography, verify – as required by deepbook-v3 and Sui intent signing).

2. **Get wallet identity for signing**

   - Ensure you can get **Sui address** and **public key** (and if needed wallet id) for the active user’s Sui wallet (e.g. from `createSuiWallet` response or a “get wallet” by address/chain). Extend `lib/sui.ts` or the Home screen to store/return `wallet.id` and `wallet.public_key` if available.

3. **Implement a Privy-backed signer (recommended)**

   - Create a small class that implements the Sui `Signer` interface:
     - In `signTransaction(bytes)` (or the method that receives raw tx bytes): build intent message with `messageWithIntent('TransactionData', bytes)`, call `signRawHash({ address, chainType: 'sui', bytes: intentMessageHex, encoding: 'hex', hash_function: 'blake2b256' })`, then build `toSerializedSignature(...)` with the returned signature and the wallet’s public key.
   - Use this signer when calling `client.core.signAndExecuteTransaction({ transaction: tx, signer: privySigner })` so the rest of your code can use the DeepBook SDK as in the docs.

4. **Alternative: build – sign – execute manually**

   - Build `Transaction`, add DeepBook calls (margin manager + pool proxy), then `tx.build({ client })`.
   - Build intent message, call `signRawHash` as above, assemble signed transaction, then call `client.executeTransactionBlock` (or equivalent) with the signed payload. This avoids implementing a custom Signer but requires more manual wiring.

5. **Margin manager creation**

   - **Create**: Build tx with `client.deepbook.marginManager.newMarginManager(poolKey)`, sign and execute with your Privy signer, parse created object id from effects, then save to your app (e.g. SecureStore) and optionally reinitialize the DeepBook client with the new `marginManagers` map.
   - **Link existing**: You already support “link existing manager” by storing `margin_manager_id` + pool ids; when building DeepBook client, set `marginManagers` from that stored data so the SDK can resolve the manager by key.

6. **Pool key mapping**

   - Your indexer uses names like `SUI_USDC`; SDK uses `poolKey` (e.g. `SUI_USDC`). Use the same string where possible, or keep a small map from your `deepbook_pool_id` / display name to the SDK `poolKey`.

7. **Orders and other actions**
   - Once the client is initialized with address and margin managers, use the SDK’s `placeLimitOrder`, `placeMarketOrder`, deposit, borrow, repay, cancel, etc., as in the [DeepBook Margin SDK](https://docs.sui.io/standards/deepbook-margin-sdk) and [Orders SDK](https://docs.sui.io/standards/deepbook-margin-sdk/orders). All go through the same “build tx → sign with Privy → execute” path.

---

## 7. References

- [DeepBook Margin SDK](https://docs.sui.io/standards/deepbook-margin-sdk) – install, client, margin manager create/use, keys.
- [Orders SDK](https://docs.sui.io/standards/deepbook-margin-sdk/orders) – placeLimitOrder, placeMarketOrder, cancel, etc.
- [Margin Pool SDK](https://docs.sui.io/standards/deepbook-margin-sdk/margin-pool) – supply/withdraw liquidity (lenders).
- [Take Profit Stop Loss SDK](https://docs.sui.io/standards/deepbook-margin-sdk/tpsl) – conditional orders.
- [Privy – Using chains with Tier 2 support](https://docs.privy.io/recipes/use-tier-2) – Sui intent message, blake2b256, public key, serialized signature.
- [Privy – Other chains (raw sign)](https://docs.privy.io/wallets/using-wallets/other-chains) – `useSignRawHash` (Expo/React), params (hash vs bytes + encoding + hash_function).
