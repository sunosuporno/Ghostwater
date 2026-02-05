/**
 * DeepBook Margin + DeepBookV3 Indexer API (mainnet).
 * Same base URL for margin and V3 (OHLCV, ticker, etc.).
 * @see https://docs.sui.io/standards/deepbook-margin-indexer
 * @see https://docs.sui.io/standards/deepbookv3-indexer
 *
 * There is no dedicated "open position" endpoint. Position details are derived from:
 *   - GET /margin_manager_states → size (base_asset - base_debt), current_price, risk_ratio
 *   - GET /trades (maker/taker filter) → direction (long/short from last trade), entry (VWAP), realized PnL
 * When trade history is missing or delayed, we still show size and side (inferred from sign of net base).
 *
 * DeepBookV3 endpoints we use:
 *   GET /ticker                    → fetchTicker()        (price every 5s)
 *   GET /ohclv/:pool_name          → fetchOhlcv()         (chart candles)
 *   GET /orders/:pool/:balance_id  → fetchOrders()       (open + recent orders)
 *   GET /trades/:pool_name         → fetchTrades()       (executed trades for trade history / PnL)
 *   GET /order_updates/:pool_name  (placed/canceled in time range; alternative to /orders)
 *   GET /orderbook/:pool_name      (bids/asks; could add live order book)
 *   GET /get_pools                 (pool list; we use margin_managers_info instead)
 *   GET /summary                   (pair summary; we use /ticker + margin state)
 */

const INDEXER_BASE = "https://deepbook-indexer.mainnet.mystenlabs.com";
const INDEXER_TIMEOUT_MS = 25_000;
const INDEXER_RETRY_DELAY_MS = 2_000;

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

