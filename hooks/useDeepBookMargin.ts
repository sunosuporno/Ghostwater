import {
  fetchCollateralEvents,
  fetchLoanBorrowed,
  fetchLoanRepaid,
  fetchLiquidation,
  fetchMarginManagerStates,
  fetchMarginManagersInfo,
  fetchOhlcv,
  fetchTicker,
  fromPythRaw,
  type CollateralEvent,
  type LiquidationEvent,
  type LoanBorrowedEvent,
  type LoanRepaidEvent,
  type MarginManagerInfo,
  type MarginManagerState,
  type OhlcvCandle,
  type OhlcvInterval,
  type TickerEntry,
} from '@/lib/deepbook-indexer';
import {
  getStoredMarginManager,
  setStoredMarginManager,
  type StoredMarginManager,
} from '@/lib/margin-manager-storage';
import { useCallback, useEffect, useState } from 'react';

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
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load pools');
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

const PRICE_POLL_MS = 5000;
const CHART_POLL_MS = 5000;

/** All pairs with last_price (DeepBookV3 /ticker). Polls for live updates. */
export function useTicker(refreshIntervalMs: number = PRICE_POLL_MS) {
  const [ticker, setTicker] = useState<Record<string, TickerEntry>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    fetchTicker()
      .then(setTicker)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load prices'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    refetch();
    const id = setInterval(refetch, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refetch, refreshIntervalMs]);

  return { ticker, loading, error, refetch };
}

/** Fetch current price for a pool (no margin account needed). Polls for live updates. */
export function usePoolPrice(
  deepbookPoolId: string | null,
  options: { refreshIntervalMs?: number } = {}
) {
  const { refreshIntervalMs = PRICE_POLL_MS } = options;
  const [price, setPrice] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<{ base: string; quote: string } | null>(null);
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
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load price'))
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

/** Fetch OHLCV candlestick data for a DeepBookV3 pool. Polls for live chart updates. */
export function useOhlcv(
  poolName: string | null,
  params: { interval?: OhlcvInterval; limit?: number; refreshIntervalMs?: number } = {}
) {
  const { interval = '1h', limit = 168, refreshIntervalMs = CHART_POLL_MS } = params;
  const [candles, setCandles] = useState<OhlcvCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback((isInitial = false) => {
    if (!poolName) return;
    if (isInitial) setLoading(true);
    fetchOhlcv(poolName, { interval, limit })
      .then((res) => setCandles(res.candles ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load chart'))
      .finally(() => setLoading(false));
  }, [poolName, interval, limit]);

  useEffect(() => {
    if (!poolName) {
      setCandles([]);
      setLoading(false);
      setError(null);
      return;
    }
    setError(null);
    refetch(true);
    const id = setInterval(() => refetch(false), refreshIntervalMs);
    return () => clearInterval(id);
  }, [poolName, refetch, refreshIntervalMs]);

  return { candles, loading, error, refetch };
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

  useEffect(() => {
    if (!marginManagerId || !deepbookPoolId) {
      setState(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMarginManagerStates({ deepbook_pool_id: deepbookPoolId })
      .then((list) => {
        if (cancelled) return;
        const mine = list.find((s) => s.margin_manager_id === marginManagerId) ?? null;
        setState(mine);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load state');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [marginManagerId, deepbookPoolId]);

  return { state, loading, error };
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

  useEffect(() => {
    if (!marginManagerId || !baseMarginPoolId || !quoteMarginPoolId) {
      setCollateral([]);
      setBorrowed([]);
      setRepaid([]);
      setLiquidations([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const limit = HISTORY_LIMIT;
    Promise.all([
      fetchCollateralEvents({ margin_manager_id: marginManagerId, limit }),
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
    ])
      .then(([col, bBase, bQuote, rBase, rQuote, liqBase, liqQuote]) => {
        if (cancelled) return;
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
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [marginManagerId, baseMarginPoolId, quoteMarginPoolId]);

  return { collateral, borrowed, repaid, liquidations, loading, error };
}

/** Approximate collateral USD from state (base * basePrice + quote * quotePrice with Pyth decimals). */
export function collateralUsdFromState(s: MarginManagerState | null): string {
  if (!s) return '0';
  const baseVal =
    (Number(s.base_asset) / 10 ** s.base_pyth_decimals) *
    (s.base_pyth_price / 10 ** s.base_pyth_decimals);
  const quoteVal =
    (Number(s.quote_asset) / 10 ** s.quote_pyth_decimals) *
    (s.quote_pyth_price / 10 ** s.quote_pyth_decimals);
  const sum = baseVal + quoteVal;
  return sum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Approximate debt USD from state. */
export function debtUsdFromState(s: MarginManagerState | null): string {
  if (!s) return '0';
  const baseDebt =
    (Number(s.base_debt) / 10 ** s.base_pyth_decimals) *
    (s.base_pyth_price / 10 ** s.base_pyth_decimals);
  const quoteDebt =
    (Number(s.quote_debt) / 10 ** s.quote_pyth_decimals) *
    (s.quote_pyth_price / 10 ** s.quote_pyth_decimals);
  const sum = baseDebt + quoteDebt;
  return sum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export { fromPythRaw };
export type { MarginManagerInfo, MarginManagerState };
