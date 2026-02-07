/**
 * Constants for the "Base → Lido on Ethereum mainnet" (wstETH) flow.
 * Used with LI.FI quote/execute: toChain = ETH_MAINNET_CHAIN_ID, toToken = LIDO_WSTETH_MAINNET.
 */

/** Ethereum mainnet chain id (LI.FI / EVM). */
export const ETH_MAINNET_CHAIN_ID = 1;

/**
 * Lido wstETH (Wrapped staked ETH) on Ethereum mainnet.
 * Use as toToken when requesting a quote for "deposit into Lido on mainnet."
 * @see https://etherscan.io/address/0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0
 */
export const LIDO_WSTETH_MAINNET = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
