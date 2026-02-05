import {
  fetchAllCollateralEvents,
  fetchLiquidation,
  fetchLoanBorrowed,
  fetchLoanRepaid,
  fetchMarginManagerCreated,
  fetchMarginManagerStates,
  fetchMarginManagersInfo,
  fetchOhlcv,
  fetchOrders,
  fetchTicker,
  fetchTrades,
  fromPythRaw,
  type CollateralEvent,
  type DeepBookOrder,
  type DeepBookTrade,
  type LiquidationEvent,
  type LoanBorrowedEvent,
  type LoanRepaidEvent,
  type MarginManagerInfo,
  type MarginManagerState,
  type OhlcvCandle,
  type OhlcvInterval,
  type TickerEntry,
} from "@/lib/deepbook-indexer";
import {
  getStoredMarginManager,
  setStoredMarginManager,
  type StoredMarginManager,
} from "@/lib/margin-manager-storage";
import { fetchOwnedMarginManagers } from "@/lib/owned-margin-managers-api";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const DEFAULT_API_URL =
  typeof process !== "undefined" && process.env?.EXPO_PUBLIC_API_URL
    ? process.env.EXPO_PUBLIC_API_URL
    : "http://localhost:3001";

export type OwnedMarginManagerEntry = {
  margin_manager_id: string;
  deepbook_pool_id: string;
};

/** Fetch margin managers owned by the wallet from chain (no local storage). */
export function useOwnedMarginManagers(
  suiAddress: string | null,
  apiUrl: string = DEFAULT_API_URL,
  network: "mainnet" | "testnet" = "mainnet"
) {
  const [managers, setManagers] = useState<OwnedMarginManagerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!suiAddress) {
      setManagers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { managers: list } = await fetchOwnedMarginManagers({
        apiUrl,
        owner: suiAddress,
        network,
      });
      setManagers(list ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setManagers([]);
    } finally {
      setLoading(false);
    }
  }, [suiAddress, apiUrl, network]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { managers, loading, error, refresh };
}

const HISTORY_LIMIT = 20;

export function useMarginManagersInfo() {
  const [data, setData] = useState<MarginManagerInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMarginManagersInfo()
      .then((list) => {
        if (!cancelled) setData(list ?? []);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load pools");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { pools: data ?? [], loading, error };
}

/** Price (ticker) poll interval – top-of-book price for header and order form. */
const PRICE_POLL_MS = 5000;

type TickerContextValue = {
  ticker: Record<string, TickerEntry>;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

const TickerContext = createContext<TickerContextValue | null>(null);

/** Shared ticker provider so list and pair detail use the same data (no flash of '-' on navigate). */
export function TickerProvider({
  children,
  refreshIntervalMs = PRICE_POLL_MS,
}: {
  children: ReactNode;
  refreshIntervalMs?: number;
}) {
  const [ticker, setTicker] = useState<Record<string, TickerEntry>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    fetchTicker()
      .then(setTicker)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load prices")
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    refetch();
    if (__DEV__) {
      console.log(`[Ticker] polling prices every ${refreshIntervalMs / 1000}s`);
    }
    const id = setInterval(refetch, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refetch, refreshIntervalMs]);

  const value = useMemo(
    () => ({ ticker, loading, error, refetch }),
    [ticker, loading, error, refetch]
  );

  return React.createElement(TickerContext.Provider, { value }, children);
}

/** OHLCV poll interval (ms) per chart interval: 1m → 1 min, 1h → 1 hr, etc. */
function getOhlcvPollIntervalMs(interval: OhlcvInterval): number {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  switch (interval) {
    case "1m":
      return 1 * minute;
    case "5m":
      return 5 * minute;
    case "15m":
      return 15 * minute;
    case "30m":
      return 30 * minute;
    case "1h":
      return 1 * hour;
    case "4h":
      return 4 * hour;
    case "1d":
      return 24 * hour;
    case "1w":
      return 7 * 24 * hour;
    default:
      return minute;
  }
}

/** All pairs with last_price (DeepBookV3 /ticker). Uses shared TickerProvider when inside one (no flash of '-' on pair detail). */
export function useTicker(_refreshIntervalMs: number = PRICE_POLL_MS) {
  const ctx = useContext(TickerContext);
  if (ctx) return ctx;

  const [ticker, setTicker] = useState<Record<string, TickerEntry>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    fetchTicker()
      .then(setTicker)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load prices")
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    refetch();
    if (__DEV__) {
      console.log(
        `[Ticker] polling prices every ${_refreshIntervalMs / 1000}s`
      );
    }
    const id = setInterval(refetch, _refreshIntervalMs);
    return () => clearInterval(id);
  }, [refetch, _refreshIntervalMs]);

  return { ticker, loading, error, refetch };
}

