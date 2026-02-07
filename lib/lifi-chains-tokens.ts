/**
 * LI.FI API: chains and tokens for Swap/Bridge UI.
 * - Chains: https://li.quest/v1/chains
 * - Tokens (all chains): https://li.quest/v1/tokens
 * - Token (single): https://li.quest/v1/token?chain=&token=
 */

const LIFI_BASE = "https://li.quest/v1";
const LIFI_CHAINS_URL = `${LIFI_BASE}/chains`;
const LIFI_TOKENS_URL = `${LIFI_BASE}/tokens`;
const LIFI_TOKEN_URL = `${LIFI_BASE}/token`;

export type LifiChain = {
  key: string;
  name: string;
  chainType: string;
  coin: string;
  id: number;
  mainnet: boolean;
  logoURI?: string;
  nativeToken?: {
    address: string;
    decimals: number;
    symbol: string;
    chainId: number;
    coinKey: string;
    name: string;
    logoURI?: string;
    priceUSD?: string;
  };
};

export type LifiToken = {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
  name: string;
  coinKey: string;
  priceUSD?: string;
  logoURI?: string;
};

export type LifiChainsResponse = {
  chains: LifiChain[];
};

/** Keyed by chain id (string), e.g. "1", "8453", "137". */
export type LifiTokensByChain = Record<string, LifiToken[]>;

/** Sui chain id (LI.FI). Same as in bridge-to-margin-constants. */
export const LIFI_SUI_CHAIN_ID = 9270000000000000;

/** Solana mainnet chain id (LI.FI). */
export const LIFI_SOLANA_CHAIN_ID = 1151111081099710;

/**
 * LI.FI GET /v1/chains returns EVM chains only. Sui and Solana are supported by LI.FI
 * but not included in that response. We add them here so they appear in the Swap "To" chain list.
 */
export const EXTRA_LIFI_CHAINS: LifiChain[] = [
  {
    key: "sui",
    name: "Sui",
    chainType: "SUI",
    coin: "SUI",
    id: LIFI_SUI_CHAIN_ID,
    mainnet: true,
  },
  {
    key: "sol",
    name: "Solana",
    chainType: "SOLANA",
    coin: "SOL",
    id: LIFI_SOLANA_CHAIN_ID,
    mainnet: true,
  },
];

/**
 * Fetch all supported chains from LI.FI (EVM-only from the API).
 */
export async function fetchLifiChains(): Promise<LifiChain[]> {
  const res = await fetch(LIFI_CHAINS_URL);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LI.FI chains failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as LifiChainsResponse;
  return json.chains ?? [];
}

/**
 * Chains for the Swap "To" selector: API chains (mainnet) plus Sui and Solana.
 * Dedupes by id and sorts by name so all chains (including Sui/Solana) appear in one list.
 */
export function getSwapChains(apiChains: LifiChain[]): LifiChain[] {
  const byId = new Map<number, LifiChain>();
  for (const c of EXTRA_LIFI_CHAINS) byId.set(c.id, c);
  for (const c of apiChains.filter((c) => c.mainnet)) byId.set(c.id, c);
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetch all tokens grouped by chain id.
 * Response keys are chain ids as strings (e.g. "1", "8453").
 */
export async function fetchLifiTokens(): Promise<LifiTokensByChain> {
  const res = await fetch(LIFI_TOKENS_URL);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LI.FI tokens failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as LifiTokensByChain;
  return json ?? {};
}

/** API may return { tokens: { "42161": [...] } } or directly { "42161": [...] } */
type LifiTokensResponse = LifiTokensByChain | { tokens?: LifiTokensByChain };

/**
 * Fetch tokens for specific chain(s). Use when a chain is selected.
 * GET https://li.quest/v1/tokens?chains=42161 or ?chains=42161,1
 * Returns same shape as fetchLifiTokens but only for requested chain ids.
 */
export async function fetchLifiTokensForChains(
  chainIds: (number | string)[]
): Promise<LifiTokensByChain> {
  if (chainIds.length === 0) return {};
  const chainsParam = chainIds.map((id) => String(id)).join(",");
  const url = `${LIFI_TOKENS_URL}?chains=${encodeURIComponent(chainsParam)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LI.FI tokens failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as LifiTokensResponse;
  const byChain = json?.tokens ?? json;
  return (byChain as LifiTokensByChain) ?? {};
}

/**
 * Fetch a single token's details by chain and token (address or symbol).
 * chain: id or key of the chain (e.g. "8453" or "bas" for Base).
 * token: address or symbol of the token.
 */
export async function fetchLifiToken(
  chain: string,
  token: string
): Promise<LifiToken> {
  const search = new URLSearchParams({ chain, token });
  const url = `${LIFI_TOKEN_URL}?${search.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LI.FI token failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json() as Promise<LifiToken>;
}

/** Base mainnet chain id for LI.FI. */
export const LIFI_BASE_CHAIN_ID = 8453;

/** Native token address (EVM convention). */
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
