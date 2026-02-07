# Feasibility: Base → DeepBook Margin via LI.FI (Prize: Best Use of LI.FI Composer in DeFi)

## Goal

Enable Base users to **open a position in a DeepBook margin pool** in one user journey, competing for the **"Best Use of LI.FI Composer in DeFi"** prize ($2,500). Prize description: *"Turn any asset on any EVM chain into a Perps margin position on a specific chain."*

---

## 1. Can we use “LI.FI Composer” literally?

**Short answer: No — for the second step.**

From [LI.FI Composer docs](https://docs.li.fi/introduction/user-flows-and-examples/lifi-composer):

- **Composer** = multi-step execution via an **onchain VM** that runs contract calls (swaps, vault deposits, etc.).
- **Limitation**: *"No Solana or **non-EVM chain support**"*. Composer is **single-chain** and **EVM-only**. Supported protocols are Morpho, Aave, Euler, etc. on Base/Ethereum/Arbitrum.
- **DeepBook margin** lives on **Sui** (Move). So LI.FI’s Composer **cannot** execute the “deposit into DeepBook margin” step on Sui.

So we **cannot** do: one Composer transaction = bridge + DeepBook margin deposit. The margin step must be our own Sui flow.

---

## 2. What we can do (and why it still fits the prize)

The prize asks for the project that **“most creatively uses LI.FI Composer to orchestrate multi-step DeFi workflows in a single, user-friendly experience.”**

We can:

- Use **LI.FI** for the **bridge leg**: Base (any token) → Sui (USDC/SUI).
- Use **our existing stack** for the **margin leg**: prepare-margin-deposit → sign (Sui) → execute-transfer.
- Present this as **one intent**: “Deposit from Base into DeepBook margin” with a single, guided flow (one or two clicks after the bridge).

So we are **orchestrating a multi-step DeFi workflow** (bridge + margin deposit) in a **single user experience**, using LI.FI for the cross-chain step. That aligns with the prize even though the second step is not Composer’s VM.

---

## 3. Feasibility summary

| Item | Status |
|------|--------|
| LI.FI bridge Base → Sui | ✅ Supported; we already use it for “send to Sui” in the app |
| LI.FI quote for Base → Sui (to user’s Sui address) | ✅ Same as current send flow; `toAddress` = Sui address |
| Margin deposit on Sui | ✅ Already implemented (prepare-margin-deposit + sign + execute-transfer) |
| Same user has Base + Sui | ✅ App already supports Base (Privy/embedded) and Sui (linked wallet) |
| Composer executing on Sui | ❌ Not supported (EVM-only) |

**Conclusion: Feasible** as a **two-step, one-flow** experience: LI.FI bridge (Step 1) + our margin deposit (Step 2), with a single entry point and clear UX.

---

## 4. How to implement

### 4.1 User flow

1. **Entry**: User is on **Base** (or we switch them). New CTA: e.g. **“Deposit from Base into margin”** (or “Bridge & add to margin”).
2. **Input**: User selects:
   - Source: token on Base (ETH, USDC, etc.) + amount.
   - Target: **pool** (e.g. SUI_USDC) and **margin manager** (if they have one) or “Create one when needed.”
3. **Step 1 – LI.FI**: 
   - `fromChain` = Base (8453), `toChain` = Sui (9270000000000000).
   - `fromToken` / `toToken`: map to pool’s quote (e.g. USDC) or base (SUI) as needed; `toAddress` = **user’s Sui address**.
   - Get quote (reuse existing `fetchLifiQuote`), send tx via embedded wallet, poll `fetchLifiStatus` until `DONE` (or `FAILED`).
4. **Step 2 – Margin** (after bridge DONE):
   - Show: “Bridge complete. Add X USDC to margin?”
   - Call existing `depositMarginViaBackend` with:
     - `sender` = same user’s Sui address,
     - `marginManagerId` / `poolKey` / `asset` / `amount` (amount can be “all received” or user-confirmed).
   - User signs **Sui** intent (existing flow); backend executes via `execute-transfer`.

If the user has **no margin manager** yet: after bridge, first create one (existing create-margin-manager flow), then deposit (or combine create+deposit in one Sui tx if the SDK allows).

### 4.2 Technical details

- **LI.FI**  
  - Keep using `GET /quote` (or `/advanced/routes` if we want multi-step routes on the bridge side).  
  - Sui chain ID: `9270000000000000`.  
  - Destination token: Sui USDC (or SUI) coin type / address per [LI.FI Sui docs](https://docs.li.fi/introduction/lifi-architecture/sui-overview) and our `config/preferred-chains-tokens.json`.

- **Backend**  
  - No change required for Composer (we’re not using the Composer VM).  
  - Keep: `prepare-margin-deposit`, `execute-transfer`, and (if needed) create-margin-manager.

- **App**  
  - New flow/screen or modal: “Deposit from Base into margin.”
  - Reuse: `fetchLifiQuote`, `fetchLifiStatus`, existing Base send tx path, `depositMarginViaBackend`, Sui wallet linking/signing.

### 4.3 Edge cases

- **User has no Sui wallet linked**: Show message “Link a Sui wallet to add funds to margin” and deep link to wallet linking.
- **User has no margin manager**: After bridge, run create-margin-manager then deposit (or one Sui tx if supported).
- **Bridge fails**: Show LI.FI status; no margin step. Same as current send flow.
- **Slippage**: Use same slippage as current LI.FI send (e.g. 0.5%); optionally show received amount before “Add to margin.”

---

## 5. Prize narrative

- **Multi-step DeFi workflow**: Bridge (Base → Sui) + open/add to DeepBook margin position.
- **Single user experience**: One entry point, one intent (“Deposit from Base into margin”), minimal steps after bridge.
- **LI.FI usage**: LI.FI is the only cross-chain leg; we compose the rest with our backend and Sui signing.
- **Differentiator**: “Turn any asset on Base into a DeepBook margin position on Sui” with no Composer support for Sui — we still deliver the prize example’s intent via orchestration.

---

## 6. References

- [LI.FI Composer](https://docs.li.fi/introduction/user-flows-and-examples/lifi-composer) (EVM-only; no Sui).
- [LI.FI Sui](https://docs.li.fi/introduction/lifi-architecture/sui-overview) (bridge and same-chain swaps on Sui).
- [End-to-end transaction example](https://docs.li.fi/introduction/user-flows-and-examples/end-to-end-example) (quote → allowance → send → status).
- Our: `lib/lifi-quote.ts`, `lib/margin-deposit-withdraw-via-backend.ts`, `backend/src/sui/prepare-margin-deposit.ts`.
