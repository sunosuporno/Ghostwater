# Implementation: Base → DeepBook Margin — What Exists vs What to Build

## Summary

| Area | Already have | Need to build | Effort |
|------|--------------|----------------|--------|
| LI.FI bridge (Base → Sui) | ✅ Full flow | — | 0 |
| Margin deposit on Sui | ✅ Backend + app | — | 0 |
| Orchestration + new UX | Partial (same screen has both wallets) | New flow + wiring | **~1–2 days** |
| Edge cases (no manager, no Sui wallet) | Create-manager + wallet link exist | Surface in this flow | **~0.5 day** |
| **Total** | | | **~1.5–2.5 days** |

---

## 1. What you already have

### 1.1 LI.FI (bridge leg)

- **`lib/lifi-quote.ts`**
  - `fetchLifiQuote(fromChainId, toChainId, fromToken, toToken, fromAmount, fromAddress, toAddress?, slippage?)`
  - `fetchLifiStatus(txHash, fromChainId?)`
- **App usage** (`app/(app)/index.tsx`):
  - Base send: token + amount, recipient (address or subdomain).
  - For cross-chain: builds quote (Base → Sui with `toChainId: 9270000000000000`, `toAddress` for Sui).
  - Sends tx via embedded wallet, stores `baseSendTxHash`, polls `fetchLifiStatus`, shows status/DONE/FAILED and links.
- **Chains/tokens**: `config/preferred-chains-tokens.json` has Base (8453) and Sui (9270000000000000) and token addresses (USDC, SUI, etc.).

So: **quote → send → poll status** for Base → Sui is done. No new LI.FI or backend work for the bridge.

### 1.2 Margin on Sui

- **Backend**
  - `POST /api/prepare-margin-deposit` (sender, marginManagerId, poolKey, asset, amount, network).
  - `POST /api/execute-transfer` (txBytesBase64, signatureHex, publicKeyHex, network).
  - `POST /api/prepare-create-margin-manager` (sender, poolKey, network).
- **App**
  - `depositMarginViaBackend()` in `lib/margin-deposit-withdraw-via-backend.ts` (prepare → sign → execute).
  - Create margin manager flow on `trading/[poolName].tsx`.
  - Sui sign via `signRawHash` + `publicKeyToHex(suiWallet.publicKey)`.
- **Data**
  - `useOwnedMarginManagers(suiAddress, apiUrl, network)` for “my managers per pool.”
  - Pool list from ticker + `MARGIN_ENABLED_PAIRS` (SUI_USDC, WAL_USDC, DEEP_USDC).
  - Pool metadata (base/quote symbols, margin pool ids) from `useMarginManagersInfo()` / pool info.

So: **deposit** and **create manager** are implemented. Reuse as-is for the “after bridge” step.

### 1.3 Wallets and addresses

- **Base**: `evmAddress` (Privy embedded), `embeddedEthWallet`, network = base-sepolia / base-mainnet.
- **Sui**: `suiAddress` from linked Sui wallet (Privy); same user can have both.
- Home already shows both Sui and Base sections and can switch network.

So: **no new wallet or address resolution**; we only need to use `suiAddress` as `toAddress` in the new flow.

---

## 2. What you need to build

### 2.1 New entry point and flow (main work)

- **Where**: From the **Base** view (home when network is Base), add a clear CTA, e.g. **“Deposit from Base into margin”** or **“Bridge & add to margin”** (button or card). Optionally also from trading list with a “Fund with Base” action.
- **Screen or modal**: One dedicated flow (modal or full screen) that:
  1. **Input**
     - Source: token on Base (reuse existing token list / `baseBalances`), amount (reuse amount input + balance check).
     - Target: **pool** (e.g. SUI_USDC, WAL_USDC, DEEP_USDC) and, if we have multiple, **margin manager** for that pool (or “Create one”).
  2. **Step 1 – Bridge**
     - Resolve `toToken`: pool’s quote (e.g. USDC) or base (e.g. SUI) from pool key / config. Map to LI.FI token (Sui USDC/SUI from `preferred-chains-tokens.json` or existing Sui token IDs).
     - Call `fetchLifiQuote({ fromChainId: 8453, toChainId: 9270000000000000, fromTokenAddress, toTokenAddress, fromAmount, fromAddress: evmAddress, toAddress: suiAddress, slippage })`.
     - Send tx (same as current Base send: `provider.request({ method: 'eth_sendTransaction', params: [tx] })`).
     - Poll `fetchLifiStatus(txHash, 8453)` until `DONE` or `FAILED`; show same status UI as current send (optional: reuse same state/shared component).
  3. **Step 2 – Margin**
     - When status === `DONE`: show “Bridge complete. Add to margin?” with amount (from status or user input) and pool name.
     - If user has no margin manager for that pool: call create-margin-manager flow (one Sui tx), then deposit (second Sui tx). Or show “Create margin account” then “Deposit” in sequence.
     - If user has manager: call `depositMarginViaBackend({ apiUrl, sender: suiAddress, marginManagerId, poolKey, asset, amount, signRawHash, publicKeyHex, network })`. User signs once on Sui; backend executes.

