# GET /api/margin-manager-state

Single endpoint to fetch **all** Margin Manager SDK read-only data from chain. Uses `@mysten/deepbook-v3` SDK moveCalls + `devInspectTransactionBlock` and decodes return values. Also available as **GET /api/margin-borrowed-shares** (same handler).

---

## Request

| Method | URL |
|--------|-----|
| **GET** | `http://localhost:3001/api/margin-manager-state` |

(If your backend runs elsewhere, replace `localhost:3001` with your host.)

---

## Query params

| Param | Required | Description |
|-------|----------|-------------|
| **marginManagerId** | **Yes** | Margin manager object ID (e.g. `0x591c0b...1d3a3e8d`). |
| **poolKey** | **Yes** | Pool key for SDK (e.g. `SUI_USDC`, `DEEP_USDC`, `WAL_USDC`). |
| network | No | `mainnet` or `testnet`. Default: `mainnet`. |
| debug | No | `1` or `true` to include **\_debug.resultCount** in the response. |

---

## Examples

**Required params:**
```
GET http://localhost:3001/api/margin-manager-state?marginManagerId=0x...&poolKey=SUI_USDC
```

**With network and debug:**
```
GET http://localhost:3001/api/margin-manager-state?marginManagerId=0x...&poolKey=SUI_USDC&network=mainnet&debug=1
```

---

## Response (200)

Single JSON object:

```json
{
  "margin_manager_id": "0x...",
  "owner": "0x...",
  "deepbookPool": "0x...",
  "marginPoolId": "0x...",
  "borrowedShares": { "base": "0", "quote": "0" },
  "borrowedBaseShares": "0",
  "borrowedQuoteShares": "0",
  "hasBaseDebt": false,
  "balanceManager": { "id": "0x..." } | null,
  "calculateAssets": { "base_asset": "...", "quote_asset": "..." } | null,
  "calculateDebts": null,
  "source": "chain",
  "_debug": { "resultCount": 9 }
}
```

- **\_debug** is only present when `debug=1` (or `true`).
- **calculateDebts** is currently always `null` (on-chain `calculate_debts` can abort in some cases, so it is omitted for reliability).

---

## Error (400)

Missing **marginManagerId** or **poolKey**:

```json
{
  "error": "Missing required query param: poolKey (e.g. SUI_USDC)",
  "params": {
    "marginManagerId": "required — margin manager object ID (0x...)",
    "poolKey": "required — e.g. SUI_USDC",
    "network": "optional — mainnet | testnet",
    "debug": "optional — 1 | true"
  }
}
```

Other errors return `{ "error": "..." }`.
