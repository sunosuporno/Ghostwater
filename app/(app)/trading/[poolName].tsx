import { Text } from "@/components/Themed";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
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

import { PriceChart } from "@/components/PriceChart";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import {
  COIN_TYPES_MAINNET,
  getDecimalsForCoinType,
  getMaxLeverageForPool,
  MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT,
} from "@/constants/deepbook-margin-mainnet";
import {
  collateralUsdFromState,
  debtUsdFromState,
  useMarginHistory,
  useMarginManagersInfo,
  useMarginManagerState,
  useOhlcv,
  useOwnedMarginManagers,
  useTicker,
} from "@/hooks/useDeepBookMargin";
import { createMarginManagerViaBackend } from "@/lib/create-margin-manager-via-backend";
import {
  debugFetchOhlcv,
  formatRiskRatio,
  poolNameFromSymbols,
  type MarginManagerInfo,
  type OhlcvInterval,
} from "@/lib/deepbook-indexer";
import {
  depositMarginViaBackend,
  withdrawMarginViaBackend,
} from "@/lib/margin-deposit-withdraw-via-backend";
import {
  getSelectedMarginManagerId,
  setSelectedMarginManagerId,
} from "@/lib/margin-manager-storage";
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

  useEffect(() => {
    if (marginManagerId && state) {
      console.log("[Margin] Manager state", {
        marginManagerId,
        state,
      });
    }
  }, [marginManagerId, state]);

  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [payWithDeep, setPayWithDeep] = useState(true);
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

  // Derive available base/quote by summing activity: +deposits -withdrawals per asset.
  // Matches what the user sees in the Activity list and updates as soon as new events load.
  const availableFromEventSum = useMemo(() => {
    if (!collateral.length || !poolInfoForPair) return null;
    let base = 0;
    let quote = 0;
    for (const e of collateral) {
      const decimals = getDecimalsForCoinType(e.asset_type);
      const humanAmount = Number(e.amount) / Math.pow(10, decimals);
      const delta = e.event_type === "Deposit" ? humanAmount : -humanAmount;
      const symbol = symbolFromAssetType(e.asset_type);
      if (symbol === poolInfoForPair.base_asset_symbol) base += delta;
      else if (symbol === poolInfoForPair.quote_asset_symbol) quote += delta;
    }
    return { base, quote };
  }, [collateral, poolInfoForPair]);

  // Available balance for withdraw: use summed activity first, else state.
  const withdrawAvailableHuman = useMemo(() => {
    if (withdrawAsset === "deep") return null;
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
    if (!state) return null;
    if (withdrawAsset === "base") return Number(state.base_asset);
    if (withdrawAsset === "quote") return Number(state.quote_asset);
    return null;
  }, [withdrawAsset, availableFromEventSum, state]);

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
  ]);

  const assetLabel = (asset: "base" | "quote" | "deep") => {
    if (asset === "deep") return "DEEP";
    if (!poolInfoForPair) return asset;
    return asset === "base"
      ? poolInfoForPair.base_asset_symbol
      : poolInfoForPair.quote_asset_symbol;
  };

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

  const onPlaceOrder = () => {
    if (!price.trim() || !quantity.trim()) {
      Alert.alert("Place order", "Enter price and quantity.");
      return;
    }
    Alert.alert(
      "Place order",
      `Limit ${orderSide}: ${quantity} @ ${price} (Pay with DEEP: ${payWithDeep}). Will connect to SDK/backend.`
    );
  };

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
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pairHeader}>
          <Text style={[styles.pairName, { color: colors.text }]}>
            {displayPoolLabel}
          </Text>
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
                          ${collateralUsdFromState(state)}
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
                      {decodedPoolName && (
                        <View style={styles.row}>
                          <Text style={styles.muted}>Max position (est.)</Text>
                          <Text style={styles.value}>
                            $
                            {(() => {
                              const colStr = collateralUsdFromState(
                                state
                              ).replace(/,/g, "");
                              const debtStr = debtUsdFromState(state).replace(
                                /,/g,
                                ""
                              );
                              const equity = Math.max(
                                0,
                                parseFloat(colStr) - parseFloat(debtStr)
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
                        parseFloat(
                          collateralUsdFromState(state).replace(/,/g, "")
                        ) === 0 &&
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

                <Text style={styles.sectionTitle}>Activity</Text>
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
                          {e.liquidation_amount}
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
                          e.event_type === "Deposit" ? styles.buy : styles.sell
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
                        {formatTs(e.checkpoint_timestamp_ms)} · {e.loan_amount}
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
                        {formatTs(e.checkpoint_timestamp_ms)} · {e.repay_amount}
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

            <Text style={styles.sectionTitle}>Place limit order</Text>
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
              <Text style={styles.inputLabel}>Price</Text>
              <TextInput
                style={[
                  styles.input,
                  { color: colors.text, borderColor: colors.tabIconDefault },
                ]}
                placeholder="0.00"
                placeholderTextColor={colors.tabIconDefault}
                value={price}
                onChangeText={setPrice}
                keyboardType="decimal-pad"
              />
              <Text style={styles.inputLabel}>Quantity</Text>
              <TextInput
                style={[
                  styles.input,
                  { color: colors.text, borderColor: colors.tabIconDefault },
                ]}
                placeholder="0"
                placeholderTextColor={colors.tabIconDefault}
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="decimal-pad"
              />
              <Pressable
                onPress={() => setPayWithDeep((p) => !p)}
                style={styles.checkRow}
              >
                <Text style={styles.muted}>Pay with DEEP</Text>
                <View
                  style={[
                    styles.checkbox,
                    payWithDeep && { backgroundColor: colors.tint },
                  ]}
                >
                  {payWithDeep && <Text style={styles.checkmark}>✓</Text>}
                </View>
              </Pressable>
              <Pressable
                onPress={onPlaceOrder}
                style={({ pressed }) => [
                  styles.primaryButton,
                  { backgroundColor: colors.tint, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Text
                  style={[
                    styles.primaryButtonText,
                    { color: colors.background },
                  ]}
                >
                  Place order
                </Text>
              </Pressable>
            </View>

            <Text style={styles.sectionTitle}>Open orders</Text>
            <View style={styles.card}>
              <Text style={styles.muted}>
                Open orders come from DeepBook order book indexer.
              </Text>
            </View>
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
  pairName: { fontSize: 28, fontWeight: "700", marginBottom: 8 },
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
