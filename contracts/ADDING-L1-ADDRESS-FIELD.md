# Adding an Extra Field for L1 Addresses (e.g. Sui)

## Current State

- **Storage:** ENS L2 **text records** on the subdomain node (key/value strings). No custom storage in the registrar beyond `addressToNode` and `addressToLabel`.
- **Two preference keys:**
  - `com.ghostwater.preferredChain` (e.g. `"Base"`, `"Arbitrum"`)
  - `com.ghostwater.preferredToken` (e.g. `"USDC"`, or a contract address)
- **Contract:** `GhostwaterRegistrar.sol` exposes:
  - `register(label)` — claim only
  - `registerWithPreferences(label, preferredChain, preferredToken)` — claim + set both text records
  - `setPreferences(preferredChain, preferredToken)` — update both (caller must have claimed)

The registry’s `setText(node, key, value)` is used for each preference; adding another preference is just another key and one more `_setTextRecord` call.

---

## What Adding an L1 Address Field Means

Example: store a **Sui receive address** so that when someone sends to a subdomain and the recipient’s preferred chain is Sui, the app can pass a valid `toAddress` to LI.FI.

Options:

1. **One generic key**  
   e.g. `com.ghostwater.preferredL1Address` — one string (e.g. Sui address). Simple; if you later add other L1s you could use the same key for “primary L1 address” or encode multiple in one string (not ideal).

2. **One key per L1**  
   e.g. `com.ghostwater.suiAddress`, `com.ghostwater.aptosAddress`, … — clearer and extensible; add more keys as you add chains.

Recommendation: **one key per L1** (e.g. Sui first: `com.ghostwater.suiAddress`). Same pattern as chain + token; easy to add more later.

---

## Work Required

### 1. Contracts (low effort)

- **No new state variables.** Still only ENS text records.
- Add a new constant, e.g. `SUI_ADDRESS_KEY = "com.ghostwater.suiAddress"`.
- In **GhostwaterRegistrar.sol**:
  - `registerWithPreferences(label, preferredChain, preferredToken, suiAddress)`  
    - Add one `string calldata suiAddress` and one `_setTextRecord(node, SUI_ADDRESS_KEY, suiAddress)` (allow `""` if not used).
  - `setPreferences(preferredChain, preferredToken, suiAddress)`  
    - Same: add param and one `_setTextRecord(node, SUI_ADDRESS_KEY, suiAddress)`.
- **Redeploy** the registrar (or deploy a new one and point the app to it). Existing subdomains keep working; they just have no value for the new key until they call `setPreferences` again (or you run a one-off script to set it).

**Rough size:** ~10–15 lines in the contract.

### 2. App – ENS subdomain lib (`lib/ens-subdomain-base.ts`)

- Add the new key constant and **read** it in `fetchSubdomainStatus` (one more `registry.read.text([node, SUI_ADDRESS_KEY])`).
- Add to **SubdomainStatus**: e.g. `suiAddress: string | null`.
- **REGISTRAR_ABI:** add the new parameter to `setPreferences` and `registerWithPreferences` in the ABI.
- **Calldata helpers:**  
  - `getSetPreferencesCalldata(preferredChain, preferredToken, suiAddress)`  
  - `getRegisterWithPreferencesCalldata(label, preferredChain, preferredToken, suiAddress)`  
  Both get one extra argument (use `""` when not applicable).

**Rough size:** ~20–30 lines.

### 3. App – UI (claim + edit preferences)

- **Claim flow:** When user selects preferred chain “Sui”, show an optional “Sui receive address” input; pass it (or `""`) into `getRegisterWithPreferencesCalldata`.
- **Edit preferences:** Same: when preferred chain is Sui, show Sui address field; pass it into `getSetPreferencesCalldata`.
- Validation: if chain is Sui and you want to require it, validate Sui address format before submit.

**Rough size:** one optional input + conditional visibility and wiring (~30–50 lines depending on existing form structure).

### 4. Send flow (LI.FI)

- When building the LI.FI quote for **Sui** destination, use `subdomainStatus.suiAddress` (if present) as `toAddress` instead of omitting it. If `suiAddress` is null/empty, keep current behavior (omit `toAddress`).

**Rough size:** a few lines in the send/subdomain branch.

### 5. Tests

- **Fork tests:** Update calls to `setPreferences` and `registerWithPreferences` to pass the new argument (e.g. `""`). Optionally add a test that sets and reads the new text record.

**Rough size:** ~5–10 lines.

---

## Summary

| Layer              | Effort   | Notes                                                                 |
|--------------------|----------|-----------------------------------------------------------------------|
| **Contract**       | Low      | 1 new constant, 1 extra string param in 2 functions, 1 extra setText. |
| **ENS lib (read)** | Low      | 1 more text read, 1 field on SubdomainStatus, ABI + calldata updates. |
| **UI (claim/edit)**| Medium   | One optional Sui address input and wiring.                            |
| **Send (LI.FI)**   | Trivial  | Use `suiAddress` as `toAddress` when destination is Sui.              |
| **Tests**          | Low      | Extra argument in existing tests; optional new test.                  |

No storage layout change, no migration. You only need a **registrar redeploy** (or new deployment + app env update) and then app + UI changes. Total is on the order of **~1–2 hours** for someone familiar with the codebase, plus deploy and any product decisions (e.g. required vs optional Sui address when chain is Sui).