/** Fetch current price for a pool (no margin account needed). Polls for live updates. */
export function usePoolPrice(
  deepbookPoolId: string | null,
  options: { refreshIntervalMs?: number } = {}
) {
  const { refreshIntervalMs = PRICE_POLL_MS } = options;
  const [price, setPrice] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<{
    base: string;
    quote: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    if (!deepbookPoolId) return;
    setLoading(true);
    fetchMarginManagerStates({ deepbook_pool_id: deepbookPoolId })
      .then((list) => {
        const first = list?.[0] ?? null;
        if (first) {
          setPrice(first.current_price ?? null);
          setSymbols({
            base: first.base_asset_symbol,
            quote: first.quote_asset_symbol,
          });
        } else {
          setPrice(null);
          setSymbols(null);
        }
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load price")
      )
      .finally(() => setLoading(false));
  }, [deepbookPoolId]);

  useEffect(() => {
    if (!deepbookPoolId) {
      setPrice(null);
      setSymbols(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    refetch();
    const id = setInterval(refetch, refreshIntervalMs);
    return () => clearInterval(id);
  }, [deepbookPoolId, refetch, refreshIntervalMs]);

  return { price, symbols, loading, error, refetch };
}

/** Normalize ts to seconds; API can return ms (>= 1e12) or seconds. */
function tsToSeconds(ts: number): number {
  return ts >= 1e12 ? ts / 1000 : ts;
}

/** Log OHLCV response for debugging: request params, candle count, first/last timestamps, span and gap; logs every candle. */
function logOhlcvResponse(
  poolName: string,
  interval: OhlcvInterval,
  limit: number,
  candles: OhlcvCandle[]
) {
  if (!__DEV__ || !candles.length) return;
  const sorted = [...candles].sort((a, b) => a[0] - b[0]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const tsFirst = first[0];
  const tsLast = last[0];
  const spanSec = tsToSeconds(tsLast) - tsToSeconds(tsFirst);
  const gapSec = sorted.length > 1 ? spanSec / (sorted.length - 1) : 0;
  console.log("[OHLCV] request", { poolName, interval, limit });
  console.log("[OHLCV] response", {
    candleCount: candles.length,
    firstTs: tsFirst,
    lastTs: tsLast,
    spanSeconds: Math.round(spanSec),
    spanMinutes: (spanSec / 60).toFixed(1),
    spanHours: (spanSec / 3600).toFixed(1),
    gapBetweenCandlesSeconds: gapSec.toFixed(1),
    gapBetweenCandlesMinutes: (gapSec / 60).toFixed(2),
  });
  console.log(
    "[OHLCV] all candles (sorted by ts, [ts, open, high, low, close, volume]):",
    sorted
  );
}

/** Candle timestamp to API time: indexer may expect seconds (10 digits) or ms (13 digits). We pass ms when ts is ms. */
function candleTsForEndTime(ts: number): number {
  return ts >= 1e12 ? ts : ts * 1000;
}

/** Chunk size when loading older candles on swipe (keeps fetches small and smooth). */
const OHLCV_LOAD_OLDER_CHUNK = 100;

/** Fetch OHLCV candlestick data for a DeepBookV3 pool. Polls for live chart updates. Ignores stale responses (e.g. 1h overwriting 1m). */
export function useOhlcv(
  poolName: string | null,
  params: {
    interval?: OhlcvInterval;
    /** How many candles to show in the chart (window size). Default 100 for smooth panning. */
    displayLimit?: number;
    /** How many to fetch on initial load and poll. Default 200 so we have buffer for swipes. */
    fetchLimit?: number;
    refreshIntervalMs?: number;
  } = {}
) {
  const {
    interval = "1m",
    displayLimit = 100,
    fetchLimit = 200,
    refreshIntervalMs: refreshIntervalMsParam,
  } = params;
  const refreshIntervalMs =
    refreshIntervalMsParam ?? getOhlcvPollIntervalMs(interval);
  const [candles, setCandles] = useState<OhlcvCandle[]>([]);
  const [windowStart, setWindowStart] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const candlesRef = useRef<OhlcvCandle[]>([]);
  const loadingOlderRef = useRef(false);
  candlesRef.current = candles;
  loadingOlderRef.current = loadingOlder;

  const visibleCandles = useMemo(() => {
    const sorted = [...candles].sort((a, b) => a[0] - b[0]);
    const start = Math.max(
      0,
      Math.min(windowStart, Math.max(0, sorted.length - displayLimit))
    );
    return sorted.slice(start, start + displayLimit);
  }, [candles, windowStart, displayLimit]);

  const refetch = useCallback(
    (isInitial = false) => {
      if (!poolName) return;
      const id = ++requestIdRef.current;
      if (isInitial) setLoading(true);
      fetchOhlcv(poolName, { interval, limit: fetchLimit })
        .then((res) => {
          if (id !== requestIdRef.current) return;
          if (loadingOlderRef.current) return;
          const list = res.candles ?? [];
          if (isInitial && __DEV__)
            logOhlcvResponse(poolName, interval, fetchLimit, list);
          const current = candlesRef.current;
          if (current.length > displayLimit && list.length > 0) {
            const minNew = Math.min(...list.map((c) => c[0]));
            const older = current.filter((c) => c[0] < minNew);
            const byTs = new Map<number, OhlcvCandle>();
            [...older, ...list].forEach((c) => byTs.set(c[0], c));
            const merged = Array.from(byTs.values()).sort(
              (a, b) => a[0] - b[0]
            );
            setCandles(merged);
            setWindowStart((prev) => prev + (merged.length - current.length));
          } else {
            setCandles(list);
            setWindowStart(Math.max(0, list.length - displayLimit));
          }
        })
        .catch((e) => {
          if (id !== requestIdRef.current) return;
          setError(e instanceof Error ? e.message : "Failed to load chart");
        })
        .finally(() => {
          if (id !== requestIdRef.current) return;
          setLoading(false);
        });
    },
    [poolName, interval, fetchLimit, displayLimit]
  );

  const panToLatest = useCallback(() => {
    setWindowStart(Math.max(0, candles.length - displayLimit));
  }, [candles.length, displayLimit]);

  /** Load older candles (before current oldest). Fetches OHLCV_LOAD_OLDER_CHUNK so swipes stay smooth. */
  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current) return;
    const current = candlesRef.current;
    if (!poolName || current.length === 0) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const sorted = [...current].sort((a, b) => a[0] - b[0]);
    const oldestTs = sorted[0][0];
    const endTime = candleTsForEndTime(oldestTs);
    fetchOhlcv(poolName, {
      interval,
      limit: OHLCV_LOAD_OLDER_CHUNK,
      end_time: endTime,
    })
      .then((res) => {
        const older = res.candles ?? [];
        if (older.length === 0) {
          return;
        }
        const latest = candlesRef.current;
        const byTs = new Map<number, OhlcvCandle>();
        [...older, ...latest].forEach((c) => byTs.set(c[0], c));
        const merged = Array.from(byTs.values()).sort((a, b) => a[0] - b[0]);
        setCandles(merged);
        setWindowStart(0);
      })
      .catch(() => {})
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [poolName, interval]);

  useEffect(() => {
    if (!poolName) {
      setCandles([]);
      setWindowStart(0);
      setLoading(false);
      setLoadingOlder(false);
      setError(null);
      return;
    }
    setError(null);
    setCandles([]);
    setWindowStart(0);
    refetch(true);
    if (__DEV__) {
      console.log(
        `[OHLCV] polling ${poolName} (${interval}) every ${
          refreshIntervalMs / 1000
        }s`
      );
    }
    const id = setInterval(() => refetch(false), refreshIntervalMs);
    return () => clearInterval(id);
  }, [poolName, refetch, refreshIntervalMs, interval]);

  const setWindowStartClamped = useCallback(
    (absoluteIndex: number) => {
      setWindowStart(
        Math.max(
          0,
          Math.min(absoluteIndex, Math.max(0, candles.length - displayLimit))
        )
      );
    },
    [candles.length, displayLimit]
  );

  return {
    candles: visibleCandles,
    allCandles: candles,
    windowStart,
    loading,
    loadingOlder,
    error,
    refetch,
    loadOlder,
    panToLatest,
    setWindowStartClamped,
    canPanRight: windowStart + displayLimit < candles.length,
    displayLimit,
  };
}

export function useStoredMarginManager(suiAddress: string | null) {
  const [stored, setStored] = useState<StoredMarginManager | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!suiAddress) {
      setStored(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const s = await getStoredMarginManager(suiAddress);
      setStored(s);
    } catch {
      setStored(null);
    } finally {
      setLoading(false);
    }
  }, [suiAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(
    async (data: StoredMarginManager) => {
      if (!suiAddress) return;
      await setStoredMarginManager(suiAddress, data);
      setStored(data);
    },
    [suiAddress]
  );

  return { stored, loading, refresh, save };
}

export function useMarginManagerState(
  marginManagerId: string | null,
  deepbookPoolId: string | null
) {
  const [state, setState] = useState<MarginManagerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async (): Promise<MarginManagerState | null> => {
    if (!marginManagerId || !deepbookPoolId) {
      setState(null);
      setLoading(false);
      setError(null);
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await fetchMarginManagerStates({
        deepbook_pool_id: deepbookPoolId,
      });
      const mine =
        list.find((s) => s.margin_manager_id === marginManagerId) ?? null;
      setState(mine);
      return mine;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load state");
      if (__DEV__) {
        console.warn("[Margin] Refresh state error", e);
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, [marginManagerId, deepbookPoolId]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  return { state, loading, error, refresh: fetchState };
}

export function useMarginHistory(
  marginManagerId: string | null,
  baseMarginPoolId: string | null,
  quoteMarginPoolId: string | null
) {
  const [collateral, setCollateral] = useState<CollateralEvent[]>([]);
  const [borrowed, setBorrowed] = useState<LoanBorrowedEvent[]>([]);
  const [repaid, setRepaid] = useState<LoanRepaidEvent[]>([]);
  const [liquidations, setLiquidations] = useState<LiquidationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!marginManagerId || !baseMarginPoolId || !quoteMarginPoolId) {
      setCollateral([]);
      setBorrowed([]);
      setRepaid([]);
      setLiquidations([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const limit = HISTORY_LIMIT;
    try {
      const [col, bBase, bQuote, rBase, rQuote, liqBase, liqQuote] =
        await Promise.all([
          fetchAllCollateralEvents({
            margin_manager_id: marginManagerId,
            limit,
          }),
          fetchLoanBorrowed({
            margin_manager_id: marginManagerId,
            margin_pool_id: baseMarginPoolId,
            limit,
          }),
          fetchLoanBorrowed({
            margin_manager_id: marginManagerId,
            margin_pool_id: quoteMarginPoolId,
            limit,
          }),
          fetchLoanRepaid({
            margin_manager_id: marginManagerId,
            margin_pool_id: baseMarginPoolId,
            limit,
          }),
          fetchLoanRepaid({
            margin_manager_id: marginManagerId,
            margin_pool_id: quoteMarginPoolId,
            limit,
          }),
          fetchLiquidation({
            margin_manager_id: marginManagerId,
            margin_pool_id: baseMarginPoolId,
            limit,
          }),
          fetchLiquidation({
            margin_manager_id: marginManagerId,
            margin_pool_id: quoteMarginPoolId,
            limit,
          }),
        ]);
      setCollateral(col ?? []);
      const allBorrowed = [...(bBase ?? []), ...(bQuote ?? [])].sort(
        (a, b) => b.onchain_timestamp - a.onchain_timestamp
      );
      setBorrowed(allBorrowed.slice(0, limit));
      const allRepaid = [...(rBase ?? []), ...(rQuote ?? [])].sort(
        (a, b) => b.onchain_timestamp - a.onchain_timestamp
      );
      setRepaid(allRepaid.slice(0, limit));
      const allLiq = [...(liqBase ?? []), ...(liqQuote ?? [])].sort(
        (a, b) => b.onchain_timestamp - a.onchain_timestamp
      );
      setLiquidations(allLiq);
      if (__DEV__) {
        console.log("[Margin] Refresh history result", {
          marginManagerId,
          collateralCount: (col ?? []).length,
          borrowedCount: (bBase ?? []).length + (bQuote ?? []).length,
          repaidCount: (rBase ?? []).length + (rQuote ?? []).length,
          liquidationsCount: (liqBase ?? []).length + (liqQuote ?? []).length,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
      if (__DEV__) {
        console.warn("[Margin] Refresh history error", e);
      }
    } finally {
      setLoading(false);
    }
  }, [marginManagerId, baseMarginPoolId, quoteMarginPoolId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return {
    collateral,
    borrowed,
    repaid,
    liquidations,
    loading,
    error,
    refresh: fetchHistory,
  };
}

const OPEN_ORDERS_LIMIT = 50;

/**
 * Fetches open (Placed) orders for the selected margin account. Resolves
 * balance_manager_id from margin_manager_created, then calls DeepBookV3
 * /orders/:pool_name/:balance_manager_id with status=Placed.
 */
export function useOpenOrders(
  marginManagerId: string | null,
  poolName: string | null
) {
  const [orders, setOrders] = useState<DeepBookOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!marginManagerId || !poolName || poolName.trim() === "") {
      if (__DEV__) {
        console.log("[OpenOrders] Skip: no marginManagerId or poolName", {
          marginManagerId: marginManagerId ?? null,
          poolName: poolName ?? null,
        });
      }
      setOrders([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (__DEV__)
      console.log("[OpenOrders] Fetching…", {
        poolName,
        marginManagerId: marginManagerId.slice(0, 18) + "…",
      });
    setLoading(true);
    setError(null);
    try {
      const created = await fetchMarginManagerCreated({
        margin_manager_id: marginManagerId,
        limit: 10,
      });
      // Prefer balance_manager_id from creation event; fallback to margin manager id (same object in margin flow).
      let balanceManagerId =
        created.length > 0 ? created[0].balance_manager_id : null;
      if (!balanceManagerId) {
        balanceManagerId = marginManagerId;
        if (__DEV__) {
          console.log(
            "[OpenOrders] Using margin_manager_id as balance_manager_id (no creation event)"
          );
        }
      }
      const list = await fetchOrders({
        pool_name: poolName,
        balance_manager_id: balanceManagerId,
        limit: OPEN_ORDERS_LIMIT,
        status: "Placed",
      });
      setOrders(list ?? []);
      if (__DEV__) {
        console.log("[OpenOrders] Fetched", list?.length ?? 0, "open orders", {
          poolName,
          balanceManagerId: balanceManagerId.slice(0, 18) + "…",
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load open orders");
      setOrders([]);
      if (__DEV__) {
        console.warn("[OpenOrders] Error", e);
      }
    } finally {
      setLoading(false);
    }
  }, [marginManagerId, poolName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { orders, loading, error, refresh };
}

const ORDER_HISTORY_LIMIT = 20;

/**
 * Fetches filled and canceled orders (recent order history). Market orders fill
 * immediately, so they appear here, not in open orders.
 */
export function useOrderHistory(
  marginManagerId: string | null,
  poolName: string | null
) {
  const [orders, setOrders] = useState<DeepBookOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!marginManagerId || !poolName || poolName.trim() === "") {
      if (__DEV__)
        console.log("[OrderHistory] Skip: no marginManagerId or poolName");
      setOrders([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (__DEV__) console.log("[OrderHistory] Fetching…", { poolName });
    setLoading(true);
    setError(null);
    try {
      const created = await fetchMarginManagerCreated({
        margin_manager_id: marginManagerId,
        limit: 10,
      });
      let balanceManagerId =
        created.length > 0 ? created[0].balance_manager_id : null;
      if (!balanceManagerId) balanceManagerId = marginManagerId;
      const list = await fetchOrders({
        pool_name: poolName,
        balance_manager_id: balanceManagerId,
        limit: ORDER_HISTORY_LIMIT,
        status: "Filled,Canceled",
      });
      setOrders(list ?? []);
      if (__DEV__)
        console.log("[OrderHistory] Fetched", list?.length ?? 0, "orders");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load order history");
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [marginManagerId, poolName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { orders, loading, error, refresh };
}

const TRADES_LIMIT = 30;

/** Trade with "our" side: indexer type is taker's direction; we flip when we're maker. */
export type TradeWithOurSide = DeepBookTrade & { our_side: "buy" | "sell" };

/**
 * Fetches executed trades for the margin account (GET /trades with maker and taker
 * balance_manager_id). Use for trade history and realized PnL.
 * Returns trades with our_side so UI and PnL use our perspective (buy/sell).
 * @see https://docs.sui.io/standards/deepbookv3-indexer (Get trades)
 */
export function useTrades(
  marginManagerId: string | null,
  poolName: string | null
) {
  const [trades, setTrades] = useState<TradeWithOurSide[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!marginManagerId || !poolName || poolName.trim() === "") {
      if (__DEV__)
        console.log("[Trade history] Skip: no marginManagerId or poolName", {
          marginManagerId: marginManagerId ?? null,
          poolName: poolName ?? null,
        });
      setTrades([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (__DEV__)
      console.log("[Trade history] Fetching…", {
        poolName,
        marginManagerId: marginManagerId.slice(0, 18) + "…",
      });
    setLoading(true);
    setError(null);
    try {
      const created = await fetchMarginManagerCreated({
        margin_manager_id: marginManagerId,
        limit: 10,
      });
      const balanceManagerId =
        created.length > 0 ? created[0].balance_manager_id : null;
      if (!balanceManagerId) {
        console.log(
          "[Trade history] No balance_manager_id (need it for /trades). margin_manager_created response:",
          { marginManagerId, creationEventCount: created.length, created }
        );
        setTrades([]);
        setLoading(false);
        return;
      }
      if (__DEV__)
        console.log(
          "[Trade history] balance_manager_id",
          balanceManagerId.slice(0, 18) + "…"
        );
      const oneMonthAgoSeconds = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
      const [asMaker, asTaker] = await Promise.all([
        fetchTrades({
          pool_name: poolName,
          limit: TRADES_LIMIT,
          start_time: oneMonthAgoSeconds,
          maker_balance_manager_id: balanceManagerId,
        }),
        fetchTrades({
          pool_name: poolName,
          limit: TRADES_LIMIT,
          start_time: oneMonthAgoSeconds,
          taker_balance_manager_id: balanceManagerId,
        }),
      ]);
      const byId = new Map<string, TradeWithOurSide>();
      for (const t of [...asMaker, ...asTaker]) {
        const ourSide =
          t.maker_balance_manager_id === balanceManagerId
            ? t.type === "buy"
              ? "sell"
              : "buy"
            : t.type;
        byId.set(t.trade_id, { ...t, our_side: ourSide });
      }
      const merged = Array.from(byId.values()).sort(
        (a, b) => b.timestamp - a.timestamp
      );
      console.log("[Trade history] merged trades (full):", JSON.stringify(merged, null, 2));
      setTrades(merged.slice(0, TRADES_LIMIT));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trades");
      setTrades([]);
    } finally {
      setLoading(false);
    }
  }, [marginManagerId, poolName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { trades, loading, error, refresh };
}

/** Approximate collateral USD from state (base * basePrice + quote * quotePrice with Pyth decimals). */
export function collateralUsdFromState(s: MarginManagerState | null): string {
  if (!s) return "0";
  const baseVal =
    Number(s.base_asset) * (s.base_pyth_price / 10 ** s.base_pyth_decimals);
  const quoteVal =
    Number(s.quote_asset) * (s.quote_pyth_price / 10 ** s.quote_pyth_decimals);
  const sum = baseVal + quoteVal;
  return sum.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Approximate debt USD from state. */
export function debtUsdFromState(s: MarginManagerState | null): string {
  if (!s) return "0";
  const baseDebt =
    Number(s.base_debt) * (s.base_pyth_price / 10 ** s.base_pyth_decimals);
  const quoteDebt =
    Number(s.quote_debt) * (s.quote_pyth_price / 10 ** s.quote_pyth_decimals);
  const sum = baseDebt + quoteDebt;
  return sum.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export { fromPythRaw };
export type {
  DeepBookOrder,
  DeepBookTrade,
  MarginManagerInfo,
  MarginManagerState,
};