- **Reuse**: Base token list, amount input, LI.FI quote/send/status, `depositMarginViaBackend`, create-margin-manager, `useOwnedMarginManagers`, pool list / `MARGIN_ENABLED_PAIRS`, `getSuiAddressFromUser` / `suiAddress` from home.

**Rough effort**: **1–1.5 days** (UI + state machine + wiring).

### 2.2 Edge cases (small)

- **No Sui wallet linked when on Base**
  - When user taps “Deposit from Base into margin,” if `!suiAddress`: show message “Link a Sui wallet first” and link to existing wallet link flow. No new backend.
- **No margin manager for chosen pool**
  - After bridge DONE: if `useOwnedMarginManagers` has no manager for that pool, show “Create margin account” (existing create flow), then “Deposit” (existing deposit flow). Optional: combine create + deposit in one Sui tx later to reduce to one sign.
- **Bridge failed**
  - Same as current send: show LI.FI status and “Failed”; no Step 2.
- **Amount to deposit**
  - Use received amount from `fetchLifiStatus.receiving.amount` (in smallest units) and convert to human amount for deposit, or let user confirm/edit before Step 2.

**Rough effort**: **~0.5 day** (guards + copy + optional “received amount” prefill).

### 2.3 Optional (later)

- **Deposit + place order in one Sui tx**: New backend `prepareDepositAndPlaceOrder` that builds one Sui `Transaction` with deposit + `placeMarketOrder`/`placeLimitOrder`. Then “Bridge → one Sui sign (deposit + open position).” **~0.5 day** backend + app param (order side, size, etc.).
- **Deep link / share**: e.g. `ghostwater://bridge-to-margin?pool=SUI_USDC&amount=100` to open the flow pre-filled. **~0.25 day.**

---

## 3. Order of implementation

1. **Entry + flow shell** (~0.5 day)  
   Add “Deposit from Base into margin” entry (e.g. on home when on Base). New modal/screen with: source token + amount, pool picker, “Continue” → Step 1.
2. **Step 1 – LI.FI** (~0.25 day)  
   In this flow: build quote (Base → Sui, toAddress = suiAddress, toToken = pool’s quote/base), send tx, poll status, show progress/DONE/FAILED (reuse patterns from current send).
3. **Step 2 – Margin** (~0.5 day)  
   On DONE: show “Add to margin?”; if manager exists call `depositMarginViaBackend`; if not, run create then deposit (two Sui txns for now).
4. **Guards and polish** (~0.25–0.5 day)  
   No Sui wallet → prompt to link. Prefill deposit amount from bridge receipt if desired. Copy and error messages.

**Total: ~1.5–2.5 days** for a shippable “Base → DeepBook margin” flow that fits the hackathon prize.

---

## 4. Files to touch (checklist)

| File / area | Change |
|-------------|--------|
| `app/(app)/index.tsx` (or new screen under `app/(app)/`) | New CTA “Deposit from Base into margin”; open new flow (modal or route). |
| New component/screen (e.g. `BridgeToMarginModal.tsx` or `bridge-to-margin.tsx`) | Full flow: inputs → LI.FI (quote, send, poll) → margin (create if needed, deposit). |
| `lib/lifi-quote.ts` | No change (already has quote + status). |
| `lib/margin-deposit-withdraw-via-backend.ts` | No change. |
| `lib/create-margin-manager-via-backend.ts` (or equivalent) | No change; call from new flow when no manager. |
| Backend | No change for MVP (optional later: `prepareDepositAndPlaceOrder`). |
| `config/preferred-chains-tokens.json` | Already has Sui + Base tokens; maybe add a small helper to get “Sui USDC/SUI token for LI.FI” by pool key. |

---

## 5. One-paragraph recap

You already have **LI.FI bridge (Base → Sui)** and **margin deposit + create-manager on Sui**; the gap is a **single orchestrated UX**: one entry point, pool/token/amount selection, run the existing LI.FI send, then on success run the existing margin deposit (and create-manager if needed). Building that flow and wiring the two steps is **~1.5–2.5 days**; no new backend or LI.FI APIs required for the MVP.
