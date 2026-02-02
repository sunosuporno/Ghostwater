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

/** Coin types (native USDC). */
export const COIN_TYPES_MAINNET = {
  SUI: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  USDC: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  DEEP: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
  WAL: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
} as const;
