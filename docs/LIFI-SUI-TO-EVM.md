# LiFi: Sui → EVM L2 (e.g. Base) — Support and In-App Gap

## What the LiFi docs say

- **Sui overview**: *"LI.FI offers seamless same chain swaps on SUI and **bridging between SUI and major EVM chains and Solana**."*  
  [Sui Providers](https://docs.li.fi/introduction/lifi-architecture/sui-overview)

- **Chain overview**: *"LI.FI offers bridging and swaps between most EVM chains, native Bitcoin, Solana and SUI."*  
  [Chain Overview](https://docs.li.fi/introduction/chains)

So **Sui → EVM (including Base L2) is supported by LiFi** in principle; the direction is not EVM-only.

---

## Why the reverse (Sui → Base) isn’t done in our app

1. **Base → Sui (current flow)**  
   - User is on Base; we call `/quote` with `fromChain=Base`, `toChain=Sui`.  
   - The quote returns an **EVM** `transactionRequest` (to, data, value, chainId).  
   - We send it with the embedded EVM wallet (`eth_sendTransaction`).  
   - User signs **once on Base**; bridge + status polling works.

2. **Sui → Base (desired flow)**  
   - We already call `/quote` with `fromChain=Sui`, `toChain=Base` in `onBridgeToBase`.  
   - For Sui → EVM, the **first** transaction that moves funds is **on Sui**.  
   - The API may return:
     - A **Sui** transaction (different shape than ether.js `transactionRequest`), or  
     - A route that the SDK expects to execute via the **Sui provider** (signing on Sui first).  
   - Our code only handles an **EVM** `transactionRequest` with `chainId === BASE_MAINNET_CHAIN_ID` and sends it via `eth_sendTransaction`.  
   - So we either get no such object or the wrong chain; we then show:  
     *"This route requires signing on Sui. Use LI.FI Explorer to complete."*

So the limitation is **how we execute** the route (EVM-only in-app), not that LiFi “doesn’t support” Sui → EVM.

---

## What Base → Sui uses today (in this app)

**Option 2 (REST only).** There is no `@lifi/sdk` in the project. Base → Sui works by:

- `fetchLifiQuote()` → `GET https://li.quest/v1/quote` (fromChain=Base, toChain=Sui).
- Quote returns an EVM `transactionRequest` → we send it with the embedded EVM wallet (`eth_sendTransaction`).
- We poll `fetchLifiStatus(txHash, fromChainId)` until DONE/FAILED.

So the app uses **REST quote + we execute the tx ourselves** (Option B style). The only “custom” part is that the first (and only) tx is EVM, so we use the EVM provider.

---

## What would be needed for in-app Sui → Base

1. **Option A – LiFi SDK with Sui provider**  
   - Add `@lifi/sdk`, configure the **Sui** provider (`getWallet` from `@mysten/dapp-kit` or similar).  
   - Use `getQuote` / `executeRoute` so the SDK handles the Sui tx and any follow-up.  
   - Ref: [Multi-VM Support – Setup Sui Provider](https://docs.li.fi/sdk/configure-sdk-providers#setup-sui-provider).

2. **Option B – REST quote + custom Sui execution (same pattern as Base → Sui)**  
   - Keep using `fetchLifiQuote` with `fromChain=Sui`, `toChain=Base`.  
   - If the response includes a Sui transaction payload, parse it and sign/send with the user’s existing Sui wallet (e.g. `signAndExecuteTransactionBlock` or whatever the quote format requires).  
   - Track status with existing `fetchLifiStatus(txHash, SUI_CHAIN_ID)`.

3. **Current workaround**  
   - We already open LI.FI Explorer when the route requires signing on Sui.

---

## Which is most UX-friendly for Sui → Base?

**Option B (REST + custom Sui execution)** is the better fit for this app:

| | Option A (SDK) | Option B (REST + Sui tx) |
|---|----------------|---------------------------|
| **Consistency** | New flow (SDK, different code path) | Same flow as Base→Sui: quote → one in-app sign → status |
| **Where user signs** | SDK prompts (may differ from rest of app) | Same Sui wallet/signing already used for margin, withdraw, etc. |
| **Dependencies** | New `@lifi/sdk` (and provider wiring) | None; reuse `lib/lifi-quote.ts` and existing Sui signing |
| **React Native** | SDK may assume browser/window | REST + existing wallet is already proven in this stack |

So: **Base uses Option 2 (REST).** For Sui → Base, **Option B is the most UX-friendly** — one in-app Sui sign, same status polling, no new SDK, and the same mental model as “bridge from Base.”

---

## Summary

| Question | Answer |
|----------|--------|
| Is Sui → EVM L2 (e.g. Base) supported by LiFi? | **Yes** — docs state bridging between SUI and major EVM chains. |
| Why doesn’t it work in our app? | We only execute the **EVM** leg; Sui → Base requires signing **on Sui first**, which we don’t handle. |
| How to support it in-app? | Use LiFi SDK with Sui provider and `executeRoute`, or parse quote and send the Sui tx with the user’s Sui wallet. |
