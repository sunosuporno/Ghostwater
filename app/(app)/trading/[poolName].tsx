import { Text } from "@/components/Themed";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
  router,
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
} from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PriceChart } from "@/components/PriceChart";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import {
  COIN_TYPES_MAINNET,
  getDecimalsForCoinType,
  getMaxLeverageForPool,
  MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT,
  MIN_ORDER_QUANTITY,
} from "@/constants/deepbook-margin-mainnet";
import {
  debtUsdFromState,
  useMarginHistory,
  useMarginManagersInfo,
  useMarginManagerState,
  useOhlcv,
  useOpenOrders,
  useOrderHistory,
  useOwnedMarginManagers,
  useTicker,
  useTrades,
} from "@/hooks/useDeepBookMargin";
import { addTpslViaBackend } from "@/lib/add-tpsl-via-backend";
import { createMarginManagerViaBackend } from "@/lib/create-margin-manager-via-backend";
import {
  debugFetchOhlcv,
  formatRiskRatio,
  poolNameFromSymbols,
  type MarginManagerInfo,
  type OhlcvInterval,
} from "@/lib/deepbook-indexer";
import { fetchMarginBorrowedSharesViaBackend } from "@/lib/fetch-margin-borrowed-shares-via-backend";
import {
  depositMarginViaBackend,
  withdrawMarginViaBackend,
  repayViaBackend,
} from "@/lib/margin-deposit-withdraw-via-backend";
import {
  getSelectedMarginManagerId,
  setSelectedMarginManagerId,
} from "@/lib/margin-manager-storage";
import { placeOrderViaBackend } from "@/lib/place-order-via-backend";
import { getSuiAddressFromUser, getSuiWalletFromUser } from "@/lib/sui";
import { fetchSuiBalance } from "@/lib/sui-balance-fetch";
import { publicKeyToHex } from "@/lib/sui-transfer-via-backend";
import { usePrivy } from "@privy-io/expo";
import { useSignRawHash } from "@privy-io/expo/extended-chains";

const PRICE_POLL_MS = 5000;

const CHART_INTERVALS: OhlcvInterval[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
  "1w",
];
/** Candles shown in chart (smaller = smoother pan). */
const CHART_DISPLAY_LIMIT = 100;
/** Candles fetched on load/poll (buffer for swipes without data lag). */
const CHART_FETCH_LIMIT = 200;

