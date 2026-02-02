/**
 * Fetch SUI balance via JSON-RPC only. No @mysten/sui — safe to use on React Native
 * where @mysten/sui/jsonRpc can throw "Cannot read property 'prototype' of undefined".
 */

const MAINNET_RPC = "https://fullnode.mainnet.sui.io";

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
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message ?? "RPC error");
  }
  const result = json.result as { totalBalance: string; coinType: string };
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

/** Known coin types: symbol and decimals for display */
const KNOWN_COINS: Record<string, { symbol: string; decimals: number }> = {
  "0x2::sui::SUI": { symbol: "SUI", decimals: 9 },
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    { symbol: "USDC", decimals: 6 },
};

function getSymbolAndDecimals(coinType: string): {
  symbol: string;
  decimals: number;
} {
  return (
    KNOWN_COINS[coinType] ?? {
      symbol: coinType.split("::").pop() ?? coinType.slice(-8),
      decimals: 9,
    }
  );
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
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message ?? "RPC error");
  }
  const list = (json.result ?? []) as SuiBalanceItem[];
  const mapped = list.map((item) => {
    const { symbol, decimals } = getSymbolAndDecimals(item.coinType);
    const formatted = formatBalance(item.totalBalance ?? "0", decimals);
    return {
      coinType: item.coinType,
      totalBalance: item.totalBalance ?? "0",
      symbol,
      formatted,
      decimals,
    };
  });
  // SUI first, then rest alphabetically by symbol
  const SUI_COIN_TYPE = "0x2::sui::SUI";
  return mapped.sort((a, b) => {
    if (a.coinType === SUI_COIN_TYPE) return -1;
    if (b.coinType === SUI_COIN_TYPE) return 1;
    return a.symbol.localeCompare(b.symbol);
  });
}