function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function getOnce<T>(
  path: string,
  params?: Query,
  signal?: AbortSignal
): Promise<T> {
  const url = buildUrl(path, params);
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const msg =
      res.status === 504
        ? "Indexer timed out. Tap ⟳ to try again."
        : `Indexer ${res.status}: ${res.statusText}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string, params?: Query): Promise<T> {
  const attempt = (abort: AbortController): Promise<T> => {
    const timeoutId = setTimeout(() => abort.abort(), INDEXER_TIMEOUT_MS);
    return getOnce<T>(path, params, abort.signal).finally(() =>
      clearTimeout(timeoutId)
    );
  };
  try {
    return await attempt(new AbortController());
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === "AbortError";
    const statusMatch =
      e instanceof Error ? e.message.match(/Indexer (\d+)/)?.[1] ?? "" : "";
    const isRetryable =
      isTimeout ||
      (e instanceof Error &&
        (e.message.includes("timed out") ||
          isRetryableStatus(Number(statusMatch))));
    if (!isRetryable) throw e;
    await new Promise((r) => setTimeout(r, INDEXER_RETRY_DELAY_MS));
    try {
      return await attempt(new AbortController());
    } catch (retryErr) {
      if (retryErr instanceof Error && retryErr.name === "AbortError")
        throw new Error("Indexer timed out. Tap ⟳ to try again.");
      throw retryErr;
    }
  }
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

/** Margin manager creation event; includes balance_manager_id used by DeepBookV3 /orders. */
export interface MarginManagerCreatedEvent {
  event_digest: string;
  digest: string;
  sender: string;
  checkpoint: number;
  checkpoint_timestamp_ms: number;
  package: string;
  margin_manager_id: string;
  balance_manager_id: string;
  deepbook_pool_id: string;
  owner: string;
  onchain_timestamp: number;
}

/** Order from DeepBookV3 indexer GET /orders/:pool_name/:balance_manager_id. */
export interface DeepBookOrder {
  order_id: string;
  balance_manager_id: string;
  type: string;
  current_status: string;
  price: number;
  placed_at: number;
  last_updated_at: number;
  original_quantity: number;
  filled_quantity: number;
  remaining_quantity: number;
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

/**
 * Fetch all collateral events (base, quote, and DEEP) by calling the indexer
 * with is_base=true, is_base=false, and no is_base, then merging and deduping.
 * The indexer filters by is_base (base vs quote); for pools like DEEP_USDC,
 * base = DEEP and quote = USDC. Some indexer versions may only return DEEP
 * when is_base is omitted, so we fetch all three and merge.
 */
export async function fetchAllCollateralEvents(params: {
  margin_manager_id: string;
  limit?: number;
  start_time?: number;
  end_time?: number;
}): Promise<CollateralEvent[]> {
  const limit = params.limit ?? 20;
  const common = {
    margin_manager_id: params.margin_manager_id,
    limit: limit * 2,
    start_time: params.start_time,
    end_time: params.end_time,
  };
  const [baseEvents, quoteEvents, noFilterEvents] = await Promise.all([
    fetchCollateralEvents({ ...common, is_base: true }),
    fetchCollateralEvents({ ...common, is_base: false }),
    fetchCollateralEvents(common),
  ]);
  const byDigest = new Map<string, CollateralEvent>();
  for (const e of [...baseEvents, ...quoteEvents, ...noFilterEvents]) {
    if (e.event_digest && !byDigest.has(e.event_digest)) {
      byDigest.set(e.event_digest, e);
    }
  }
  const merged = Array.from(byDigest.values()).sort(
    (a, b) =>
      (b.checkpoint_timestamp_ms ?? 0) - (a.checkpoint_timestamp_ms ?? 0)
  );
  return merged.slice(0, limit);
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

/** Unix seconds for ~1 month ago (used so margin_manager_created returns events beyond 24h default). */
const ONE_MONTH_AGO_UNIX =
  Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

/**
 * Get margin manager creation event(s) for a margin manager. Used to resolve
 * balance_manager_id for the DeepBookV3 /orders endpoint.
 * Uses start_time ~1 month ago so managers created more than 24h ago are found.
 * @see https://docs.sui.io/standards/deepbook-margin-indexer (Get margin manager creation events)
 */
export async function fetchMarginManagerCreated(params: {
  margin_manager_id: string;
  limit?: number;
  start_time?: number;
  end_time?: number;
}): Promise<MarginManagerCreatedEvent[]> {
  const q: Query = {
    margin_manager_id: params.margin_manager_id,
    limit: params.limit ?? 10,
    start_time: params.start_time ?? ONE_MONTH_AGO_UNIX,
  };
  if (params.end_time != null) q.end_time = params.end_time;
  const raw = await get<MarginManagerCreatedEvent[] | unknown>(
    "/margin_manager_created",
    q
  );
  const list = Array.isArray(raw) ? raw : [];
  if (__DEV__ && list.length === 0) {
    console.log("[fetchMarginManagerCreated] no events for margin_manager_id", {
      margin_manager_id: params.margin_manager_id.slice(0, 18) + "…",
      start_time: q.start_time,
      url: buildUrl("/margin_manager_created", q),
    });
  } else if (__DEV__ && list.length > 0) {
    console.log("[fetchMarginManagerCreated] found", list.length, "event(s), balance_manager_id", list[0].balance_manager_id?.slice(0, 18) + "…");
  }
  return list;
}

/**
 * Get orders for a balance manager in a pool (DeepBookV3 indexer). Use
 * fetchMarginManagerCreated first to get balance_manager_id from margin_manager_id.
 * @see https://docs.sui.io/standards/deepbookv3-indexer (Get orders by balance manager)
 */
export async function fetchOrders(params: {
  pool_name: string;
  balance_manager_id: string;
  limit?: number;
  status?: string; // e.g. "Placed" or "Placed,Canceled,Filled"
}): Promise<DeepBookOrder[]> {
  const path = `/orders/${encodeURIComponent(
    params.pool_name
  )}/${encodeURIComponent(params.balance_manager_id)}`;
  const q: Query = {};
  if (params.limit != null) q.limit = params.limit;
  if (params.status != null && params.status !== "") q.status = params.status;
  const raw = await get<DeepBookOrder[] | unknown>(path, q);
  return Array.isArray(raw) ? raw : [];
}

/** Executed trade from DeepBookV3 GET /trades/:pool_name. Timestamp in ms. */
export interface DeepBookTrade {
  event_digest: string;
  digest: string;
  trade_id: string;
  maker_order_id: string;
  taker_order_id: string;
  maker_balance_manager_id: string;
  taker_balance_manager_id: string;
  price: number;
  base_volume: number;
  quote_volume: number;
  timestamp: number;
  type: "buy" | "sell";
  taker_is_bid: boolean;
  taker_fee: number;
  maker_fee: number;
  taker_fee_is_deep: boolean;
  maker_fee_is_deep: boolean;
}

/**
 * Get recent trades in a pool. Optional maker_balance_manager_id or
 * taker_balance_manager_id to filter by user (pass both to get all trades for that user).
 * @see https://docs.sui.io/standards/deepbookv3-indexer (Get trades)
 */
export async function fetchTrades(params: {
  pool_name: string;
  limit?: number;
  start_time?: number;
  end_time?: number;
  maker_balance_manager_id?: string;
  taker_balance_manager_id?: string;
}): Promise<DeepBookTrade[]> {
  const path = `/trades/${encodeURIComponent(params.pool_name)}`;
  const q: Query = {};
  if (params.limit != null) q.limit = params.limit;
  if (params.start_time != null) q.start_time = params.start_time;
  if (params.end_time != null) q.end_time = params.end_time;
  if (
    params.maker_balance_manager_id != null &&
    params.maker_balance_manager_id !== ""
  )
    q.maker_balance_manager_id = params.maker_balance_manager_id;
  if (
    params.taker_balance_manager_id != null &&
    params.taker_balance_manager_id !== ""
  )
    q.taker_balance_manager_id = params.taker_balance_manager_id;
  const fullUrl = buildUrl(path, q);
  if (__DEV__) console.log("[fetchTrades] API call:", fullUrl);
  const raw = await get<DeepBookTrade[] | unknown>(path, q);
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
  const text = await res.text();
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    console.warn(
      "[OHLCV debug] response is not JSON (status",
      res.status,
      "). First 200 chars:",
      text.slice(0, 200)
    );
    throw parseErr;
  }
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
