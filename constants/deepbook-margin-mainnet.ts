/**
 * DeepBook Margin mainnet integration reference.
 * Source: DeepBook Margin Mainnet Integration doc (last update Jan 13, 2026).
 * Doc: https://docs.google.com/document/d/11h3IIa7gojkh1qvaezb50f5WH4jDoidGMHj1QUqbD14/edit
 *
 * Official docs: https://docs.sui.io/standards/deepbook-margin
 * SDK: https://www.npmjs.com/package/@mysten/deepbook-v3
 *
 * All references to USDC refer to native USDC.
 */

/** Mainnet margin package (VERSION 1). */
export const MARGIN_PACKAGE_ID_MAINNET =
  "0x97d9473771b01f77b0940c589484184b49f6444627ec121314fae6a6d36fb86b";

/** Mainnet margin registry. */
export const MARGIN_REGISTRY_ID_MAINNET =
  "0x0e40998b359a9ccbab22a98ed21bd4346abf19158bc7980c8291908086b3a742";

/**
 * Supported margin pairs on mainnet (from integration doc).
 * SUI_USDC: 5x leverage; WAL_USDC, DEEP_USDC: 3x leverage.
 */
export const SUPPORTED_MARGIN_PAIRS_MAINNET = [
  "DEEP_USDC",
  "SUI_USDC",
  "WAL_USDC",
] as const;

export type SupportedMarginPairMainnet =
  (typeof SUPPORTED_MARGIN_PAIRS_MAINNET)[number];

/**
 * Minimum deposit/withdraw amount in human units (same for all tokens).
 * Decimals are handled by the SDK (amount * coin.scalar); we always pass human
 * amount (e.g. 0.01 = 0.01 USDC, 0.01 SUI, 0.01 DEEP). Not from protocol docs.
 */
export const MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT = 0.01;

/**
 * Max leverage per pool (from integration doc). Used to show max position size.
 * SUI_USDC: 5x; DEEP_USDC, WAL_USDC: 3x.
 */
export const MAX_LEVERAGE_BY_POOL_MAINNET: Record<
  SupportedMarginPairMainnet,
  number
> = {
  SUI_USDC: 5,
  DEEP_USDC: 3,
  WAL_USDC: 3,
};

/** Get max leverage for a pool key (mainnet). Returns 3 if unknown. */
export function getMaxLeverageForPool(poolKey: string): number {
  const key = poolKey.toUpperCase() as SupportedMarginPairMainnet;
  return MAX_LEVERAGE_BY_POOL_MAINNET[key] ?? 3;
}

/** Coin types (native USDC). */
export const COIN_TYPES_MAINNET = {
  SUI: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  USDC: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  DEEP: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
  WAL: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
} as const;

/** Decimals per coin type (for human-readable amount display and validation). */
export const COIN_DECIMALS_MAINNET: Record<
  keyof typeof COIN_TYPES_MAINNET,
  number
> = {
  SUI: 9,
  USDC: 6,
  DEEP: 6,
  WAL: 9,
};

/** Get decimals for a full coin type string (e.g. from indexer asset_type). Returns 9 if unknown. */
export function getDecimalsForCoinType(coinType: string): number {
  const n = coinType?.toLowerCase().trim() ?? "";
  if (n.includes("usdc")) return 6;
  if (n.includes("::sui::")) return 9;
  if (n.includes("deep")) return 6;
  if (n.includes("wal")) return 9;
  return 9;
}
