/**
 * Fetch SUI balance via JSON-RPC only. No @mysten/sui — safe to use on React Native
 * where @mysten/sui/jsonRpc can throw "Cannot read property 'prototype' of undefined".
 */

const MAINNET_RPC = "https://fullnode.mainnet.sui.io";

/** Parse response body as JSON; avoid "Unexpected character" when RPC returns HTML or plain text. */
function parseJsonResponse(text: string, context: string): unknown {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) throw new Error(`${context}: empty response`);
  if (trimmed.startsWith("<") || trimmed.toLowerCase().startsWith("<!doctype"))
    throw new Error(`${context}: server returned HTML instead of JSON`);
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${context}: invalid response (${msg})`);
  }
}

export async function fetchSuiBalance(
  owner: string,
  coinType: string = "0x2::sui::SUI"
): Promise<{ totalBalance: string; coinType: string }> {
  const res = await fetch(MAINNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "suix_getBalance",
      params: [owner, coinType],
      id: 1,
    }),
  });
  const text = await res.text();
  const json = parseJsonResponse(text, "Sui balance") as {
    error?: { message?: string };
    result?: { totalBalance?: string; coinType?: string };
  };
  if (json.error) {
    throw new Error(json.error.message ?? "RPC error");
  }
  const result = json.result;
  return {
    totalBalance: result?.totalBalance ?? "0",
    coinType: result?.coinType ?? coinType,
  };
}

/** Single balance from suix_getAllBalances */
export type SuiBalanceItem = {
  coinType: string;
  coinObjectCount: number;
  totalBalance: string;
  lockedBalance?: Record<string, unknown>;
};

/** Sui coin metadata from suix_getCoinMetadata (decimals from chain). */
type SuiCoinMetadata = {
  decimals?: number;
  symbol?: string;
  name?: string;
  description?: string;
  iconUrl?: string;
  id?: string;
};

/** Fallback when suix_getCoinMetadata is missing or fails (e.g. some tokens don't publish metadata). */
const KNOWN_COINS_FALLBACK: Record<
  string,
  { symbol: string; decimals: number }
> = {
  "0x2::sui::SUI": { symbol: "SUI", decimals: 9 },
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI":
    { symbol: "SUI", decimals: 9 },
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    { symbol: "USDC", decimals: 6 },
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP":
    { symbol: "DEEP", decimals: 6 },
};

function getSymbolAndDecimalsFallback(coinType: string): {
  symbol: string;
  decimals: number;
} {
  return (
    KNOWN_COINS_FALLBACK[coinType] ?? {
      symbol: coinType.split("::").pop() ?? coinType.slice(-8),
      decimals: 9,
    }
  );
}

/** Fetch coin metadata (decimals, symbol) from chain via suix_getCoinMetadata. */
async function fetchCoinMetadata(
  coinType: string
): Promise<SuiCoinMetadata | null> {
  try {
    const res = await fetch(MAINNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "suix_getCoinMetadata",
        params: [coinType],
        id: 1,
      }),
    });
    const text = await res.text();
    const json = parseJsonResponse(text, "Sui coin metadata") as {
      error?: unknown;
      result?: SuiCoinMetadata | null;
    };
    if (json.error || json.result == null) return null;
    return json.result as SuiCoinMetadata;
  } catch {
    return null;
  }
}

/** Format raw balance string to human-readable amount */
export function formatBalance(totalBalance: string, decimals: number): string {
  const raw = BigInt(totalBalance);
  const value = Number(raw) / Math.pow(10, decimals);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

/**
 * Fetch all coin balances for an address (suix_getAllBalances).
 * Uses each token's actual decimals from suix_getCoinMetadata when available;
 * otherwise falls back to known coins (e.g. DEEP = 6) or a safe default.
 * Returns array with totalBalance, coinType, symbol, formatted amount, and decimals.
 */
export async function fetchAllSuiBalances(owner: string): Promise<
  Array<{
    coinType: string;
    totalBalance: string;
    symbol: string;
    formatted: string;
    decimals: number;
  }>
> {
  const res = await fetch(MAINNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "suix_getAllBalances",
      params: [owner],
      id: 1,
    }),
  });
  const text = await res.text();
  const json = parseJsonResponse(text, "Sui balances") as {
    error?: { message?: string };
    result?: SuiBalanceItem[] | null;
  };
  if (json.error) {
    throw new Error(json.error.message ?? "RPC error");
  }
  const rawList = (json.result ?? []) as SuiBalanceItem[];
  // Sui RPC can return multiple entries for the same coinType (e.g. multiple coin objects). Merge by coinType.
  const byCoinType = new Map<string, SuiBalanceItem>();
  for (const item of rawList) {
    const key = item.coinType;
    const existing = byCoinType.get(key);
    if (existing) {
      const sum =
        BigInt(existing.totalBalance ?? "0") + BigInt(item.totalBalance ?? "0");
      byCoinType.set(key, {
        ...existing,
        totalBalance: sum.toString(),
        coinObjectCount: (existing.coinObjectCount ?? 0) + (item.coinObjectCount ?? 0),
      });
    } else {
      byCoinType.set(key, { ...item });
    }
  }
  const list = Array.from(byCoinType.values());
  // Fetch metadata (decimals, symbol) from chain for each coin type in parallel
  const metadataList = await Promise.all(
    list.map((item) => fetchCoinMetadata(item.coinType))
  );
  const mapped = list.map((item, i) => {
    const meta = metadataList[i];
    const fallback = getSymbolAndDecimalsFallback(item.coinType);
    const decimals =
      typeof meta?.decimals === "number" ? meta.decimals : fallback.decimals;
    const symbol =
      typeof meta?.symbol === "string" && meta.symbol.trim() !== ""
        ? meta.symbol.trim()
        : fallback.symbol;
    const formatted = formatBalance(item.totalBalance ?? "0", decimals);
    return {
      coinType: item.coinType,
      totalBalance: item.totalBalance ?? "0",
      symbol,
      formatted,
      decimals,
    };
  });
  // Sui can have multiple coin types for the same symbol (e.g. different USDC packages). Merge by symbol.
  const bySymbol = new Map<
    string,
    { coinType: string; totalBalance: string; symbol: string; formatted: string; decimals: number }
  >();
  for (const row of mapped) {
    const key = row.symbol;
    const existing = bySymbol.get(key);
    if (existing) {
      const sum =
        BigInt(existing.totalBalance) + BigInt(row.totalBalance);
      const decimals = existing.decimals;
      bySymbol.set(key, {
        coinType: existing.coinType,
        totalBalance: sum.toString(),
        symbol: existing.symbol,
        formatted: formatBalance(sum.toString(), decimals),
        decimals,
      });
    } else {
      bySymbol.set(key, { ...row });
    }
  }
  const merged = Array.from(bySymbol.values());
  // SUI first, then rest alphabetically by symbol
  const SUI_COIN_TYPE = "0x2::sui::SUI";
  return merged.sort((a, b) => {
    if (a.coinType === SUI_COIN_TYPE) return -1;
    if (b.coinType === SUI_COIN_TYPE) return 1;
    return a.symbol.localeCompare(b.symbol);
  });
}
