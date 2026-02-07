/**
 * Constants for the "bridge from Base → open margin position on Sui" flow.
 * Used when building LI.FI quotes and for the second step (margin deposit + order).
 */

/** Sui chain id (LI.FI / multichain). */
export const SUI_CHAIN_ID = 9270000000000000;

/** Base mainnet chain id. */
export const BASE_MAINNET_CHAIN_ID = 8453;

/**
 * When bridging from Base to Sui for the margin flow, we always receive USDC on Sui.
 * Any token sent from Base is swapped/bridged to this token on arrival.
 * LI.FI quote: toChain = SUI_CHAIN_ID, toToken = this address.
 */
export const BRIDGE_TO_MARGIN_RECEIVE_TOKEN_SUI =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/** USDC on Base mainnet. LI.FI quote Sui→Base: toToken = this. */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Default leverage for "Deposit & open position" after bridge. Not shown in UI. */
export const BRIDGE_TO_MARGIN_DEFAULT_LEVERAGE = 2;
