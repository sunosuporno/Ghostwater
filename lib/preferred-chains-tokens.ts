/**
 * Resolve preferred chain + token (from subdomain ENS) to token address and network id.
 * Uses config/preferred-chains-tokens.json.
 */

import preferredChainsTokens from "@/config/preferred-chains-tokens.json";

type ChainConfig = {
  id?: number;
  label: string;
  tokens: Record<string, string | null>;
};

type Config = Record<string, ChainConfig>;

const config = preferredChainsTokens as Config & { _comment?: string };

/** Find chain config by label (e.g. "Base", "Sui"). */
function getChainByLabel(chainLabel: string): ChainConfig | null {
  const label = chainLabel?.trim();
  if (!label) return null;
  for (const key of Object.keys(config)) {
    if (key.startsWith("_")) continue;
    const chain = config[key] as ChainConfig;
    if (chain?.label === label) return chain;
  }
  return null;
}

/**
 * Resolve recipient's preferred chain + token to the token address and network id.
 * - favouredTokenAddress: contract address, coin type (Sui), or "native" for native asset.
 * - networkId: EVM chain id (number) or "sui" for Sui.
 */
export function getRecipientPreferredTokenAddressAndNetworkId(
  chainLabel: string | null,
  tokenSymbolOrAddress: string | null
): { favouredTokenAddress: string | null; networkId: number | string | null } {
  if (!chainLabel || !tokenSymbolOrAddress) {
    return { favouredTokenAddress: null, networkId: null };
  }
  const chain = getChainByLabel(chainLabel);
  if (!chain) {
    return { favouredTokenAddress: null, networkId: null };
  }

  const tokenKey = tokenSymbolOrAddress.trim();
  // If it looks like an address (0x... or Sui coin type), use as-is
  const isCustomAddress =
    tokenKey.startsWith("0x") || (tokenKey.includes("::") && tokenKey.includes("::"));
  if (isCustomAddress) {
    const networkId = "id" in chain && typeof chain.id === "number" ? chain.id : "sui";
    return { favouredTokenAddress: tokenKey, networkId };
  }

  const tokens = chain.tokens ?? {};
  const address = tokens[tokenKey] ?? null;
  const favouredTokenAddress =
    address === null ? "native" : address;
  const networkId =
    "id" in chain && typeof chain.id === "number" ? chain.id : "sui";

  return { favouredTokenAddress, networkId };
}
