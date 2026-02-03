/**
 * DeepBook Margin + DeepBookV3 Indexer API (mainnet).
 * Same base URL for margin and V3 (OHLCV, ticker, etc.).
 * @see https://docs.sui.io/standards/deepbook-margin-indexer
 * @see https://docs.sui.io/standards/deepbookv3-indexer
 */

const INDEXER_BASE = "https://deepbook-indexer.mainnet.mystenlabs.com";

type Query = Record<string, string | number | boolean | undefined>;

function buildUrl(path: string, params?: Query): string {
  const url = new URL(path, INDEXER_BASE);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    });
  }
  return url.toString();
}

async function get<T>(path: string, params?: Query): Promise<T> {
  const url = buildUrl(path, params);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Indexer ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

// --- Types (from indexer docs) ---

export interface MarginManagerInfo {
  margin_manager_id: string;
  deepbook_pool_id: string;
  base_asset_id: string;
  base_asset_symbol: string;
  quote_asset_id: string;
  quote_asset_symbol: string;
  base_margin_pool_id: string;
  quote_margin_pool_id: string;
}

export interface MarginManagerState {
  id: number;
  margin_manager_id: string;
  deepbook_pool_id: string;
  base_margin_pool_id: string;
  quote_margin_pool_id: string;
  base_asset_id: string;
  base_asset_symbol: string;
  quote_asset_id: string;
  quote_asset_symbol: string;
  risk_ratio: string;
  base_asset: string;
  quote_asset: string;
  base_debt: string;
  quote_debt: string;
  base_pyth_price: number;
  base_pyth_decimals: number;
  quote_pyth_price: number;
  quote_pyth_decimals: number;
  current_price: string | null;
  lowest_trigger_above_price: string | null;
  highest_trigger_below_price: string | null;
  created_at: string;
  updated_at: string;
}

export interface CollateralEvent {
  event_digest: string;
  digest: string;
  sender: string;
  checkpoint: number;
  checkpoint_timestamp_ms: number;
  package: string;
  event_type: "Deposit" | "Withdraw";
  margin_manager_id: string;
  amount: string;
  asset_type: string;
  pyth_decimals: number;
  pyth_price: string;
  onchain_timestamp: number;
  remaining_base_asset?: string;
  remaining_quote_asset?: string;
  remaining_base_debt?: string;
  remaining_quote_debt?: string;
}

export interface LoanBorrowedEvent {
  event_digest: string;
  digest: string;
  margin_manager_id: string;
  margin_pool_id: string;
  loan_amount: number;
  loan_shares: number;
  checkpoint_timestamp_ms: number;
  onchain_timestamp: number;
}

export interface LoanRepaidEvent {
  event_digest: string;
  digest: string;
  margin_manager_id: string;
  margin_pool_id: string;
  repay_amount: number;
  repay_shares: number;
  checkpoint_timestamp_ms: number;
  onchain_timestamp: number;
}

export interface LiquidationEvent {
  event_digest: string;
  digest: string;
  margin_manager_id: string;
  margin_pool_id: string;
  liquidation_amount: number;
  pool_reward: number;
  pool_default: number;
  risk_ratio: number;
  onchain_timestamp: number;
  checkpoint_timestamp_ms: number;
}

// --- API calls ---

/**
 * Fetches all margin managers (one row per manager). Dedupe by pool to get
 * "pools that support margin". There is no dedicated "margin registry list"
 * endpoint in the Margin Indexer; this is the canonical source per docs.
 * @see https://docs.sui.io/standards/deepbook-margin-indexer (Get margin managers information)
 */
export async function fetchMarginManagersInfo(): Promise<MarginManagerInfo[]> {
  const raw = await get<MarginManagerInfo[] | unknown>("/margin_managers_info");
  return Array.isArray(raw) ? raw : [];
}

/**
 * Returns current state of margin managers. We filter by deepbook_pool_id,
 * then client-side by margin_manager_id. Note: this view can lag behind
 * collateral_events (activity) by 1–2 min; activity updates first.
 */
export async function fetchMarginManagerStates(params: {
  deepbook_pool_id?: string;
  max_risk_ratio?: number;
}): Promise<MarginManagerState[]> {
  const raw = await get<MarginManagerState[] | unknown>(
    "/margin_manager_states",
    params
  );
  return Array.isArray(raw) ? raw : [];
}

export async function fetchCollateralEvents(params: {
  margin_manager_id: string;
  type?: "Deposit" | "Withdraw";
  is_base?: boolean;
  limit?: number;
  start_time?: number;
  end_time?: number;
}): Promise<CollateralEvent[]> {
  const q: Query = { margin_manager_id: params.margin_manager_id };
  if (params.type) q.type = params.type;
  if (params.is_base !== undefined) q.is_base = params.is_base;
  if (params.limit != null) q.limit = params.limit;
  if (params.start_time != null) q.start_time = params.start_time;
  if (params.end_time != null) q.end_time = params.end_time;
  const raw = await get<CollateralEvent[] | unknown>("/collateral_events", q);
  return Array.isArray(raw) ? raw : [];
}

export async function fetchLoanBorrowed(params: {
  margin_manager_id: string;
  margin_pool_id: string;
  limit?: number;
  start_time?: number;
  end_time?: number;
}): Promise<LoanBorrowedEvent[]> {
  const raw = await get<LoanBorrowedEvent[] | unknown>(
    "/loan_borrowed",
    params
  );
  return Array.isArray(raw) ? raw : [];
}

export async function fetchLoanRepaid(params: {
  margin_manager_id: string;
  margin_pool_id: string;
  limit?: number;
  start_time?: number;
  end_time?: number;
}): Promise<LoanRepaidEvent[]> {
  const raw = await get<LoanRepaidEvent[] | unknown>("/loan_repaid", params);
  return Array.isArray(raw) ? raw : [];
}

export async function fetchLiquidation(params: {
  margin_manager_id: string;
  margin_pool_id: string;
  limit?: number;
  start_time?: number;
  end_time?: number;
}): Promise<LiquidationEvent[]> {
  const raw = await get<LiquidationEvent[] | unknown>("/liquidation", params);
  return Array.isArray(raw) ? raw : [];
}

// --- DeepBookV3: OHLCV candlestick (same indexer base URL) ---

export type OhlcvInterval =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "4h"
  | "1d"
  | "1w";

/** [timestamp, open, high, low, close, volume] – indexer returns timestamp in ms (13 digits, e.g. 1769886240000). */
export type OhlcvCandle = [number, number, number, number, number, number];

/** Indexer returns ms (13 digits) or seconds (10 digits). Normalize to ms for Date/display. */
export function ohlcvTimestampToMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export interface OhlcvResponse {
  candles: OhlcvCandle[];
}

/**
 * Get OHLCV candlestick data for a pool.
 * pool_name format: BASE_QUOTE e.g. SUI_USDC, DEEP_USDC.
 * @see https://docs.sui.io/standards/deepbookv3-indexer#get-ohlcv-candlestick-data
 */
export async function fetchOhlcv(
  poolName: string,
  params: {
    interval?: OhlcvInterval;
    limit?: number;
    start_time?: number;
    end_time?: number;
  } = {}
): Promise<OhlcvResponse> {
  const { interval = "1h", limit = 168, start_time, end_time } = params;
  const path = `/ohclv/${encodeURIComponent(poolName)}`;
  const q: Query = { interval, limit };
  if (start_time != null) q.start_time = start_time;
  if (end_time != null) q.end_time = end_time;
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log("[OHLCV] fetchOhlcv exact URL", buildUrl(path, q));
  }
  const raw = await get<OhlcvResponse | unknown>(path, q);
  if (
    raw &&
    typeof raw === "object" &&
    "candles" in raw &&
    Array.isArray((raw as OhlcvResponse).candles)
  ) {
    return raw as OhlcvResponse;
  }
  return { candles: [] };
}

