# Lido: Base → Ethereum Mainnet (wstETH) — Groundwork

## 1. User flow vs underneath flow

### User flow (what the user sees)

1. User is on **Base** (or we show “From: Base”).
2. User selects **source**: token (USDC or ETH) and **amount**.
3. User sees **destination**: “Lido staked ETH (wstETH) on Ethereum.”
4. User taps **“Deposit to Lido”** (or “Stake”).
5. **Sign on Base** (one or more transactions, depending on the route).
6. App shows progress: “Bridging…” then “Staking in Lido…” (or a single “Processing…”).
7. **Done**: user’s balance is now **wstETH on Ethereum mainnet** (same address as their Base wallet, but on chain id 1).

No need for the user to switch chain, sign on Ethereum, or hold ETH on mainnet for this deposit.

### Underneath flow (technical)

1. **Quote**  
   App calls LI.FI (e.g. `GET /quote` or SDK `getQuote`) with:
   - `fromChainId`: 8453 (Base)
   - `toChainId`: 1 (Ethereum mainnet)
   - `fromToken`: USDC or ETH on Base
   - `toToken`: wstETH mainnet address (`LIDO_WSTETH_MAINNET` in constants)
   - `fromAddress`: user’s Base address (EOA or smart wallet)
   - `toAddress`: **same** user address (receives wstETH on Ethereum)
   - `fromAmount`: amount in smallest units

2. **Route shape**  
   LI.FI returns a route that can look like:
   - **Step A (Base):** Swap USDC → ETH on Base (if source is USDC), then send to bridge.
   - **Step B (Bridge):** Bridge ETH from Base → Ethereum mainnet (solver/relayer delivers on mainnet).
   - **Step C (Ethereum, Composer):** Stake delivered ETH in Lido, mint wstETH, send wstETH to `toAddress`.

3. **Execution**  
   - User signs **on Base** (and possibly one more Base tx if allowance is needed).  
   - The **destination leg** (mainnet: claim + Lido stake) is executed by LI.FI’s solver/relayer; the user does not sign on Ethereum for the deposit.

4. **Outcome**  
   - User’s **Ethereum** address (same as Base if same key) holds **wstETH** on chain id 1.

---

## 2. Does Lido allow integration?

**Yes.** You don’t need permission from Lido.

- Lido is a **permissionless** protocol: anyone can call the contracts (submit ETH, receive stETH/wstETH).
- **LI.FI Composer** already lists Lido wstETH as a supported protocol, so the “integration” is:
  - You integrate with **LI.FI** (quote + execute route).
  - LI.FI’s Composer executes the Lido step on mainnet.
- You are **not** talking to Lido’s API or contracts directly; LI.FI does that. No separate Lido partnership or approval is required.

---

## 3. Where does the received wstETH live?

- **Chain:** **Ethereum mainnet** (chain id `1`). wstETH is an ERC‑20 on Ethereum only.
- **Address:** The `toAddress` you send in the quote — in our case, the **same address as the user’s Base wallet**, but **on Ethereum**.
  - Same EOA private key → same address on Base and on Ethereum (e.g. `0x123…` on Base and `0x123…` on Ethereum).
  - So: **same address, different chain.** The wstETH balance lives in that address’s Ethereum state, not on Base.
- **Implication:** To see or use wstETH, the user (or your app) must read balances and send transactions **on Ethereum mainnet** (e.g. MetaMask / wallet set to Ethereum, or your app switching to chain 1 for “Lido balance” and withdraw flows).

---

## 4. Who pays gas? Base vs Ethereum

### Deposit (Base → Lido on mainnet)

- **Base:** User signs and pays gas on Base (in ETH on Base) for the source-chain tx(s) (swap + send to bridge).
- **Ethereum:** The **destination-chain** execution (bridge claim + Composer Lido stake) is done by LI.FI’s **solver/relayer**. They front the mainnet gas; the user does **not** need ETH on Ethereum for this step.
- So for the **deposit** flow: **no need for the user to have ETH on Ethereum.** Gas on mainnet is handled by the route (solvers front it; fees may be reflected in the quote).

Reference: [LI.FI Gas Fronting](https://docs.li.fi/guides/integration-tips/gas-subsidy), [Intent-based bridges](https://li.fi/knowledge-hub/under-the-hood-of-intent-based-bridges/) (solvers front destination liquidity and gas).

### Withdraw / “Closing the stake” (later)

- To **unwrap wstETH → ETH** and/or **send back to Base**, the user must trigger a transaction **on Ethereum** (e.g. Lido redeem, then optionally a bridge).
- That Ethereum tx requires **gas on Ethereum** (ETH on mainnet). So for **withdraw**, the user **does** need ETH on Ethereum **unless** you use a flow that includes **gas fronting / refuel** (e.g. LI.FI’s “refuel” so part of the bridged amount becomes mainnet ETH for gas).
- Summary: **Deposit** = no mainnet ETH needed. **Withdraw** = user needs mainnet ETH for gas, or you use a refuel/gas-fronting option in the reverse route.

---

## Constants (for implementation)

See `constants/lido-mainnet.ts` (or equivalent):

- **Ethereum mainnet chain id:** `1`
- **wstETH on Ethereum mainnet:** `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`
- **Base chain id:** `8453` (already in `bridge-to-margin-constants.ts`)
- **USDC on Base:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (for “from token” when user selects USDC)
- **ETH on Base:** use LI.FI’s native token id for Base (e.g. zero address or their convention)

---

## Next steps (implementation)

1. Add **Lido constants** (mainnet chain id, wstETH address).
2. Add a **“To Lido”** entry point in the app (screen or modal).
3. **Quote:** Reuse existing LI.FI quote helper with `toChainId = 1`, `toToken = wstETH mainnet`, `toAddress = user’s address`.
4. **Execution:** Use LI.FI SDK `executeRoute` (or equivalent) so the Composer step is executed without hand-rolled calldata.
5. **Composer whitelist:** Request LI.FI to enable Composer for your integrator so routes return the Lido step.
6. (Later) **Withdraw flow:** Ethereum-side action (unwrap + optional bridge to Base); consider refuel so user doesn’t need existing mainnet ETH.
