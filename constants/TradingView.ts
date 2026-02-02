/**
 * TradingView Advanced Charts (Charting Library) config.
 * No API key; you host the library yourself after requesting access from TradingView.
 * @see https://www.tradingview.com/charting-library-docs/latest/getting_started/
 */

/**
 * URL to the folder containing charting_library (e.g. https://your-host.com/charting_library/).
 * Request access at tradingview.com, host the library, then set this (or EXPO_PUBLIC_TRADINGVIEW_LIBRARY_PATH).
 * Leave empty to show the "set library path" message in the app.
 */
export const TRADINGVIEW_CHARTING_LIBRARY_PATH: string =
  typeof process !== "undefined" &&
  process.env?.EXPO_PUBLIC_TRADINGVIEW_LIBRARY_PATH
    ? process.env.EXPO_PUBLIC_TRADINGVIEW_LIBRARY_PATH
    : "";
