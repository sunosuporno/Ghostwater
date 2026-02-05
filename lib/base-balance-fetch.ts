/**
 * Fetch Base Sepolia token balances using Alchemy Portfolio "Tokens By Wallet" API.
 *
 * This is safe to use in React Native – it uses plain fetch against the
 * Alchemy data API endpoint. You MUST configure an Alchemy API key in
 * EXPO_PUBLIC_ALCHEMY_API_KEY_BASE_SEPOLIA.
 */

const ALCHEMY_PORTFOLIO_BASE_URL =
  "https://api.g.alchemy.com/data/v1" as const;

type AlchemyToken = {
  address: string;
  network: string;
  tokenAddress: string | null;
  tokenBalance: string;
  tokenMetadata?: {
    decimals?: number | null;
    logo?: string | null;
    name?: string | null;
    symbol?: string | null;
  } | null;
};

type AlchemyTokensByAddressResponse = {
  data?: {
    tokens?: AlchemyToken[];
  };
};

export type BaseBalanceItem = {
  tokenAddress: string | null;
  rawBalance: string;
  symbol: string;
  name: string;
  decimals: number;
  formatted: string;
};

function formatTokenBalance(raw: string, decimals: number): string {
  if (!raw) return "0";
  try {
    const big = BigInt(raw);
    const value = Number(big) / Math.pow(10, decimals);
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    });
  } catch {
    return "0";
  }
}

/**
 * Fetch fungible token balances on Base Sepolia for a given EVM address.
 * Returns native token and ERC-20s with formatted values.
 */
export async function fetchAllBaseSepoliaBalances(
  address: string
): Promise<BaseBalanceItem[]> {
  const apiKey =
    process.env.EXPO_PUBLIC_ALCHEMY_API_KEY_BASE_SEPOLIA ??
    process.env.EXPO_PUBLIC_ALCHEMY_API_KEY ??
    "";

  if (!apiKey) {
    throw new Error(
      "Missing EXPO_PUBLIC_ALCHEMY_API_KEY_BASE_SEPOLIA (or EXPO_PUBLIC_ALCHEMY_API_KEY)."
    );
  }

  const url = `${ALCHEMY_PORTFOLIO_BASE_URL}/${encodeURIComponent(
    apiKey
  )}/assets/tokens/by-address`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [
        {
          address,
          networks: ["base-sepolia"],
        },
      ],
      withMetadata: true,
      withPrices: false,
      includeNativeTokens: true,
      includeErc20Tokens: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Alchemy portfolio error (${res.status}): ${
        text || res.statusText || "unknown error"
      }`
    );
  }

  const json = (await res.json()) as AlchemyTokensByAddressResponse;
  const tokens = json.data?.tokens ?? [];

  const balances: BaseBalanceItem[] = tokens
    .filter((t) => !!t)
    .map((t) => {
      const decimals =
        typeof t.tokenMetadata?.decimals === "number" &&
        t.tokenMetadata.decimals >= 0
          ? t.tokenMetadata.decimals
          : 18;
      const symbol =
        t.tokenMetadata?.symbol && t.tokenMetadata.symbol.trim() !== ""
          ? t.tokenMetadata.symbol.trim()
          : t.tokenAddress
          ? t.tokenAddress.slice(0, 6) + "…" + t.tokenAddress.slice(-4)
          : "ETH";
      const name =
        t.tokenMetadata?.name && t.tokenMetadata.name.trim() !== ""
          ? t.tokenMetadata.name.trim()
          : symbol;
      const formatted = formatTokenBalance(t.tokenBalance ?? "0", decimals);
      return {
        tokenAddress: t.tokenAddress,
        rawBalance: t.tokenBalance ?? "0",
        symbol,
        name,
        decimals,
        formatted,
      };
    })
    // Filter out true zero balances to keep the list small
    .filter((b) => b.rawBalance !== "0");

  // Native ETH-like token first, then others alphabetically
  return balances.sort((a, b) => {
    const isNativeA = a.tokenAddress === null;
    const isNativeB = b.tokenAddress === null;
    if (isNativeA && !isNativeB) return -1;
    if (!isNativeA && isNativeB) return 1;
    return a.symbol.localeCompare(b.symbol);
  });
}