function poolLabel(info: MarginManagerInfo): string {
  return `${info.base_asset_symbol}/${info.quote_asset_symbol}`;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** e.g. "1h 9m" or "5m" for order history age. */
function formatAge(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

function formatPairLabel(poolName: string): string {
  return poolName.replace("_", "/");
}

/** Derive display symbol from indexer asset_type (e.g. "0x...::usdc::USDC" -> "USDC"). */
function symbolFromAssetType(assetType: string): string {
  const lower = assetType.toLowerCase();
  if (lower.includes("usdc")) return "USDC";
  if (lower.includes("sui")) return "SUI";
  if (lower.includes("deep")) return "DEEP";
  if (lower.includes("wal")) return "WAL";
  const part = assetType.split("::").pop();
  return part ?? "—";
}

/** Format collateral event amount (raw string) to human amount with symbol, e.g. "0.7 USDC". Uses canonical decimals from constants. */
function formatCollateralAmount(amountRaw: string, assetType: string): string {
  const decimals = getDecimalsForCoinType(assetType);
  const value = Number(amountRaw) / Math.pow(10, decimals);
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
  return `${formatted} ${symbolFromAssetType(assetType)}`;
}

export default function PairDetailScreen() {
  const { poolName } = useLocalSearchParams<{ poolName: string }>();
  const decodedPoolName = poolName ? decodeURIComponent(poolName) : null;

  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const insets = useSafeAreaInsets();
  const { user } = usePrivy();
  const suiAddress = getSuiAddressFromUser(user);

  const { ticker } = useTicker(PRICE_POLL_MS);
  const livePrice = decodedPoolName
    ? ticker[decodedPoolName]?.last_price
    : undefined;

  const prevPriceRef = useRef<number | null>(null);
  const lastDirectionRef = useRef<"up" | "down" | null>(null);
  const priceDirection = useMemo(() => {
    if (typeof livePrice !== "number") return null;
    const prev = prevPriceRef.current;
    let dir: "up" | "down" | null = null;
    if (prev === null) {
      dir = null;
    } else if (livePrice > prev) {
      dir = "up";
      lastDirectionRef.current = "up";
    } else if (livePrice < prev) {
      dir = "down";
      lastDirectionRef.current = "down";
    } else {
      dir = lastDirectionRef.current;
    }
    prevPriceRef.current = livePrice;
    return dir;
  }, [livePrice]);

  const [chartInterval, setChartInterval] = useState<OhlcvInterval>("1m");
  const {
    candles,
    allCandles,
    loading: ohlcvLoading,
    loadingOlder: ohlcvLoadingOlder,
    error: ohlcvError,
    loadOlder: ohlcvLoadOlder,
    panToLatest,
    setWindowStartClamped,
    windowStart,
    canPanRight,
  } = useOhlcv(decodedPoolName, {
    interval: chartInterval,
    displayLimit: CHART_DISPLAY_LIMIT,
    fetchLimit: CHART_FETCH_LIMIT,
    refreshIntervalMs: 10_000, // OHLC every 10s; price (ticker) stays 5s via TickerProvider
  });

  useEffect(() => {
    if (__DEV__ && decodedPoolName) {
      debugFetchOhlcv(decodedPoolName, { interval: "1m", limit: 10 }).catch(
        (e) => console.warn("[OHLCV debug] dummy call failed", e)
      );
    }
  }, [decodedPoolName]);

  const { pools } = useMarginManagersInfo();

  // Unique pairs that support margin: /margin_managers_info returns one row per
  // margin manager; we dedupe by pool to get the set. Doc confirms mainnet has
  // exactly DEEP_USDC, SUI_USDC, WAL_USDC (see constants/deepbook-margin-mainnet).
  // @see https://docs.sui.io/standards/deepbook-margin-indexer (Get margin managers information)
  const uniquePairKeys = useMemo(() => {
    if (!pools?.length) return [];
    const keys = new Set(
      pools.map((p) =>
        poolNameFromSymbols(p.base_asset_symbol, p.quote_asset_symbol)
      )
    );
    return [...keys].sort();
  }, [pools]);

  const prevLoggedKeysRef = useRef<string>("");
  useEffect(() => {
    if (!__DEV__ || !uniquePairKeys.length) return;
    const key = uniquePairKeys.join(",");
    if (key === prevLoggedKeysRef.current) return;
    prevLoggedKeysRef.current = key;
    console.log("[Margin] Supported pairs:", uniquePairKeys.join(", "));
  }, [uniquePairKeys]);

  const poolInfoForPair = useMemo(() => {
    if (!decodedPoolName) return null;
    return (
      pools.find(
        (p) =>
          poolNameFromSymbols(p.base_asset_symbol, p.quote_asset_symbol) ===
          decodedPoolName
      ) ?? null
    );
  }, [pools, decodedPoolName]);

  const apiUrl =
    (typeof process !== "undefined" && process.env?.EXPO_PUBLIC_API_URL) ||
    "http://localhost:3001";
  const {
    managers: ownedManagers,
    loading: ownedLoading,
    refresh: refreshOwned,
  } = useOwnedMarginManagers(suiAddress, apiUrl, "mainnet");

  const poolIdForMatch = poolInfoForPair?.deepbook_pool_id?.toLowerCase();
  /** User's chosen margin manager for this pool when they have multiple (e.g. created elsewhere). */
  const [selectedMarginManagerIdForPool, setSelectedMarginManagerIdForPool] =
    useState<string | null>(null);

  // Load stored selection when wallet/pool/owned list changes
  useEffect(() => {
    if (!suiAddress || !decodedPoolName) {
      setSelectedMarginManagerIdForPool(null);
      return;
    }
    getSelectedMarginManagerId(suiAddress, decodedPoolName).then((id) => {
      setSelectedMarginManagerIdForPool(id ?? null);
    });
  }, [suiAddress, decodedPoolName, ownedManagers.length]);

  const matchesForThisPool = useMemo(() => {
    if (!poolIdForMatch) return [];
    return ownedManagers.filter(
      (m) => m.deepbook_pool_id?.toLowerCase() === poolIdForMatch
    );
  }, [ownedManagers, poolIdForMatch]);

  // Resolve which manager to use: single match → that one; multiple → user's choice or default
  const managerForThisPool = useMemo(() => {
    if (!poolIdForMatch) return null;
    if (matchesForThisPool.length === 0) {
      if (
        justCreatedManager &&
        justCreatedManager.deepbook_pool_id?.toLowerCase() === poolIdForMatch
      ) {
        return justCreatedManager;
      }
      return null;
    }
    if (matchesForThisPool.length === 1) {
      return matchesForThisPool[0];
    }
    const sorted = [...matchesForThisPool].sort((a, b) =>
      a.margin_manager_id.localeCompare(b.margin_manager_id)
    );
    const chosen = selectedMarginManagerIdForPool
      ? sorted.find(
          (m) => m.margin_manager_id === selectedMarginManagerIdForPool
        )
      : null;
    return chosen ?? sorted[sorted.length - 1];
  }, [
    poolIdForMatch,
    matchesForThisPool,
    justCreatedManager,
    selectedMarginManagerIdForPool,
  ]);

  const marginManagerId = managerForThisPool?.margin_manager_id ?? null;
  const {
    state,
    loading: stateLoading,
    error: stateError,
    refresh: refreshMarginState,
  } = useMarginManagerState(
    marginManagerId,
    poolInfoForPair?.deepbook_pool_id ?? null
  );
  const {
    collateral,
    borrowed,
    repaid,
    liquidations,
    loading: historyLoading,
    error: historyError,
    refresh: refreshMarginHistory,
  } = useMarginHistory(
    marginManagerId,
    poolInfoForPair?.base_margin_pool_id ?? null,
    poolInfoForPair?.quote_margin_pool_id ?? null
  );
  const {
    orders: openOrders,
    loading: openOrdersLoading,
    error: openOrdersError,
    refresh: refreshOpenOrders,
  } = useOpenOrders(marginManagerId, decodedPoolName);
  const {
    orders: orderHistory,
    loading: orderHistoryLoading,
    error: orderHistoryError,
    refresh: refreshOrderHistory,
  } = useOrderHistory(marginManagerId, decodedPoolName);
  const {
    trades: tradeHistory,
    loading: tradeHistoryLoading,
    error: tradeHistoryError,
    refresh: refreshTradeHistory,
  } = useTrades(marginManagerId, decodedPoolName);

  useEffect(() => {
    if (marginManagerId && state) {
      console.log("[Margin] Manager state", {
        marginManagerId,
        state,
      });
      fetchMarginBorrowedSharesViaBackend({
        apiUrl,
        marginManagerId,
        poolKey: decodedPoolName,
        network: "mainnet",
      })
        .then((chain) => {
          console.log(
            "======= Margin Manager SDK — borrowedShares, borrowedBaseShares, borrowedQuoteShares, hasBaseDebt ======="
          );
          console.log(
            JSON.stringify(
              {
                borrowedShares: chain.borrowedShares,
                borrowedBaseShares: chain.borrowedBaseShares,
                borrowedQuoteShares: chain.borrowedQuoteShares,
                hasBaseDebt: chain.hasBaseDebt,
              },
              null,
              2
            )
          );
          console.log(
            "+++++++ Margin Manager SDK — balanceManager, calculateAssets, calculateDebts +++++++"
          );
          console.log(
            JSON.stringify(
              {
                balanceManager: chain.balanceManager,
                calculateAssets: chain.calculateAssets,
                calculateDebts: chain.calculateDebts,
              },
              null,
              2
            )
          );
          console.log(
            "[Margin] Indexer vs chain — indexer base_debt/quote_debt:",
            state.base_debt,
            state.quote_debt,
            "| chain borrowedBaseShares/borrowedQuoteShares:",
            chain.borrowedBaseShares,
            chain.borrowedQuoteShares
          );
        })
        .catch((e) => {
          if (__DEV__) {
            console.warn("[Margin] Chain margin state fetch failed:", e);
          }
        });
    }
  }, [marginManagerId, state, apiUrl, decodedPoolName]);

  // (Removed verbose state→live-position debug logging to keep console clean.)

  const lastFocusRefreshRef = useRef<number>(0);
  const FOCUS_REFRESH_DEBOUNCE_MS = 5000;
  // Refresh Activity when screen gains focus so DEEP/indexer-delayed events show up.
  // Debounce so we don’t refetch every 2–3s if focus fires repeatedly.
  useFocusEffect(
    useCallback(() => {
      if (!marginManagerId) return;
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < FOCUS_REFRESH_DEBOUNCE_MS) return;
      lastFocusRefreshRef.current = now;
      refreshMarginHistory();
    }, [marginManagerId, refreshMarginHistory])
  );

  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [leverage, setLeverage] = useState(1);
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [createManagerLoading, setCreateManagerLoading] = useState(false);
  /** Optimistic entry after create so CTA hides before RPC includes the new object. */
  const [justCreatedManager, setJustCreatedManager] = useState<{
    margin_manager_id: string;
    deepbook_pool_id: string;
  } | null>(null);
  const [accountPickerVisible, setAccountPickerVisible] = useState(false);
  const [depositModalVisible, setDepositModalVisible] = useState(false);
  const [withdrawModalVisible, setWithdrawModalVisible] = useState(false);
  const [depositAsset, setDepositAsset] = useState<"base" | "quote" | "deep">(
    "quote"
  );
  const [withdrawAsset, setWithdrawAsset] = useState<"base" | "quote" | "deep">(
    "quote"
  );
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [depositLoading, setDepositLoading] = useState(false);
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [depositWalletBalanceRaw, setDepositWalletBalanceRaw] = useState<
    string | null
  >(null);
  const [depositBalanceLoading, setDepositBalanceLoading] = useState(false);
  const [depositAmountExceedsBalance, setDepositAmountExceedsBalance] =
    useState(false);
  const [withdrawAmountExceedsBalance, setWithdrawAmountExceedsBalance] =
    useState(false);
  const [orderLoading, setOrderLoading] = useState(false);
  const [closePositionLoading, setClosePositionLoading] = useState(false);
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [tpslLoading, setTpslLoading] = useState(false);
  const marginRefreshPollRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );

  useEffect(() => {
    return () => {
      if (marginRefreshPollRef.current != null) {
        clearInterval(marginRefreshPollRef.current);
        marginRefreshPollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!justCreatedManager || !poolIdForMatch || !ownedManagers.length) return;
    const apiHasManager = ownedManagers.some(
      (m) => m.deepbook_pool_id?.toLowerCase() === poolIdForMatch
    );
    if (apiHasManager) setJustCreatedManager(null);
  }, [justCreatedManager, poolIdForMatch, ownedManagers]);

  useEffect(() => {
    setJustCreatedManager(null);
  }, [decodedPoolName]);

  const getDepositCoinType = useCallback(
    (asset: "base" | "quote" | "deep"): string | null => {
      if (asset === "deep") return COIN_TYPES_MAINNET.DEEP;
      if (!poolInfoForPair) return null;
      return asset === "base"
        ? poolInfoForPair.base_asset_id
        : poolInfoForPair.quote_asset_id;
    },
    [poolInfoForPair]
  );

  const getDecimalsForAsset = useCallback(
    (asset: "base" | "quote" | "deep"): number => {
      const coinType = getDepositCoinType(asset);
      return coinType ? getDecimalsForCoinType(coinType) : 9;
    },
    [getDepositCoinType]
  );

  useEffect(() => {
    if (
      !depositModalVisible ||
      !suiAddress ||
      !getDepositCoinType(depositAsset)
    ) {
      setDepositWalletBalanceRaw(null);
      return;
    }
    let cancelled = false;
    setDepositBalanceLoading(true);
    setDepositWalletBalanceRaw(null);
    fetchSuiBalance(suiAddress, getDepositCoinType(depositAsset)!)
      .then((res) => {
        if (!cancelled) setDepositWalletBalanceRaw(res.totalBalance);
      })
      .catch(() => {
        if (!cancelled) setDepositWalletBalanceRaw("0");
      })
      .finally(() => {
        if (!cancelled) setDepositBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [depositModalVisible, suiAddress, depositAsset, getDepositCoinType]);

  useEffect(() => {
    const raw = depositWalletBalanceRaw ?? "0";
    const amountNum = parseFloat(depositAmount);
    if (
      depositAmount.trim() === "" ||
      Number.isNaN(amountNum) ||
      amountNum < MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT
    ) {
      setDepositAmountExceedsBalance(false);
      return;
    }
    const decimals = getDecimalsForAsset(depositAsset);
    const amountRaw = BigInt(Math.round(amountNum * Math.pow(10, decimals)));
    setDepositAmountExceedsBalance(amountRaw > BigInt(raw));
  }, [
    depositAmount,
    depositWalletBalanceRaw,
    depositAsset,
    getDecimalsForAsset,
  ]);

  // Derive available base/quote/deep by summing activity: +deposits -withdrawals per asset.
  // Matches what the user sees in the Activity list and updates as soon as new events load.
  const availableFromEventSum = useMemo(() => {
    if (!collateral.length) return null;
    let base = 0;
    let quote = 0;
    let deep = 0;
    for (const e of collateral) {
      const decimals = getDecimalsForCoinType(e.asset_type);
      const humanAmount = Number(e.amount) / Math.pow(10, decimals);
      const delta =
        e.event_type?.toLowerCase() === "deposit" ? humanAmount : -humanAmount;
      const symbol = symbolFromAssetType(e.asset_type);
      if (poolInfoForPair && symbol === poolInfoForPair.base_asset_symbol)
        base += delta;
      else if (poolInfoForPair && symbol === poolInfoForPair.quote_asset_symbol)
        quote += delta;
      else if (symbol === "DEEP") deep += delta;
    }
    return { base, quote, deep };
  }, [collateral, poolInfoForPair]);

  // Available balance for withdraw. Prefer state when available so open positions are reflected.
  const withdrawAvailableHuman = useMemo(() => {
    if (withdrawAsset === "deep") return null;
    if (state != null) {
      if (withdrawAsset === "base") return Number(state.base_asset);
      if (withdrawAsset === "quote") return Number(state.quote_asset);
      return null;
    }
    const fromSum =
      availableFromEventSum &&
      (withdrawAsset === "base"
        ? availableFromEventSum.base
        : availableFromEventSum.quote);
    if (
      fromSum !== undefined &&
      fromSum !== null &&
      !Number.isNaN(fromSum) &&
      fromSum >= 0
    )
      return fromSum;
    return null;
  }, [withdrawAsset, availableFromEventSum, state]);

  const maxLeverageForPool = decodedPoolName
    ? getMaxLeverageForPool(decodedPoolName)
    : 3;
  const leverageOptions = useMemo(
    () =>
      Array.from({ length: maxLeverageForPool }, (_, i) => (i + 1) as number),
    [maxLeverageForPool]
  );
  useEffect(() => {
    setLeverage((prev) =>
      prev > maxLeverageForPool ? maxLeverageForPool : prev < 1 ? 1 : prev
    );
  }, [maxLeverageForPool]);

  // Max margin (your capital in base): equity / price. Position = margin × leverage; protocol borrows the rest.
  const maxMarginBase = useMemo(() => {
    const price =
      typeof livePrice === "number" && livePrice > 0 ? livePrice : null;
    if (price == null) return null;
    const debtStr = state ? debtUsdFromState(state).replace(/,/g, "") : "0";
    const equity = Math.max(
      0,
      collateralUsdTotal - parseFloat(debtStr) || 0
    );
    return equity / price;
  }, [collateralUsdTotal, state, livePrice]);

  const setMarginToMax = useCallback(() => {
    if (maxMarginBase != null && maxMarginBase > 0) {
      setQuantity(
        maxMarginBase.toLocaleString(undefined, {
          maximumFractionDigits: 6,
          minimumFractionDigits: 0,
        })
      );
    }
  }, [maxMarginBase]);

  const [paymentAsset, setPaymentAsset] = useState<"base" | "quote" | "deep">(
    "quote"
  );

  const paymentAssetBalance = useMemo(() => {
    if (state != null && paymentAsset !== "deep") {
      if (paymentAsset === "base") return Number(state.base_asset);
      if (paymentAsset === "quote") return Number(state.quote_asset);
    }
    if (availableFromEventSum) {
      if (paymentAsset === "base") return availableFromEventSum.base;
      if (paymentAsset === "quote") return availableFromEventSum.quote;
      if (paymentAsset === "deep") return availableFromEventSum.deep;
    }
    return null;
  }, [paymentAsset, availableFromEventSum, state]);

  // Margin account token balances for display (like home screen balances).
  // Prefer state when available so open positions are reflected (state includes trading;
  // event sum is only deposits - withdrawals). State = GET /margin_manager_states.
  // Event sum = GET /collateral_events (+Deposit -Withdraw). DEEP only from events.
  const marginBalances = useMemo(() => {
    const base =
      state != null
        ? Number(state.base_asset)
        : availableFromEventSum?.base ?? undefined;
    const quote =
      state != null
        ? Number(state.quote_asset)
        : availableFromEventSum?.quote ?? undefined;
    const deep = availableFromEventSum?.deep ?? 0;
    return { base, quote, deep };
  }, [availableFromEventSum, state]);

  // Collateral (USD) = base + quote + DEEP, each decimal-adjusted amount × decimal-adjusted price.
  // Base/quote prices from state Pyth; DEEP price from ticker DEEP_USDC.
  const collateralUsdTotal = useMemo(() => {
    const baseAmt = marginBalances.base ?? 0;
    const quoteAmt = marginBalances.quote ?? 0;
    const deepAmt = marginBalances.deep ?? 0;
    const basePrice = state
      ? Number(state.base_pyth_price) / Math.pow(10, state.base_pyth_decimals)
      : 0;
    const quotePrice = state
      ? Number(state.quote_pyth_price) / Math.pow(10, state.quote_pyth_decimals)
      : 0;
    const deepPrice = ticker["DEEP_USDC"]?.last_price ?? 0;
    return baseAmt * basePrice + quoteAmt * quotePrice + deepAmt * deepPrice;
  }, [
    state,
    marginBalances.base,
    marginBalances.quote,
    marginBalances.deep,
    ticker,
  ]);

  const equityUsd = useMemo(() => {
    const debtStr = state ? debtUsdFromState(state).replace(/,/g, "") : "0";
    return Math.max(0, collateralUsdTotal - parseFloat(debtStr) || 0);
  }, [collateralUsdTotal, state]);

  // State = only live position? + size (no direction, no price). Direction + entry = from trades.
  // - Our side: taker => our_side = type, maker => our_side = opposite(type).
  // - Long vs short: latest trade's our_side. Sell => short, buy => long.
  // - Entry: VWAP of trade "price" for that side (buys for long, sells for short).
  const livePnl = useMemo(() => {
    const quoteSymbol = poolInfoForPair?.quote_asset_symbol ?? "USDC";
    const chronological = [...tradeHistory].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
    );
    let runningBase = 0;
    let runningCostBasisQuote = 0;
    let runningShortBase = 0;
    let runningShortProceedsQuote = 0;
    let realizedPnlQuote = 0;
    const ourSide = (t: { our_side?: "buy" | "sell"; type: "buy" | "sell" }) =>
      t.our_side ?? t.type;
    for (const t of chronological) {
      const b = Number(t.base_volume) || 0;
      const price = Number(t.price) ?? 0;
      if (ourSide(t) === "buy") {
        if (runningShortBase > 0) {
          const closeQty = Math.min(b, runningShortBase);
          const shortProceedsForClose =
            (closeQty / runningShortBase) * runningShortProceedsQuote;
          realizedPnlQuote += shortProceedsForClose - price * closeQty;
          runningShortBase -= closeQty;
          runningShortProceedsQuote -= shortProceedsForClose;
          const remainderB = b - closeQty;
          if (remainderB > 0) {
            runningBase += remainderB;
            runningCostBasisQuote += price * remainderB;
          }
        } else {
          runningBase += b;
          runningCostBasisQuote += price * b;
        }
      } else {
        if (runningBase > 0) {
          const closeQty = Math.min(b, runningBase);
          const costOfSold = (closeQty / runningBase) * runningCostBasisQuote;
          realizedPnlQuote += price * closeQty - costOfSold;
          runningCostBasisQuote -= costOfSold;
          runningBase -= closeQty;
          const remainderB = b - closeQty;
          if (remainderB > 0) {
            runningShortBase += remainderB;
            runningShortProceedsQuote += price * remainderB;
          }
        } else {
          runningShortBase += b;
          runningShortProceedsQuote += price * b;
        }
      }
    }
    const avgEntryLong =
      runningBase > 0 ? runningCostBasisQuote / runningBase : 0;
    const avgEntryShort =
      runningShortBase > 0 ? runningShortProceedsQuote / runningShortBase : 0;
    const currentPrice = Number(
      (decodedPoolName && ticker[decodedPoolName]?.last_price) ?? 0
    );
    // State: size and sign. Direction from latest trade when we have trades; else infer from state (net base > 0 => long, < 0 => short).
    let positionSize = 0;
    let netBaseSigned = 0;
    if (state) {
      netBaseSigned =
        Number(state.base_asset) - Number(state.base_debt);
      positionSize = Math.abs(netBaseSigned);
    }
    const hasPosition = positionSize > 0;
    const hasDebt =
      state != null &&
      (Number(state.base_debt) > 0 || Number(state.quote_debt) > 0);
    const latestTrade = chronological[chronological.length - 1];
    const positionSide: "long" | "short" | "none" = !hasPosition
      ? "none"
      : latestTrade != null
        ? ourSide(latestTrade) === "sell"
          ? "short"
          : "long"
        : netBaseSigned > 0
          ? "long"
          : "short";
    const entryForPosition =
      positionSide === "long"
        ? avgEntryLong
        : positionSide === "short"
        ? avgEntryShort
        : 0;
    const hasKnownEntry = entryForPosition > 0;
    const unrealizedPnlQuote =
      hasKnownEntry && currentPrice > 0 && positionSize > 0
        ? positionSide === "long"
          ? positionSize * (currentPrice - entryForPosition)
          : positionSize * (entryForPosition - currentPrice)
        : 0;
    const totalPnlQuote = realizedPnlQuote + unrealizedPnlQuote;
    const baseSymbol = poolInfoForPair?.base_asset_symbol ?? "BASE";
    return {
      realizedPnlQuote,
      unrealizedPnlQuote,
      totalPnlQuote,
      quoteSymbol,
      baseSymbol,
      hasPosition,
      hasDebt,
      hasKnownEntry,
      netBasePosition: positionSize,
      avgEntryQuote: entryForPosition,
      currentPrice,
      positionSide,
    };
  }, [
    tradeHistory,
    state,
    ticker,
    decodedPoolName,
    poolInfoForPair?.base_asset_id,
    poolInfoForPair?.quote_asset_symbol,
  ]);

  // (Removed verbose balance/source debug logging to keep console clean.)

  useEffect(() => {
    if (withdrawAsset === "deep" || withdrawAvailableHuman === null) {
      setWithdrawAmountExceedsBalance(false);
      return;
    }
    const amountNum = parseFloat(withdrawAmount);
    if (
      withdrawAmount.trim() === "" ||
      Number.isNaN(amountNum) ||
      amountNum < MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT
    ) {
      setWithdrawAmountExceedsBalance(false);
      return;
    }
    setWithdrawAmountExceedsBalance(amountNum > withdrawAvailableHuman);
  }, [withdrawAmount, withdrawAvailableHuman, withdrawAsset]);

  const { signRawHash } = useSignRawHash();
  const suiWallet = getSuiWalletFromUser(user);

  const onDeposit = useCallback(() => setDepositModalVisible(true), []);
  const onWithdraw = useCallback(() => setWithdrawModalVisible(true), []);

  const onDepositSubmit = useCallback(async () => {
    const amount = parseFloat(depositAmount);
    if (
      !suiAddress ||
      !marginManagerId ||
      !decodedPoolName ||
      !poolInfoForPair
    ) {
      Alert.alert("Error", "Missing wallet, manager, or pool.");
      return;
    }
    if (Number.isNaN(amount) || amount < MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT) {
      Alert.alert(
        "Invalid amount",
        `Minimum deposit is ${MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT}.`
      );
      return;
    }
    if (depositAmountExceedsBalance) {
      return;
    }
    if (!signRawHash || !suiWallet?.publicKey) {
      Alert.alert(
        "Error",
        "Signing not available. Link your Sui wallet on Home."
      );
      return;
    }
    setDepositLoading(true);
    try {
      await depositMarginViaBackend({
        apiUrl,
        sender: suiAddress,
        marginManagerId,
        poolKey: decodedPoolName,
        asset: depositAsset,
        amount,
        signRawHash,
        publicKeyHex: publicKeyToHex(suiWallet.publicKey),
        network: "mainnet",
      });
      setDepositModalVisible(false);
      setDepositAmount("");
      await refreshOwned();
      refreshMarginState();
      refreshMarginHistory();
      refreshOpenOrders();
      refreshOrderHistory();
      refreshTradeHistory();
      if (marginRefreshPollRef.current != null) {
        clearInterval(marginRefreshPollRef.current);
        marginRefreshPollRef.current = null;
      }
      const pollIntervalMs = 10_000;
      const pollCount = 12;
      let pollCountdown = pollCount;
      marginRefreshPollRef.current = setInterval(() => {
        refreshMarginState();
        refreshMarginHistory();
        refreshOpenOrders();
        refreshOrderHistory();
        refreshTradeHistory();
        pollCountdown -= 1;
        if (pollCountdown <= 0 && marginRefreshPollRef.current != null) {
          clearInterval(marginRefreshPollRef.current);
          marginRefreshPollRef.current = null;
        }
      }, pollIntervalMs);
      Alert.alert(
        "Success",
        'Deposit submitted. Balance may take 1–2 minutes to appear. Tap "Refresh balance" in the margin card if it hasn’t updated.'
      );
    } catch (err) {
      Alert.alert(
        "Deposit failed",
        err instanceof Error ? err.message : "Unknown error"
      );
    } finally {
      setDepositLoading(false);
    }
  }, [
    suiAddress,
    marginManagerId,
    decodedPoolName,
    poolInfoForPair,
    depositAmount,
    depositAsset,
    depositAmountExceedsBalance,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    refreshOwned,
    refreshMarginState,
    refreshMarginHistory,
    refreshOpenOrders,
    refreshOrderHistory,
    refreshTradeHistory,
  ]);

  const onWithdrawSubmit = useCallback(async () => {
    const amount = parseFloat(withdrawAmount);
    if (
      !suiAddress ||
      !marginManagerId ||
      !decodedPoolName ||
      !poolInfoForPair
    ) {
      Alert.alert("Error", "Missing wallet, manager, or pool.");
      return;
    }
    if (Number.isNaN(amount) || amount < MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT) {
      Alert.alert(
        "Invalid amount",
        `Minimum withdraw is ${MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT}.`
      );
      return;
    }
    if (withdrawAmountExceedsBalance) {
      return;
    }
    if (!signRawHash || !suiWallet?.publicKey) {
      Alert.alert(
        "Error",
        "Signing not available. Link your Sui wallet on Home."
      );
      return;
    }
    setWithdrawLoading(true);
    try {
      await withdrawMarginViaBackend({
        apiUrl,
        sender: suiAddress,
        marginManagerId,
        poolKey: decodedPoolName,
        asset: withdrawAsset,
        amount,
        signRawHash,
        publicKeyHex: publicKeyToHex(suiWallet.publicKey),
        network: "mainnet",
      });
      setWithdrawModalVisible(false);
      setWithdrawAmount("");
      await refreshOwned();
      refreshMarginState();
      refreshMarginHistory();
      refreshOpenOrders();
      refreshOrderHistory();
      refreshTradeHistory();
      if (marginRefreshPollRef.current != null) {
        clearInterval(marginRefreshPollRef.current);
        marginRefreshPollRef.current = null;
      }
      const pollIntervalMs = 10_000;
      const pollCount = 12;
      let pollCountdown = pollCount;
      marginRefreshPollRef.current = setInterval(() => {
        refreshMarginState();
        refreshMarginHistory();
        refreshOpenOrders();
        refreshOrderHistory();
        refreshTradeHistory();
        pollCountdown -= 1;
        if (pollCountdown <= 0 && marginRefreshPollRef.current != null) {
          clearInterval(marginRefreshPollRef.current);
          marginRefreshPollRef.current = null;
        }
      }, pollIntervalMs);
      Alert.alert(
        "Success",
        'Withdrawal submitted. Balance may take 1–2 minutes to update. Tap "Refresh balance" in the margin card if it hasn’t updated.'
      );
    } catch (err) {
      Alert.alert(
        "Withdraw failed",
        err instanceof Error ? err.message : "Unknown error"
      );
    } finally {
      setWithdrawLoading(false);
    }
  }, [
    suiAddress,
    marginManagerId,
    decodedPoolName,
    poolInfoForPair,
    withdrawAmount,
    withdrawAsset,
    withdrawAmountExceedsBalance,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    refreshOwned,
    refreshMarginState,
    refreshMarginHistory,
    refreshOpenOrders,
    refreshOrderHistory,
    refreshTradeHistory,
  ]);

  const assetLabel = (asset: "base" | "quote" | "deep") => {
    if (asset === "deep") return "DEEP";
    if (!poolInfoForPair) return asset;
    return asset === "base"
      ? poolInfoForPair.base_asset_symbol
      : poolInfoForPair.quote_asset_symbol;
  };

  /** Format borrow/repay amount (raw from indexer) to human + symbol, e.g. "1 SUI". */
  const formatLoanAmount = useCallback(
    (amountRaw: number, marginPoolId: string): string => {
      if (!poolInfoForPair) return String(amountRaw);
      const isBase =
        marginPoolId === poolInfoForPair.base_margin_pool_id;
      const decimals = getDecimalsForCoinType(
        isBase
          ? poolInfoForPair.base_asset_id
          : poolInfoForPair.quote_asset_id
      );
      const symbol = isBase
        ? poolInfoForPair.base_asset_symbol
        : poolInfoForPair.quote_asset_symbol;
      const value = Number(amountRaw) / Math.pow(10, decimals);
      return `${value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 6,
      })} ${symbol}`;
    },
    [poolInfoForPair]
  );

  const onCreateManager = useCallback(async () => {
    if (!suiAddress || !decodedPoolName) {
      Alert.alert("Error", "Wallet and pool are required.");
      return;
    }
    if (!poolInfoForPair) {
      Alert.alert(
        "Pool not available",
        "This trading pair is not available for margin yet. Try SUI/USDC or another pair from the list."
      );
      return;
    }
    if (!signRawHash) {
      Alert.alert("Error", "Signing not available. Please try again.");
      return;
    }
    const publicKey = suiWallet?.publicKey;
    if (!publicKey) {
      Alert.alert(
        "Error",
        "Sui wallet public key not found. Link your Sui wallet on Home."
      );
      return;
    }
    const poolKey = decodedPoolName;
    setCreateManagerLoading(true);
    try {
      const publicKeyHex = publicKeyToHex(publicKey);
      const result = await createMarginManagerViaBackend({
        apiUrl,
        sender: suiAddress,
        poolKey,
        signRawHash,
        publicKeyHex,
        network: "mainnet",
      });
      setJustCreatedManager({
        margin_manager_id: result.margin_manager_id,
        deepbook_pool_id: poolInfoForPair.deepbook_pool_id,
      });
      await refreshOwned();
      Alert.alert(
        "Success",
        "Margin manager created. You can now deposit and trade."
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create failed";
      Alert.alert("Create margin manager failed", msg);
    } finally {
      setCreateManagerLoading(false);
    }
  }, [
    suiAddress,
    decodedPoolName,
    poolInfoForPair,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    refreshOwned,
  ]);

  const onPlaceOrder = useCallback(async () => {
    if (orderType === "limit") {
      if (!price.trim() || !quantity.trim()) {
        Alert.alert("Place order", "Enter price and margin for limit order.");
        return;
      }
    } else {
      if (!quantity.trim()) {
        Alert.alert("Place order", "Enter margin for market order.");
        return;
      }
    }
    if (!marginManagerId || !decodedPoolName || !suiAddress) {
      Alert.alert("Place order", "Select a margin account first.");
      return;
    }
    if (!signRawHash || !suiWallet?.publicKey) {
      Alert.alert("Place order", "Wallet signing not available.");
      return;
    }
    const marginQty = parseFloat(quantity.trim());
    if (!Number.isFinite(marginQty) || marginQty <= 0) {
      Alert.alert("Place order", "Enter a valid margin (your capital).");
      return;
    }
    // Order size sent to protocol = your margin × leverage (protocol borrows the rest).
    const orderQty = marginQty * leverage;
    if (orderQty < MIN_ORDER_QUANTITY) {
      Alert.alert(
        "Place order",
        `Position (margin × ${leverage}×) must be at least ${MIN_ORDER_QUANTITY}. Use margin ≥ ${(MIN_ORDER_QUANTITY / leverage).toFixed(2)}.`
      );
      return;
    }
    const pr = orderType === "limit" ? parseFloat(price.trim()) : undefined;
    if (
      orderType === "limit" &&
      (pr == null || !Number.isFinite(pr) || pr <= 0)
    ) {
      Alert.alert("Place order", "Enter a valid price.");
      return;
    }
    // Margin check: your margin × price (margin in USD) can't exceed equity; position notional = margin × leverage × price ≤ equity × leverage.
    const priceForMargin =
      orderType === "limit" && pr != null ? pr : livePrice;
    const notionalUsd =
      typeof priceForMargin === "number" && priceForMargin > 0
        ? orderQty * priceForMargin
        : null;
    const maxNotionalUsd = equityUsd * leverage;
    if (
      notionalUsd != null &&
      notionalUsd > 0 &&
      maxNotionalUsd < notionalUsd
    ) {
      Alert.alert(
        "Place order",
        `Not enough margin for this size at ${leverage}×.\n\n` +
          `Your equity ≈ $${equityUsd.toFixed(2)}. At ${leverage}×, max position notional ≈ $${maxNotionalUsd.toFixed(2)}.\n` +
          `This order: ${marginQty.toFixed(2)} × ${leverage}× × $${priceForMargin.toFixed(2)} ≈ $${notionalUsd.toFixed(2)} notional.\n\n` +
          `Use a smaller margin or add collateral.`
      );
      return;
    }
    // Borrow (n-1)× margin so account has enough for the order. Long = borrow quote; short = borrow base.
    const borrowBaseAmount =
      orderSide === "sell" && leverage > 1
        ? Math.round(marginQty * (leverage - 1) * 1e6) / 1e6
        : undefined;
    const borrowQuoteAmount =
      orderSide === "buy" &&
      leverage > 1 &&
      typeof livePrice === "number" &&
      livePrice > 0
        ? Math.round(marginQty * livePrice * (leverage - 1) * 1e6) / 1e6
        : undefined;

    setOrderLoading(true);
    try {
      const publicKeyHex = publicKeyToHex(suiWallet.publicKey);
      await placeOrderViaBackend({
        apiUrl,
        sender: suiAddress,
        marginManagerId,
        poolKey: decodedPoolName,
        orderType,
        isBid: orderSide === "buy",
        quantity: orderQty,
        price: orderType === "limit" ? pr : undefined,
        payWithDeep: paymentAsset === "deep",
        borrowBaseAmount,
        borrowQuoteAmount,
        signRawHash,
        publicKeyHex,
        network: "mainnet",
      });
      refreshMarginHistory?.();
      refreshOpenOrders?.();
      refreshOrderHistory?.();
      refreshTradeHistory?.();
      refreshMarginState?.();
      setTimeout(() => {
        refreshOpenOrders?.();
        refreshOrderHistory?.();
        refreshTradeHistory?.();
        refreshMarginState?.();
      }, 2500);
      setTimeout(() => {
        refreshMarginState?.();
      }, 6000);
      setPrice("");
      Alert.alert("Place order", "Order submitted.");
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Place order failed";
      console.log("[Place order] Protocol/backend error:", raw);
      const isInsufficientMargin =
        raw.includes("withdraw_with_proof") ||
        raw.includes("abort code: 3") ||
        raw.includes("could not automatically determine a budget");
      const msg = isInsufficientMargin
        ? "Insufficient margin for this order. Try reducing quantity or add more collateral."
        : raw;
      Alert.alert("Place order", msg);
    } finally {
      setOrderLoading(false);
    }
  }, [
    orderType,
    price,
    quantity,
    orderSide,
    paymentAsset,
    paymentAssetBalance,
    livePrice,
    assetLabel,
    equityUsd,
    leverage,
    marginManagerId,
    decodedPoolName,
    suiAddress,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    refreshMarginHistory,
    refreshOpenOrders,
    refreshOrderHistory,
    refreshTradeHistory,
    refreshMarginState,
  ]);

  const onClosePosition = useCallback(async () => {
    if (
      !livePnl.hasPosition ||
      !livePnl.hasDebt ||
      livePnl.positionSide === "none"
    )
      return;
    const baseDebt = state ? Number(state.base_debt) : 0;
    const quoteDebt = state ? Number(state.quote_debt) : 0;
    const hasDebt = baseDebt > 0 || quoteDebt > 0;
    // One position per margin manager. Convert quote → base first when short (use USDC to buy SUI); then repay.
    const latestTrade = tradeHistory[0];
    const mark = livePnl.currentPrice;
    const quoteAsset = state ? Number(state.quote_asset) : 0;
    const baseAsset = state ? Number(state.base_asset) : 0;
    const onChainPositionSize = Math.abs(livePnl.netBasePosition);

    let closeQuantity: number;
    if (
      livePnl.positionSide === "short" &&
      latestTrade?.quote_volume != null &&
      latestTrade?.price != null &&
      mark > 0
    ) {
      // Short: only swap the position (size + unrealized) in USDC — the amount that went into the trade. Convert that to base.
      const sizeInQuote = Number(latestTrade.quote_volume);
      const entry = Number(latestTrade.price);
      const unrealizedInQuote = sizeInQuote * (entry - mark) / entry;
      const totalQuoteToConvert = sizeInQuote + unrealizedInQuote;
      closeQuantity = totalQuoteToConvert / mark;
      if (quoteAsset > 0) {
        closeQuantity = Math.min(closeQuantity, quoteAsset / mark);
      }
    } else if (livePnl.positionSide === "short" && quoteAsset > 0 && mark > 0) {
      closeQuantity = quoteAsset / mark;
    } else if (livePnl.positionSide === "long" && baseAsset > 0) {
      // Long: close only the SUI involved in the trade (size + unrealized PnL),
      // not extra SUI collateral sitting in the account.
      if (
        latestTrade?.quote_volume != null &&
        latestTrade?.price != null &&
        mark > 0
      ) {
        const sizeInQuote = Number(latestTrade.quote_volume); // trade notional in USDC
        const entry = Number(latestTrade.price);
        const unrealizedInQuote = sizeInQuote * (mark - entry) / entry;
        const totalQuoteToConvert = sizeInQuote + unrealizedInQuote;
        const qtyFromTrade = totalQuoteToConvert / mark; // SUI = (size + PnL)/mark
        closeQuantity = Math.min(
          qtyFromTrade,
          baseAsset,
          onChainPositionSize || qtyFromTrade
        );
      } else if (latestTrade?.base_volume != null) {
        const tradeBaseSize = Number(latestTrade.base_volume);
        closeQuantity = Math.min(tradeBaseSize, baseAsset);
      } else {
        closeQuantity = Math.min(baseAsset, onChainPositionSize || baseAsset);
      }
    } else if (
      latestTrade?.quote_volume != null &&
      latestTrade?.price != null &&
      mark > 0
    ) {
      const sizeInSameDenom = Number(latestTrade.quote_volume);
      const entry = Number(latestTrade.price);
      const unrealizedInSameDenom =
        livePnl.positionSide === "long"
          ? sizeInSameDenom * (mark - entry) / entry
          : sizeInSameDenom * (entry - mark) / entry;
      closeQuantity = (sizeInSameDenom + unrealizedInSameDenom) / mark;
      closeQuantity = Math.min(closeQuantity, onChainPositionSize || closeQuantity);
    } else if (latestTrade?.base_volume != null) {
      closeQuantity = Math.min(Number(latestTrade.base_volume), onChainPositionSize || Number(latestTrade.base_volume));
    } else {
      closeQuantity = onChainPositionSize;
    }
    if (__DEV__) {
      console.log("[ClosePosition] computed raw close quantity", {
        positionSide: livePnl.positionSide,
        baseAsset,
        quoteAsset,
        baseDebt,
        quoteDebt,
        onChainPositionSize,
        latestTrade,
        mark,
        closeQuantity,
      });
    }
    closeQuantity = Math.round(closeQuantity * 1e6) / 1e6;
    const canPlaceCloseOrder = closeQuantity >= MIN_ORDER_QUANTITY;
    if (__DEV__) {
      console.log("[ClosePosition] normalized close quantity", {
        closeQuantity,
        canPlaceCloseOrder,
        minOrderQuantity: MIN_ORDER_QUANTITY,
      });
    }

    if (!canPlaceCloseOrder && !hasDebt) {
      Alert.alert(
        "Close position",
        `Position size (${closeQuantity.toFixed(6)}) is below minimum order ${MIN_ORDER_QUANTITY}. Nothing to repay.`
      );
      return;
    }
    if (!marginManagerId || !decodedPoolName || !suiAddress) {
      Alert.alert("Close position", "Select a margin account first.");
      return;
    }
    if (!signRawHash || !suiWallet?.publicKey) {
      Alert.alert("Close position", "Wallet signing not available.");
      return;
    }
    setClosePositionLoading(true);
    try {
      const publicKeyHex = publicKeyToHex(suiWallet.publicKey);
      if (canPlaceCloseOrder) {
        if (__DEV__) {
          console.log("[ClosePosition] placing close order via backend", {
            apiUrl,
            sender: suiAddress,
            marginManagerId,
            poolKey: decodedPoolName,
            orderType: "market",
            isBid: livePnl.positionSide === "short",
            quantity: closeQuantity,
            payWithDeep: false,
            reduceOnly: false,
          });
        }
        await placeOrderViaBackend({
          apiUrl,
          sender: suiAddress,
          marginManagerId,
          poolKey: decodedPoolName,
          orderType: "market",
          isBid: livePnl.positionSide === "short",
          quantity: closeQuantity,
          // Pay fees in quote asset for close; DEEP balance is optional.
          payWithDeep: false,
          // Use a regular market order for closing; repay step handles debt.
          reduceOnly: false,
          signRawHash,
          publicKeyHex,
          network: "mainnet",
        });
      }
      if (hasDebt) {
        // Use fresh state after order so we repay with the SUI we just got (and current quote).
        const stateForRepay = (await refreshMarginState?.()) ?? state;
        if (stateForRepay) {
          const baseAsset = Number(stateForRepay.base_asset);
          const quoteAsset = Number(stateForRepay.quote_asset);
          // After closing the position, margin manager should have enough assets
          // to cover its debts; otherwise it would be liquidated. Repay full debt
          // amounts (capped by protocol), rather than clamping by asset here.
          const baseRepay = baseDebt > 0 ? baseDebt : 0;
          const quoteRepay = quoteDebt > 0 ? quoteDebt : 0;
          if (__DEV__) {
            console.log("[ClosePosition] repay inputs", {
              stateForRepay,
              baseDebt,
              quoteDebt,
              baseAsset,
              quoteAsset,
              baseRepay,
              quoteRepay,
            });
          }
          if (baseRepay > 0 || quoteRepay > 0) {
            await repayViaBackend({
              apiUrl,
              sender: suiAddress,
              marginManagerId,
              poolKey: decodedPoolName,
              baseAmount: baseRepay > 0 ? baseRepay : undefined,
              quoteAmount: quoteRepay > 0 ? quoteRepay : undefined,
              signRawHash,
              publicKeyHex,
              network: "mainnet",
            });
          }
        }
      }
      refreshMarginState?.();
      refreshOpenOrders?.();
      refreshOrderHistory?.();
      refreshTradeHistory?.();
      if (canPlaceCloseOrder && hasDebt) {
        Alert.alert("Close position", "Position closed and debt repaid.");
      } else if (canPlaceCloseOrder) {
        Alert.alert("Close position", "Position closed.");
      } else {
        Alert.alert(
          "Close position",
          "Debt repaid. Position size was below minimum order, so no close order was placed; a small position may remain."
        );
      }
    } catch (err) {
      if (__DEV__) {
        console.log("[ClosePosition] error", err);
      }
      const msg = err instanceof Error ? err.message : "Close position failed";
      Alert.alert("Close position", msg);
    } finally {
      setClosePositionLoading(false);
    }
  }, [
    livePnl.hasPosition,
    livePnl.hasDebt,
    livePnl.positionSide,
    livePnl.netBasePosition,
    marginManagerId,
    decodedPoolName,
    suiAddress,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    state,
    tradeHistory,
    refreshMarginState,
    refreshOpenOrders,
    refreshOrderHistory,
    refreshTradeHistory,
  ]);

  const onSetTpsl = useCallback(async () => {
    const tp = tpPrice.trim() ? parseFloat(tpPrice.trim()) : undefined;
    const sl = slPrice.trim() ? parseFloat(slPrice.trim()) : undefined;
    if (tp == null && sl == null) {
      Alert.alert("TP/SL", "Enter at least one of TP or SL price.");
      return;
    }
    if (
      !marginManagerId ||
      !decodedPoolName ||
      !suiAddress ||
      !signRawHash ||
      !suiWallet?.publicKey
    ) {
      Alert.alert("TP/SL", "Select margin account and wallet first.");
      return;
    }
    const qty = quantity.trim() ? parseFloat(quantity.trim()) : 0;
    if (!Number.isFinite(qty) || qty <= 0) {
      Alert.alert("TP/SL", "Enter a valid quantity (used for closing size).");
      return;
    }
    if (
      (tp != null && !Number.isFinite(tp)) ||
      (sl != null && !Number.isFinite(sl))
    ) {
      Alert.alert("TP/SL", "Enter valid TP and/or SL prices.");
      return;
    }
    setTpslLoading(true);
    try {
      const publicKeyHex = publicKeyToHex(suiWallet.publicKey);
      await addTpslViaBackend({
        apiUrl,
        sender: suiAddress,
        marginManagerId,
        poolKey: decodedPoolName,
        isLong: orderSide === "buy",
        quantity: qty,
        tpPrice: tp,
        slPrice: sl,
        payWithDeep: paymentAsset === "deep",
        signRawHash,
        publicKeyHex,
        network: "mainnet",
      });
      refreshMarginHistory?.();
      setTpPrice("");
      setSlPrice("");
      Alert.alert("TP/SL", "Take profit and/or stop loss set.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Set TP/SL failed";
      Alert.alert("TP/SL", msg);
    } finally {
      setTpslLoading(false);
    }
  }, [
    tpPrice,
    slPrice,
    quantity,
    orderSide,
    paymentAsset,
    marginManagerId,
    decodedPoolName,
    suiAddress,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    refreshMarginHistory,
  ]);

  const onSwitchMarginAccount = useCallback(() => {
    if (!suiAddress || !decodedPoolName || matchesForThisPool.length <= 1)
      return;
    setAccountPickerVisible(true);
  }, [suiAddress, decodedPoolName, matchesForThisPool]);

  const onSelectMarginAccount = useCallback(
    (id: string) => {
      if (!suiAddress || !decodedPoolName) return;
      setSelectedMarginManagerId(suiAddress, decodedPoolName, id);
      setSelectedMarginManagerIdForPool(id);
      setAccountPickerVisible(false);
    },
    [suiAddress, decodedPoolName]
  );

  const hasManager = !!managerForThisPool;
  const displayPoolLabel = decodedPoolName
    ? formatPairLabel(decodedPoolName)
    : "—";

  const navigation = useNavigation();
  const onOpenFullChart = useCallback(() => {
    if (!decodedPoolName) return;
    router.push({
      pathname: "/trading/chart/[poolName]",
      params: { poolName: decodedPoolName, interval: chartInterval },
    });
  }, [decodedPoolName, chartInterval]);

  useEffect(() => {
    if (decodedPoolName) {
      navigation.setOptions({ title: displayPoolLabel });
    }
  }, [decodedPoolName, displayPoolLabel, navigation]);

  if (!decodedPoolName) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Invalid pair.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.container,
          { paddingTop: insets.top + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pairHeader}>
          <View style={styles.pairHeaderTopRow}>
            <Pressable
              onPress={() => navigation.goBack()}
              hitSlop={8}
              style={({ pressed }) => ({
                marginRight: 12,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <FontAwesome
                name="chevron-left"
                size={20}
                color={colors.text}
              />
            </Pressable>
            <Text style={[styles.pairName, { color: colors.text }]}>
              {displayPoolLabel}
            </Text>
          </View>
          <View style={styles.priceRow}>
            <Text style={[styles.muted, { color: colors.text }]}>Price</Text>
            <View style={styles.priceWithArrow}>
              {priceDirection === "up" && (
                <Text
                  style={[styles.priceArrow, styles.priceUp]}
                  allowFontScaling={false}
                >
                  ▲
                </Text>
              )}
              {priceDirection === "down" && (
                <Text
                  style={[styles.priceArrow, styles.priceDown]}
                  allowFontScaling={false}
                >
                  ▼
                </Text>
              )}
              <Text
                style={[
                  styles.value,
                  priceDirection === "up" && styles.priceUp,
                  priceDirection === "down" && styles.priceDown,
                ]}
              >
                {typeof livePrice === "number"
                  ? livePrice.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 6,
                    })
                  : "—"}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.chartHeaderRow}>
            <Text style={styles.cardLabel}>Chart</Text>
            <View style={styles.chartHeaderButtons}>
              <Pressable
                onPress={onOpenFullChart}
                style={({ pressed }) => [
                  styles.enlargeHeaderButton,
                  { opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Text style={styles.enlargeHeaderIcon}>⤢</Text>
              </Pressable>
            </View>
          </View>
          <View
            style={[styles.intervalRow, { borderColor: colors.tabIconDefault }]}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {CHART_INTERVALS.map((int) => (
                <Pressable
                  key={int}
                  onPress={() => setChartInterval(int)}
                  style={[
                    styles.intervalButton,
                    chartInterval === int && { backgroundColor: colors.tint },
                  ]}
                >
                  <Text
                    style={[
                      styles.intervalButtonText,
                      {
                        color:
                          chartInterval === int
                            ? colors.background
                            : colors.text,
                      },
                    ]}
                  >
                    {int.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
          <PriceChart
            candles={candles}
            interval={chartInterval}
            loading={ohlcvLoading}
            loadingOlder={ohlcvLoadingOlder}
            error={ohlcvError}
            candleLimit={CHART_DISPLAY_LIMIT}
            canGoToLatest={canPanRight}
            onGoToLatest={panToLatest}
            totalCandles={allCandles.length}
            windowStart={windowStart}
            onScrollbarChange={setWindowStartClamped}
            onReachedStart={ohlcvLoadOlder}
          />
        </View>

        {!suiAddress && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Margin account</Text>
            <Text style={styles.muted}>
              Connect your Sui wallet (Home) to link a margin account and trade.
            </Text>
          </View>
        )}

        {suiAddress && (
          <>
            <View style={styles.card}>
              <View style={styles.marginHeaderRow}>
                <Text style={styles.cardLabel}>Margin account</Text>
                <Pressable
                  onPress={() => {
                    refreshMarginState();
                    refreshMarginHistory();
                    refreshOpenOrders();
                    refreshOrderHistory();
                    refreshTradeHistory();
                    if (marginManagerId) {
                      fetchMarginBorrowedSharesViaBackend({
                        apiUrl,
                        marginManagerId,
                        poolKey: decodedPoolName,
                        network: "mainnet",
                      })
                        .then((chain) => {
                          console.log(
                            "======= Margin Manager SDK — borrowedShares, borrowedBaseShares, borrowedQuoteShares, hasBaseDebt ======="
                          );
                          console.log(
                            JSON.stringify(
                              {
                                borrowedShares: chain.borrowedShares,
                                borrowedBaseShares: chain.borrowedBaseShares,
                                borrowedQuoteShares: chain.borrowedQuoteShares,
                                hasBaseDebt: chain.hasBaseDebt,
                              },
                              null,
                              2
                            )
                          );
                          console.log(
                            "+++++++ Margin Manager SDK — balanceManager, calculateAssets, calculateDebts +++++++"
                          );
                          console.log(
                            JSON.stringify(
                              {
                                balanceManager: chain.balanceManager,
                                calculateAssets: chain.calculateAssets,
                                calculateDebts: chain.calculateDebts,
                              },
                              null,
                              2
                            )
                          );
                        })
                        .catch((e) => {
                          if (__DEV__) {
                            console.warn(
                              "[Margin] Chain margin state fetch failed:",
                              e
                            );
                          }
                        });
                    }
                  }}
                  style={({ pressed }) => [
                    styles.marginRefreshButton,
                    { opacity: pressed ? 0.7 : 1 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh margin balance"
                >
                  <Text style={styles.marginRefreshIcon}>⟳</Text>
                </Pressable>
              </View>
              {ownedLoading && !hasManager ? (
                <View style={styles.row}>
                  <ActivityIndicator size="small" color={colors.tint} />
                  <Text style={styles.muted}>Checking for margin manager…</Text>
                </View>
              ) : !hasManager ? (
                <>
                  <Text style={styles.muted}>
                    No margin manager for this pair. Create one to trade with
                    margin.
                  </Text>
                  {!poolInfoForPair && (
                    <Text
                      style={[styles.muted, styles.errorText, { marginTop: 8 }]}
                    >
                      This pair is not available for margin yet.
                    </Text>
                  )}
                  <Pressable
                    onPress={onCreateManager}
                    disabled={createManagerLoading}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      {
                        backgroundColor: colors.tint,
                        opacity: pressed || createManagerLoading ? 0.8 : 1,
                        marginTop: 16,
                        minHeight: 48,
                        justifyContent: "center",
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Create margin manager"
                  >
                    {createManagerLoading ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.background}
                      />
                    ) : (
                      <Text
                        style={[
                          styles.primaryButtonText,
                          { color: colors.background },
                        ]}
                      >
                        Create margin manager
                      </Text>
                    )}
                  </Pressable>
                </>
              ) : (
                <>
                  {matchesForThisPool.length > 1 && (
                    <Pressable
                      onPress={onSwitchMarginAccount}
                      style={({ pressed }) => [
                        styles.row,
                        { marginBottom: 12, opacity: pressed ? 0.8 : 1 },
                      ]}
                    >
                      <Text style={styles.muted}>Account</Text>
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <Text style={styles.muted} numberOfLines={1}>
                          {marginManagerId && marginManagerId.length > 16
                            ? `${marginManagerId.slice(
                                0,
                                8
                              )}…${marginManagerId.slice(-8)}`
                            : marginManagerId}
                        </Text>
                        <Text style={[styles.value, { color: colors.tint }]}>
                          Switch
                        </Text>
                      </View>
                    </Pressable>
                  )}
                  {stateLoading && !state && (
                    <View style={styles.row}>
                      <ActivityIndicator size="small" color={colors.tint} />
                      <Text style={styles.muted}>Loading state…</Text>
                    </View>
                  )}
                  {stateError && (
                    <Text style={styles.errorText}>{stateError}</Text>
                  )}
                  {state && (
                    <>
                      <View style={styles.row}>
                        <Text style={styles.muted}>Collateral (USD)</Text>
                        <Text style={styles.value}>
                          $
                          {collateralUsdTotal.toLocaleString("en-US", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </Text>
                      </View>
                      <View style={styles.row}>
                        <Text style={styles.muted}>Debt (USD)</Text>
                        <Text style={styles.value}>
                          ${debtUsdFromState(state)}
                        </Text>
                      </View>
                      <View style={styles.row}>
                        <Text style={styles.muted}>Risk ratio</Text>
                        <Text
                          style={[
                            styles.value,
                            // If no debt, show neutral styling; otherwise color by simple health band.
                            (Number(state.base_debt) ||
                              Number(state.quote_debt)) === 0
                              ? styles.muted
                              : parseFloat(state.risk_ratio) < 1.1
                              ? styles.riskWarning
                              : styles.healthOk,
                          ]}
                        >
                          {(Number(state.base_debt) ||
                            Number(state.quote_debt)) === 0
                            ? "No debt"
                            : `${formatRiskRatio(state.risk_ratio)}×`}
                        </Text>
                      </View>
                      <View style={{ marginTop: 8, marginBottom: 4 }}>
                        <Text style={styles.muted}>Balances</Text>
                      </View>
                      {[
                        {
                          key: "base" as const,
                          value: marginBalances.base,
                          label: poolInfoForPair?.base_asset_symbol ?? "Base",
                        },
                        {
                          key: "quote" as const,
                          value: marginBalances.quote,
                          label: poolInfoForPair?.quote_asset_symbol ?? "Quote",
                        },
                        {
                          key: "deep" as const,
                          value: marginBalances.deep,
                          label: "DEEP",
                        },
                      ].map(({ key, value, label }) => {
                        const isNegative =
                          value != null && !Number.isNaN(value) && value < 0;
                        const absValue =
                          value != null && !Number.isNaN(value)
                            ? Math.abs(value)
                            : null;
                        return (
                          <View
                            key={key}
                            style={[styles.row, { marginTop: 4 }]}
                          >
                            <Text style={styles.muted}>{label}</Text>
                            <Text
                              style={[
                                styles.value,
                                isNegative && styles.riskWarning,
                              ]}
                            >
                              {absValue != null
                                ? isNegative
                                  ? `-${absValue.toLocaleString(undefined, {
                                      minimumFractionDigits: 0,
                                      maximumFractionDigits: 6,
                                    })} (borrowed)`
                                  : absValue.toLocaleString(undefined, {
                                      minimumFractionDigits: 0,
                                      maximumFractionDigits: 6,
                                    })
                                : "—"}
                            </Text>
                          </View>
                        );
                      })}
                      {decodedPoolName && (
                        <View style={styles.row}>
                          <Text style={styles.muted}>Max position (est.)</Text>
                          <Text style={styles.value}>
                            $
                            {(() => {
                              const debtStr = debtUsdFromState(state).replace(
                                /,/g,
                                ""
                              );
                              const equity = Math.max(
                                0,
                                collateralUsdTotal - parseFloat(debtStr)
                              );
                              const leverage =
                                getMaxLeverageForPool(decodedPoolName);
                              const maxPos = equity * leverage;
                              return maxPos.toLocaleString("en-US", {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              });
                            })()}{" "}
                            <Text style={styles.muted}>
                              (up to {getMaxLeverageForPool(decodedPoolName)}×)
                            </Text>
                          </Text>
                        </View>
                      )}
                      {collateral.length > 0 &&
                        collateralUsdTotal === 0 &&
                        parseFloat(
                          debtUsdFromState(state).replace(/,/g, "")
                        ) === 0 && (
                          <Text
                            style={[
                              styles.muted,
                              { marginTop: 8, fontStyle: "italic" },
                            ]}
                          >
                            Balance may be updating… (indexer can lag 1–2 min
                            behind activity)
                          </Text>
                        )}
                    </>
                  )}
                </>
              )}
            </View>

            {hasManager && (
              <>
                <Text style={styles.sectionTitle}>Actions</Text>
                <View style={styles.actionsRow}>
                  <Pressable
                    onPress={onDeposit}
                    style={({ pressed }) => [
                      styles.actionButton,
                      { borderColor: colors.tint, opacity: pressed ? 0.8 : 1 },
                    ]}
                  >
                    <Text
                      style={[styles.actionButtonText, { color: colors.tint }]}
                    >
                      Deposit
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={onWithdraw}
                    style={({ pressed }) => [
                      styles.actionButton,
                      {
                        borderColor: colors.tabIconDefault,
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.actionButtonText, { color: colors.text }]}
                    >
                      Withdraw
                    </Text>
                  </Pressable>
                </View>

                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 4,
                  }}
                >
                  <Text style={styles.sectionTitle}>Activity</Text>
                  <Pressable
                    onPress={refreshMarginHistory}
                    disabled={historyLoading}
                    style={({ pressed }) => ({
                      padding: 6,
                      opacity: historyLoading ? 0.6 : pressed ? 0.8 : 1,
                    })}
                    hitSlop={8}
                  >
                    <FontAwesome name="refresh" size={18} color={colors.tint} />
                  </Pressable>
                </View>
                <View style={styles.card}>
                  {historyLoading &&
                    !collateral.length &&
                    !borrowed.length &&
                    !repaid.length &&
                    !liquidations.length && (
                      <ActivityIndicator size="small" color={colors.tint} />
                    )}
                  {historyError && (
                    <Text style={styles.errorText}>{historyError}</Text>
                  )}
                  {liquidations.length > 0 &&
                    liquidations.slice(0, 5).map((e, i) => (
                      <View
                        key={`liq-${e.event_digest}-${i}`}
                        style={styles.historyRow}
                      >
                        <Text style={styles.sell}>Liquidated</Text>
                        <Text style={styles.orderDetail}>
                          {formatTs(e.checkpoint_timestamp_ms)} ·{" "}
                          {formatLoanAmount(e.liquidation_amount, e.margin_pool_id)}
                        </Text>
                      </View>
                    ))}
                  {collateral.slice(0, 5).map((e, i) => (
                    <View
                      key={`col-${e.event_digest}-${i}`}
                      style={styles.historyRow}
                    >
                      <Text
                        style={
                          e.event_type?.toLowerCase() === "deposit"
                            ? styles.buy
                            : styles.sell
                        }
                      >
                        {e.event_type}
                      </Text>
                      <Text style={styles.orderDetail}>
                        {formatTs(e.checkpoint_timestamp_ms)} ·{" "}
                        {formatCollateralAmount(e.amount, e.asset_type)}
                      </Text>
                    </View>
                  ))}
                  {borrowed.slice(0, 5).map((e, i) => (
                    <View
                      key={`bor-${e.event_digest}-${i}`}
                      style={styles.historyRow}
                    >
                      <Text style={styles.buy}>Borrow</Text>
                      <Text style={styles.orderDetail}>
                        {formatTs(e.checkpoint_timestamp_ms)} ·{" "}
                        {formatLoanAmount(e.loan_amount, e.margin_pool_id)}
                      </Text>
                    </View>
                  ))}
                  {repaid.slice(0, 5).map((e, i) => (
                    <View
                      key={`rep-${e.event_digest}-${i}`}
                      style={styles.historyRow}
                    >
                      <Text style={styles.sell}>Repay</Text>
                      <Text style={styles.orderDetail}>
                        {formatTs(e.checkpoint_timestamp_ms)} ·{" "}
                        {formatLoanAmount(e.repay_amount, e.margin_pool_id)}
                      </Text>
                    </View>
                  ))}
                  {!historyLoading &&
                    collateral.length === 0 &&
                    borrowed.length === 0 &&
                    repaid.length === 0 &&
                    liquidations.length === 0 &&
                    !historyError && (
                      <Text style={styles.muted}>No activity yet.</Text>
                    )}
                </View>
              </>
            )}

            <Text style={styles.sectionTitle}>Place order</Text>
            <View style={styles.card}>
              <View style={styles.orderSideRow}>
                <Pressable
                  onPress={() => setOrderSide("buy")}
                  style={[
                    styles.sideButton,
                    orderSide === "buy" && {
                      backgroundColor: "#22c55e",
                      opacity: 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.sideButtonText,
                      orderSide === "buy" && styles.sideButtonTextActive,
                    ]}
                  >
                    Buy
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setOrderSide("sell")}
                  style={[
                    styles.sideButton,
                    orderSide === "sell" && {
                      backgroundColor: "#ef4444",
                      opacity: 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.sideButtonText,
                      orderSide === "sell" && styles.sideButtonTextActive,
                    ]}
                  >
                    Sell
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.inputLabel}>Order type</Text>
              <View style={styles.orderSideRow}>
                <Pressable
                  onPress={() => setOrderType("limit")}
                  style={[
                    styles.sideButton,
                    orderType === "limit" && {
                      backgroundColor: colors.tint,
                      opacity: 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.sideButtonText,
                      orderType === "limit" && {
                        color: colors.background,
                        opacity: 1,
                        fontWeight: "600",
                      },
                    ]}
                  >
                    Limit
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setOrderType("market")}
                  style={[
                    styles.sideButton,
                    orderType === "market" && {
                      backgroundColor: colors.tint,
                      opacity: 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.sideButtonText,
                      orderType === "market" && {
                        color: colors.background,
                        opacity: 1,
                        fontWeight: "600",
                      },
                    ]}
                  >
                    Market
                  </Text>
                </Pressable>
              </View>
              {orderType === "limit" && (
                <>
                  <Text style={styles.inputLabel}>Price</Text>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        color: colors.text,
                        borderColor: colors.tabIconDefault,
                      },
                    ]}
                    placeholder="0.00"
                    placeholderTextColor={colors.tabIconDefault}
                    value={price}
                    onChangeText={setPrice}
                    keyboardType="decimal-pad"
                  />
                </>
              )}
              <Text style={styles.inputLabel}>
                Your margin ({poolInfoForPair?.base_asset_symbol ?? "base"})
              </Text>
              <View style={styles.quantityRow}>
                <TextInput
                  style={[
                    styles.input,
                    styles.quantityInput,
                    { color: colors.text, borderColor: colors.tabIconDefault },
                  ]}
                  placeholder="0"
                  placeholderTextColor={colors.tabIconDefault}
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType="decimal-pad"
                />
                <Pressable
                  onPress={setMarginToMax}
                  disabled={maxMarginBase == null || maxMarginBase <= 0}
                  style={[
                    styles.optionChip,
                    {
                      borderColor: colors.tabIconDefault,
                      backgroundColor:
                        maxMarginBase != null && maxMarginBase > 0
                          ? colors.tint
                          : "transparent",
                      opacity:
                        maxMarginBase != null && maxMarginBase > 0 ? 1 : 0.5,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.optionChipText,
                      {
                        color:
                          maxMarginBase != null && maxMarginBase > 0
                            ? colors.background
                            : colors.text,
                      },
                    ]}
                  >
                    Max
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.optionsHint}>
                Position = margin × {leverage}× (you put in margin, protocol
                borrows the rest). Min position: {MIN_ORDER_QUANTITY}. Max =
                use full equity.
              </Text>
              <Text style={styles.inputLabel}>Leverage</Text>
              <View style={styles.leverageRow}>
                {leverageOptions.map((x) => (
                  <Pressable
                    key={x}
                    onPress={() => setLeverage(x)}
                    style={[
                      styles.optionChip,
                      {
                        borderColor: colors.tabIconDefault,
                        backgroundColor:
                          leverage === x ? colors.tint : "transparent",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        {
                          color:
                            leverage === x ? colors.background : colors.text,
                          opacity: leverage === x ? 1 : 0.8,
                        },
                      ]}
                    >
                      {x}×
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={[styles.optionsHint, { marginTop: 2 }]}>
                Leverage sets max quantity (equity × leverage ÷ price). Protocol
                borrows as needed when you place the order.
              </Text>
              <Text style={styles.inputLabel}>Pay with</Text>
              <View style={styles.payWithRow}>
                {(["base", "quote", "deep"] as const).map((a) => {
                  const isSelected = paymentAsset === a;
                  return (
                    <Pressable
                      key={a}
                      onPress={() => setPaymentAsset(a)}
                      style={[
                        styles.optionChip,
                        {
                          borderColor: isSelected
                            ? colors.tint
                            : colors.tabIconDefault,
                          backgroundColor: isSelected
                            ? `${colors.tint}20`
                            : "transparent",
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.optionChipText,
                          {
                            color: isSelected ? colors.tint : colors.text,
                            opacity: isSelected ? 1 : 0.7,
                          },
                        ]}
                      >
                        {assetLabel(a)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.optionsHint}>
                {paymentAssetBalance != null
                  ? `Max ${paymentAssetBalance.toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 6,
                    })} ${assetLabel(paymentAsset)}`
                  : `Pay with ${assetLabel(paymentAsset)}`}
              </Text>
              <Text style={styles.optionsLabel}>Take profit · Stop loss</Text>
              <View style={styles.tpslRow}>
                <View style={styles.tpslInputWrap}>
                  <Text style={styles.tpslInputLabel}>TP</Text>
                  <TextInput
                    style={[
                      styles.tpslInput,
                      {
                        color: colors.text,
                        borderColor: colors.tabIconDefault,
                      },
                    ]}
                    placeholder="—"
                    placeholderTextColor={colors.tabIconDefault}
                    value={tpPrice}
                    onChangeText={setTpPrice}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={styles.tpslInputWrap}>
                  <Text style={styles.tpslInputLabel}>SL</Text>
                  <TextInput
                    style={[
                      styles.tpslInput,
                      {
                        color: colors.text,
                        borderColor: colors.tabIconDefault,
                      },
                    ]}
                    placeholder="—"
                    placeholderTextColor={colors.tabIconDefault}
                    value={slPrice}
                    onChangeText={setSlPrice}
                    keyboardType="decimal-pad"
                  />
                </View>
                <Pressable
                  onPress={onSetTpsl}
                  disabled={tpslLoading || (!tpPrice.trim() && !slPrice.trim())}
                  style={[
                    styles.tpslButton,
                    {
                      backgroundColor: colors.tint,
                      opacity:
                        tpslLoading || (!tpPrice.trim() && !slPrice.trim())
                          ? 0.5
                          : 1,
                    },
                  ]}
                >
                  {tpslLoading ? (
                    <ActivityIndicator size="small" color={colors.background} />
                  ) : (
                    <Text
                      style={[
                        styles.tpslButtonText,
                        { color: colors.background },
                      ]}
                    >
                      Set
                    </Text>
                  )}
                </Pressable>
              </View>
              <Pressable
                onPress={onPlaceOrder}
                disabled={orderLoading}
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    backgroundColor: colors.tint,
                    opacity: orderLoading ? 0.7 : pressed ? 0.8 : 1,
                  },
                ]}
              >
                {orderLoading ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <Text
                    style={[
                      styles.primaryButtonText,
                      { color: colors.background },
                    ]}
                  >
                    Place order
                  </Text>
                )}
              </Pressable>
            </View>

            {livePnl.hasPosition &&
              livePnl.hasDebt &&
              livePnl.positionSide !== "none" && (
              <>
                <Text style={styles.sectionTitle}>Position</Text>
                <View style={styles.card}>
                  <Text style={[styles.muted, { marginBottom: 12 }]}>
                    Size and side from margin state; entry and unrealized PnL
                    from trade history (indexer). If entry shows —, the indexer
                    may not have your trades yet. Close flattens with a market
                    order.
                  </Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={true}
                    style={styles.positionTableScroll}
                    contentContainerStyle={styles.positionTableContent}
                  >
                    <View style={styles.positionTable}>
                      <View style={styles.positionTableRow}>
                        <View style={[styles.positionTableCell, styles.positionTableHeader]}>
                          <Text style={[styles.positionTableHeaderText, { color: colors.text }]}>Side</Text>
                        </View>
                        <View style={[styles.positionTableCell, styles.positionTableHeader]}>
                          <Text style={[styles.positionTableHeaderText, { color: colors.text }]}>Size</Text>
                        </View>
                        <View style={[styles.positionTableCell, styles.positionTableHeader]}>
                          <Text style={[styles.positionTableHeaderText, { color: colors.text }]}>Entry</Text>
                        </View>
                        <View style={[styles.positionTableCell, styles.positionTableHeader]}>
                          <Text style={[styles.positionTableHeaderText, { color: colors.text }]}>Mark</Text>
                        </View>
                        <View style={[styles.positionTableCell, styles.positionTableHeader]}>
                          <Text style={[styles.positionTableHeaderText, { color: colors.text }]}>Δ%</Text>
                        </View>
                        <View style={[styles.positionTableCell, styles.positionTableHeader]}>
                          <Text style={[styles.positionTableHeaderText, { color: colors.text }]}>Unrealized</Text>
                        </View>
                      </View>
                      <ScrollView
                        nestedScrollEnabled
                        style={styles.positionTableBodyScroll}
                        showsVerticalScrollIndicator={true}
                      >
                        <View style={styles.positionTableRow}>
                        <View style={[styles.positionTableCell, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.tabIconDefault }]}>
                          <Text
                            style={[
                              styles.positionTableCellText,
                              {
                                color:
                                  livePnl.positionSide === "long"
                                    ? (colors as { positive?: string }).positive ?? "#22c55e"
                                    : (colors as { negative?: string }).negative ?? "#ef4444",
                                fontWeight: "600",
                              },
                            ]}
                          >
                            {livePnl.positionSide === "long" ? "Long" : "Short"}
                          </Text>
                        </View>
                        <View style={[styles.positionTableCell, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.tabIconDefault }]}>
                          <Text style={[styles.positionTableCellText, { color: colors.text }]}>
                            {(() => {
                              const latestTrade = tradeHistory[0];
                              if (latestTrade && latestTrade.quote_volume != null) {
                                return `${Number(latestTrade.quote_volume).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${livePnl.quoteSymbol}`;
                              }
                              const entryOrMark = livePnl.avgEntryQuote > 0 ? livePnl.avgEntryQuote : livePnl.currentPrice;
                              const sizeUsdc = entryOrMark > 0 ? Math.abs(livePnl.netBasePosition) * entryOrMark : 0;
                              return sizeUsdc > 0
                                ? `${sizeUsdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${livePnl.quoteSymbol}`
                                : `${Math.abs(livePnl.netBasePosition).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${livePnl.baseSymbol}`;
                            })()}
                          </Text>
                        </View>
                        <View style={[styles.positionTableCell, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.tabIconDefault }]}>
                          <Text style={[styles.positionTableCellText, { color: colors.text }]}>
                            {(() => {
                              const latestTrade = tradeHistory[0];
                              if (latestTrade && latestTrade.price != null) {
                                return `${Number(latestTrade.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${livePnl.quoteSymbol}`;
                              }
                              return livePnl.avgEntryQuote > 0
                                ? `${livePnl.avgEntryQuote.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${livePnl.quoteSymbol}`
                                : "—";
                            })()}
                          </Text>
                        </View>
                        <View style={[styles.positionTableCell, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.tabIconDefault }]}>
                          <Text style={[styles.positionTableCellText, { color: colors.text }]}>
                            {livePnl.currentPrice > 0
                              ? `${livePnl.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${livePnl.quoteSymbol}`
                              : "—"}
                          </Text>
                        </View>
                        <View style={[styles.positionTableCell, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.tabIconDefault }]}>
                          {(() => {
                            const latestTrade = tradeHistory[0];
                            const entryPrice = latestTrade?.price ?? livePnl.avgEntryQuote;
                            if (entryPrice > 0 && livePnl.currentPrice > 0) {
                              const pctChange =
                                livePnl.positionSide === "long"
                                  ? ((livePnl.currentPrice - entryPrice) / entryPrice) * 100
                                  : ((entryPrice - livePnl.currentPrice) / entryPrice) * 100;
                              const positive = pctChange >= 0;
                              return (
                                <Text
                                  style={[
                                    styles.positionTableCellText,
                                    {
                                      fontWeight: "600",
                                      color: positive
                                        ? (colors as { positive?: string }).positive ?? "#22c55e"
                                        : (colors as { negative?: string }).negative ?? "#ef4444",
                                    },
                                  ]}
                                >
                                  {positive ? "+" : ""}
                                  {pctChange.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%
                                </Text>
                              );
                            }
                            return <Text style={[styles.positionTableCellText, styles.muted]}>—</Text>;
                          })()}
                        </View>
                        <View style={[styles.positionTableCell, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.tabIconDefault }]}>
                          {(() => {
                            const latestTrade = tradeHistory[0];
                            const entryPrice = latestTrade?.price ?? livePnl.avgEntryQuote;
                            const quoteVol = latestTrade?.quote_volume != null ? Number(latestTrade.quote_volume) : 0;
                            const mark = livePnl.currentPrice;
                            const unrealized =
                              entryPrice > 0 && mark > 0 && quoteVol > 0
                                ? livePnl.positionSide === "long"
                                  ? quoteVol * (mark - entryPrice) / entryPrice
                                  : quoteVol * (entryPrice - mark) / entryPrice
                                : livePnl.hasKnownEntry
                                  ? livePnl.unrealizedPnlQuote
                                  : null;
                            if (unrealized === null) {
                              return (
                                <Text style={[styles.positionTableCellText, styles.muted]}>
                                  — (entry unknown)
                                </Text>
                              );
                            }
                            const positive = unrealized >= 0;
                            return (
                              <Text
                                style={[
                                  styles.positionTableCellText,
                                  {
                                    fontWeight: "600",
                                    color: positive
                                      ? (colors as { positive?: string }).positive ?? "#22c55e"
                                      : (colors as { negative?: string }).negative ?? "#ef4444",
                                  },
                                ]}
                              >
                                {positive ? "+" : ""}
                                {unrealized.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} {livePnl.quoteSymbol}
                              </Text>
                            );
                          })()}
                        </View>
                        </View>
                      </ScrollView>
                    </View>
                  </ScrollView>
                  <Pressable
                    onPress={onClosePosition}
                    disabled={closePositionLoading}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      {
                        marginTop: 12,
                        backgroundColor:
                          livePnl.positionSide === "long"
                            ? "#ef4444"
                            : "#22c55e",
                        opacity: closePositionLoading ? 0.6 : pressed ? 0.8 : 1,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Close position"
                  >
                    {closePositionLoading ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.background}
                      />
                    ) : (
                      <Text
                        style={[
                          styles.primaryButtonText,
                          { color: colors.background },
                        ]}
                      >
                        Close position
                      </Text>
                    )}
                  </Pressable>
                </View>
              </>
            )}

          </>
        )}
      </ScrollView>

      {/* Always-mounted overlay so opening/closing never adds/removes nodes and the chart keeps its gradient. */}
      <View
        style={[
          styles.accountPickerBackdrop,
          {
            opacity:
              accountPickerVisible ||
              depositModalVisible ||
              withdrawModalVisible
                ? 1
                : 0,
            pointerEvents:
              accountPickerVisible ||
              depositModalVisible ||
              withdrawModalVisible
                ? "auto"
                : "none",
          },
        ]}
        collapsable={false}
      >
        <Pressable
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: accountPickerVisible ? 1 : 0,
              pointerEvents: accountPickerVisible ? "auto" : "none",
              justifyContent: "center",
              alignItems: "center",
              padding: 24,
            },
          ]}
          onPress={() => setAccountPickerVisible(false)}
        >
          <Pressable
            style={[
              styles.accountPickerCard,
              {
                backgroundColor: colors.background,
                borderColor: colors.tabIconDefault,
              },
            ]}
            onPress={() => {}}
          >
            <Text style={[styles.accountPickerTitle, { color: colors.text }]}>
              Choose margin account
            </Text>
            <Text style={[styles.accountPickerMessage, { color: colors.text }]}>
              You have multiple margin accounts for this pair. Select which one
              to use (e.g. if you created one elsewhere).
            </Text>
            <ScrollView
              style={styles.accountPickerList}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {matchesForThisPool.map((m) => {
                const id = m.margin_manager_id;
                const label =
                  id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
                const isSelected = marginManagerId === id;
                return (
                  <Pressable
                    key={id}
                    onPress={() => onSelectMarginAccount(id)}
                    style={({ pressed }) => [
                      styles.accountPickerOption,
                      { borderColor: colors.tabIconDefault },
                      isSelected && {
                        borderColor: colors.tint,
                        backgroundColor: `${colors.tint}18`,
                      },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.accountPickerOptionText,
                        { color: colors.text },
                        isSelected && { color: colors.tint, fontWeight: "600" },
                      ]}
                      numberOfLines={1}
                    >
                      {label}
                    </Text>
                    {isSelected && (
                      <Text
                        style={[
                          styles.accountPickerCheck,
                          { color: colors.tint },
                        ]}
                      >
                        ✓
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
            <Pressable
              onPress={() => setAccountPickerVisible(false)}
              style={({ pressed }) => [
                styles.accountPickerCancel,
                {
                  borderColor: colors.tabIconDefault,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Text
                style={[styles.accountPickerCancelText, { color: colors.text }]}
              >
                Cancel
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>

        <Pressable
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: depositModalVisible ? 1 : 0,
              pointerEvents: depositModalVisible ? "auto" : "none",
              justifyContent: "center",
              alignItems: "center",
              padding: 24,
            },
          ]}
          onPress={() => setDepositModalVisible(false)}
        >
          <Pressable
            style={[
              styles.accountPickerCard,
              {
                backgroundColor: colors.background,
                borderColor: colors.tabIconDefault,
              },
            ]}
            onPress={() => {}}
          >
            <Text style={[styles.accountPickerTitle, { color: colors.text }]}>
              Deposit
            </Text>
            <Text style={[styles.accountPickerMessage, { color: colors.text }]}>
              Choose asset and amount. Min: {MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT}
              .
            </Text>
            <View style={styles.depositWithdrawAssetRow}>
              {(["base", "quote", "deep"] as const).map((a) => {
                const isSelected = depositAsset === a;
                return (
                  <Pressable
                    key={a}
                    onPress={() => setDepositAsset(a)}
                    style={[
                      styles.depositWithdrawAssetBtn,
                      {
                        borderWidth: isSelected ? 2 : 1,
                        borderColor: isSelected
                          ? colors.tint
                          : colors.tabIconDefault,
                        backgroundColor: isSelected
                          ? colors.tint.length <= 4
                            ? "rgba(255,255,255,0.12)"
                            : `${colors.tint}20`
                          : "transparent",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.depositWithdrawAssetBtnText,
                        {
                          color: isSelected ? colors.tint : colors.text,
                          fontWeight: isSelected ? "700" : "600",
                        },
                      ]}
                    >
                      {assetLabel(a)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {depositBalanceLoading ? (
              <Text style={[styles.muted, { marginBottom: 8 }]}>
                Loading balance…
              </Text>
            ) : depositWalletBalanceRaw != null ? (
              <Text style={[styles.muted, { marginBottom: 8 }]}>{`Available: ${(
                Number(depositWalletBalanceRaw) /
                Math.pow(10, getDecimalsForAsset(depositAsset))
              ).toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 6,
              })} ${assetLabel(depositAsset)}`}</Text>
            ) : null}
            <Text style={[styles.inputLabel, { color: colors.text }]}>
              Amount
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  color: colors.text,
                  borderColor: depositAmountExceedsBalance
                    ? "#c00"
                    : colors.tabIconDefault,
                },
              ]}
              placeholder="0.00"
              placeholderTextColor={colors.tabIconDefault}
              value={depositAmount}
              onChangeText={setDepositAmount}
              keyboardType="decimal-pad"
            />
            {depositAmountExceedsBalance && (
              <Text style={styles.errorText}>Amount exceeds your balance</Text>
            )}
            <View style={styles.depositWithdrawActions}>
              <Pressable
                onPress={() => setDepositModalVisible(false)}
                style={[
                  styles.accountPickerCancel,
                  { borderColor: colors.tabIconDefault },
                ]}
              >
                <Text
                  style={[
                    styles.accountPickerCancelText,
                    { color: colors.text },
                  ]}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={onDepositSubmit}
                disabled={
                  depositLoading ||
                  depositAmountExceedsBalance ||
                  !depositAmount.trim() ||
                  parseFloat(depositAmount) < MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT
                }
                style={[
                  styles.primaryButton,
                  {
                    backgroundColor: colors.tint,
                    opacity:
                      depositLoading ||
                      depositAmountExceedsBalance ||
                      !depositAmount.trim() ||
                      parseFloat(depositAmount) <
                        MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT
                        ? 0.6
                        : 1,
                    flex: 1,
                  },
                ]}
              >
                {depositLoading ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <Text
                    style={[
                      styles.primaryButtonText,
                      { color: colors.background },
                    ]}
                  >
                    Deposit
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>

        <Pressable
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: withdrawModalVisible ? 1 : 0,
              pointerEvents: withdrawModalVisible ? "auto" : "none",
              justifyContent: "center",
              alignItems: "center",
              padding: 24,
            },
          ]}
          onPress={() => setWithdrawModalVisible(false)}
        >
          <Pressable
            style={[
              styles.accountPickerCard,
              {
                backgroundColor: colors.background,
                borderColor: colors.tabIconDefault,
              },
            ]}
            onPress={() => {}}
          >
            <Text style={[styles.accountPickerTitle, { color: colors.text }]}>
              Withdraw
            </Text>
            <Text style={[styles.accountPickerMessage, { color: colors.text }]}>
              Withdrawals must keep risk ratio healthy. Min:{" "}
              {MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT}.
            </Text>
            <View style={styles.depositWithdrawAssetRow}>
              {(["base", "quote", "deep"] as const).map((a) => {
                const isSelected = withdrawAsset === a;
                return (
                  <Pressable
                    key={a}
                    onPress={() => setWithdrawAsset(a)}
                    style={[
                      styles.depositWithdrawAssetBtn,
                      {
                        borderWidth: isSelected ? 2 : 1,
                        borderColor: isSelected
                          ? colors.tint
                          : colors.tabIconDefault,
                        backgroundColor: isSelected
                          ? colors.tint.length <= 4
                            ? "rgba(255,255,255,0.12)"
                            : `${colors.tint}20`
                          : "transparent",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.depositWithdrawAssetBtnText,
                        {
                          color: isSelected ? colors.tint : colors.text,
                          fontWeight: isSelected ? "700" : "600",
                        },
                      ]}
                    >
                      {assetLabel(a)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {withdrawAsset !== "deep" && withdrawAvailableHuman != null ? (
              <Text
                style={[styles.muted, { marginBottom: 8 }]}
              >{`Available: ${withdrawAvailableHuman.toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 6,
              })} ${assetLabel(withdrawAsset)}`}</Text>
            ) : null}
            <Text style={[styles.inputLabel, { color: colors.text }]}>
              Amount
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  color: colors.text,
                  borderColor: withdrawAmountExceedsBalance
                    ? "#c00"
                    : colors.tabIconDefault,
                },
              ]}
              placeholder="0.00"
              placeholderTextColor={colors.tabIconDefault}
              value={withdrawAmount}
              onChangeText={setWithdrawAmount}
              keyboardType="decimal-pad"
            />
            {withdrawAmountExceedsBalance && (
              <Text style={styles.errorText}>
                Amount exceeds your margin balance
              </Text>
            )}
            <View style={styles.depositWithdrawActions}>
              <Pressable
                onPress={() => setWithdrawModalVisible(false)}
                style={[
                  styles.accountPickerCancel,
                  { borderColor: colors.tabIconDefault },
                ]}
              >
                <Text
                  style={[
                    styles.accountPickerCancelText,
                    { color: colors.text },
                  ]}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={onWithdrawSubmit}
                disabled={
                  withdrawLoading ||
                  withdrawAmountExceedsBalance ||
                  !withdrawAmount.trim() ||
                  parseFloat(withdrawAmount) <
                    MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT
                }
                style={[
                  styles.primaryButton,
                  {
                    backgroundColor: colors.tint,
                    opacity:
                      withdrawLoading ||
                      withdrawAmountExceedsBalance ||
                      !withdrawAmount.trim() ||
                      parseFloat(withdrawAmount) <
                        MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT
                        ? 0.6
                        : 1,
                    flex: 1,
                  },
                ]}
              >
                {withdrawLoading ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <Text
                    style={[
                      styles.primaryButtonText,
                      { color: colors.background },
                    ]}
                  >
                    Withdraw
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flex: 1 },
  container: { flexGrow: 1, padding: 24, paddingBottom: 48 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  pairHeader: { marginBottom: 20 },
  pairHeaderTopRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  pairName: { fontSize: 28, fontWeight: "700" },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  card: {
    padding: 20,
    borderRadius: 12,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.3)",
  },
  positionTableScroll: {
    maxHeight: 220,
    marginBottom: 4,
  },
  positionTableContent: {
    flexGrow: 1,
  },
  positionTableBodyScroll: {
    maxHeight: 160,
  },
  positionTable: {
    flexDirection: "column",
    minWidth: "100%",
  },
  positionTableRow: {
    flexDirection: "row",
    width: 600,
    minWidth: 600,
  },
  positionTableCell: {
    width: 100,
    minWidth: 100,
    paddingVertical: 10,
    paddingHorizontal: 10,
    paddingRight: 12,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: "rgba(128,128,128,0.35)",
    justifyContent: "flex-start",
    alignItems: "flex-start",
  },
  positionTableHeader: {
    paddingBottom: 8,
  },
  positionTableHeaderText: {
    fontSize: 12,
    fontWeight: "600",
    opacity: 0.85,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    textAlign: "left",
  },
  positionTableCellText: {
    fontSize: 14,
    textAlign: "left",
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    opacity: 0.85,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  chartHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  chartHeaderButtons: { flexDirection: "row", gap: 8 },
  intervalRow: { flexDirection: "row", marginBottom: 12, paddingVertical: 4 },
  intervalButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginRight: 6,
    minWidth: 40,
    alignItems: "center",
  },
  intervalButtonText: { fontSize: 12, fontWeight: "600" },
  enlargeHeaderButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  enlargeHeaderIcon: {
    fontSize: 14,
    fontWeight: "700",
    color: "#f9fafb",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  priceWithArrow: { flexDirection: "row", alignItems: "center", gap: 6 },
  priceArrow: { fontSize: 12, fontWeight: "700" },
  value: { fontSize: 16, fontWeight: "600" },
  priceUp: { color: "#22c55e" },
  priceDown: { color: "#ef4444" },
  muted: { fontSize: 14, opacity: 0.7 },
  healthOk: { color: "#22c55e" },
  riskWarning: { color: "#ef4444" },
  errorText: { fontSize: 14, color: "#ef4444", marginBottom: 8 },
  sectionTitle: { fontSize: 18, fontWeight: "600", marginBottom: 12 },
  marginHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  marginRefreshButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  marginRefreshIcon: {
    fontSize: 16,
    color: "#888",
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 24,
  },
  actionButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
  },
  actionButtonText: { fontSize: 14, fontWeight: "600" },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
    opacity: 0.8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 16,
  },
  quantityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  quantityInput: { flex: 1, marginBottom: 0 },
  primaryButton: { paddingVertical: 14, borderRadius: 8, alignItems: "center" },
  primaryButtonText: { fontSize: 16, fontWeight: "600" },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  checkmark: { color: "#fff", fontWeight: "bold", fontSize: 14 },
  orderSideRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  optionsLabel: {
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 6,
    opacity: 0.65,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  leverageRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  payWithRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 6,
  },
  optionChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
  },
  optionChipText: { fontSize: 13, fontWeight: "600" },
  optionsHint: {
    fontSize: 11,
    opacity: 0.6,
    marginBottom: 16,
  },
  tpslRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    marginBottom: 16,
  },
  tpslInputWrap: {
    flex: 1,
    minWidth: 0,
  },
  tpslInputLabel: {
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 4,
    opacity: 0.65,
  },
  tpslInput: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  tpslButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 6,
    justifyContent: "center",
    minWidth: 52,
  },
  tpslButtonText: { fontSize: 13, fontWeight: "600" },
  sideButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    backgroundColor: "rgba(128,128,128,0.2)",
  },
  sideButtonText: { fontSize: 16, fontWeight: "600", opacity: 0.8 },
  sideButtonTextActive: { color: "#fff", opacity: 1 },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(128,128,128,0.2)",
  },
  orderDetail: { flex: 1, fontSize: 14 },
  buy: { color: "#22c55e", fontWeight: "700", width: 56 },
  sell: { color: "#ef4444", fontWeight: "700", width: 56 },
  accountPickerBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  accountPickerCard: {
    width: "100%",
    maxWidth: 400,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    maxHeight: "80%",
  },
  accountPickerTitle: {
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 10,
  },
  accountPickerMessage: {
    fontSize: 14,
    opacity: 0.85,
    marginBottom: 20,
    lineHeight: 20,
  },
  accountPickerList: {
    maxHeight: 280,
    marginBottom: 16,
  },
  accountPickerOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  accountPickerOptionText: {
    fontSize: 15,
    flex: 1,
  },
  accountPickerCheck: {
    fontSize: 16,
    fontWeight: "700",
    marginLeft: 8,
  },
  accountPickerCancel: {
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
  },
  accountPickerCancelText: {
    fontSize: 16,
    fontWeight: "600",
  },
  depositWithdrawAssetRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 16,
  },
  depositWithdrawAssetBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
  },
  depositWithdrawAssetBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
  depositWithdrawActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
});