/** Dummy/debug call: fetch OHLCV with given params and log raw response (for debugging timeline). */
export async function debugFetchOhlcv(
  poolName: string,
  params: { interval?: OhlcvInterval; limit?: number } = {}
): Promise<OhlcvResponse> {
  const { interval = "1m", limit = 10 } = params;
  const path = `/ohclv/${encodeURIComponent(poolName)}`;
  const url = buildUrl(path, { interval, limit });
  console.log("[OHLCV debug] GET", url);
  const res = await fetch(url);
  const raw = await res.json();
  console.log(
    "[OHLCV debug] status",
    res.status,
    "candles count",
    Array.isArray((raw as OhlcvResponse).candles)
      ? (raw as OhlcvResponse).candles.length
      : 0
  );
  console.log(
    "[OHLCV debug] raw response",
    JSON.stringify(raw, null, 2).slice(0, 2000)
  );
  const candles = (raw as OhlcvResponse).candles ?? [];
  if (candles.length >= 2) {
    const [first, second] = candles;
    const ts0 = (first as OhlcvCandle)[0];
    const ts1 = (second as OhlcvCandle)[0];
    const gapMs = ts1 - ts0;
    console.log(
      "[OHLCV debug] first 2 timestamps (raw)",
      ts0,
      ts1,
      "| gap ms",
      gapMs,
      "gap seconds",
      (gapMs / 1000).toFixed(1),
      "gap minutes",
      (gapMs / 60000).toFixed(2),
      "| API returns newest-first:",
      ts0 > ts1
    );
  }
  return raw as OhlcvResponse;
}

/** Build DeepBookV3 pool name from base/quote symbols (e.g. SUI_USDC). */
export function poolNameFromSymbols(base: string, quote: string): string {
  return `${base}_${quote}`;
}

// --- DeepBookV3: Ticker (all pairs with last price, for list + live updates) ---

export interface TickerEntry {
  last_price: number;
  base_volume: number;
  quote_volume: number;
  isFrozen: number;
}

/** GET /ticker – all trading pairs with last_price, volume. Good for list + polling. */
export async function fetchTicker(): Promise<Record<string, TickerEntry>> {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log("[Ticker] fetchTicker", buildUrl("/ticker"));
  }
  const raw = await get<Record<string, TickerEntry> | unknown>("/ticker");
  if (raw && typeof raw === "object" && raw !== null)
    return raw as Record<string, TickerEntry>;
  return {};
}

// --- Helpers for display ---

const PythDecimals = 8;

/** Convert raw Pyth amount (e.g. 100000000) to human string with decimals */
export function fromPythRaw(
  raw: string | number,
  decimals: number = PythDecimals
): string {
  const n = typeof raw === "string" ? BigInt(raw) : BigInt(Math.floor(raw));
  const d = 10 ** decimals;
  const whole = n / BigInt(d);
  const frac = n % BigInt(d);
  const fracStr =
    frac
      .toString()
      .padStart(decimals, "0")
      .slice(0, decimals)
      .replace(/0+$/, "") || "0";
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

/** Format risk_ratio string for display (e.g. "1.5" or "2.8") */
export function formatRiskRatio(riskRatio: string): string {
  const r = parseFloat(riskRatio);
  if (Number.isNaN(r)) return riskRatio;
  return r.toFixed(2);
}
