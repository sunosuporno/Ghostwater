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
  AppState,
  AppStateStatus,
  Dimensions,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PriceChart } from "@/components/PriceChart";
import {
  TradingViewChart,
  type ChartTypeOption,
  type IndicatorOption,
  type PriceLineOption,
} from "@/components/TradingViewChart";
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
import { useNetwork } from "@/lib/network";
import { placeOrderViaBackend } from "@/lib/place-order-via-backend";
import { getSuiAddressFromUser, getSuiWalletFromUser } from "@/lib/sui";
import { fetchAllBaseBalances, type BaseBalanceItem } from "@/lib/base-balance-fetch";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_USDC_ADDRESS,
  BRIDGE_TO_MARGIN_DEFAULT_LEVERAGE,
  BRIDGE_TO_MARGIN_RECEIVE_TOKEN_SUI,
  SUI_CHAIN_ID,
} from "@/lib/bridge-to-margin-constants";
import { fetchLifiQuote, fetchLifiStatus, type LifiStatusResponse } from "@/lib/lifi-quote";
import { fetchAllSuiBalances, fetchSuiBalance } from "@/lib/sui-balance-fetch";
import { publicKeyToHex } from "@/lib/sui-transfer-via-backend";
import { useEmbeddedEthereumWallet } from "@privy-io/expo";
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
/** Candles shown in line chart (smaller = smoother pan). */
const CHART_DISPLAY_LIMIT = 100;
/** Candles fetched on load/poll (buffer for swipes without data lag). */
const CHART_FETCH_LIMIT = 200;
/** Trading view chart: more candles, fixed height. */
const TV_CHART_DISPLAY_LIMIT = 300;
const TV_CHART_FETCH_LIMIT = 600;
const TV_CHART_HEIGHT = Math.min(Dimensions.get("window").height * 0.4, 320);

const INDICATOR_PRESETS: {
  key: string;
  label: string;
  ind: IndicatorOption;
}[] = [
  { key: "ma9", label: "MA 9", ind: { type: "MA", period: 9 } },
  { key: "ma20", label: "MA 20", ind: { type: "MA", period: 20 } },
  { key: "ema9", label: "EMA 9", ind: { type: "EMA", period: 9 } },
  { key: "ema20", label: "EMA 20", ind: { type: "EMA", period: 20 } },
];

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

let lastNetworkIdForPoolDetail: string | null = null;

export default function PairDetailScreen() {
  const { poolName, from } =
    useLocalSearchParams<{ poolName: string; from?: string }>();
  const decodedPoolName = poolName ? decodeURIComponent(poolName) : null;
  const cameFromPools = from === "pools";
  const { currentNetwork, currentNetworkId } = useNetwork();
  const showPlaceOrderBlock = currentNetwork.capabilities.showMarginTab;

  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const insets = useSafeAreaInsets();
  const { user } = usePrivy();
  const suiAddress = getSuiAddressFromUser(user);
  const { wallets: embeddedEthWallets } = useEmbeddedEthereumWallet();
  const embeddedEthWallet = embeddedEthWallets?.[0] ?? null;

  // When Place order is hidden (Base), show Base + Sui balances instead.
  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [baseBalances, setBaseBalances] = useState<BaseBalanceItem[]>([]);
  const [baseBalanceLoading, setBaseBalanceLoading] = useState(false);
  const [suiBalancesForBlock, setSuiBalancesForBlock] = useState<
    Array<{ symbol: string; formatted: string }>
  >([]);
  const [suiBalanceLoadingForBlock, setSuiBalanceLoadingForBlock] =
    useState(false);

  // Base trading block: long/short, token from Base wallet, amount, send (bridge later).
  const [baseTradeSide, setBaseTradeSide] = useState<"long" | "short">("long");
  const [selectedBaseToken, setSelectedBaseToken] =
    useState<BaseBalanceItem | null>(null);
  const [baseTradeAmount, setBaseTradeAmount] = useState("");
  const [baseTradeTokenPickerOpen, setBaseTradeTokenPickerOpen] =
    useState(false);

  // Bridge (Base → Sui USDC) for Trade block: track tx and LI.FI status until DONE
  const [bridgeTxHash, setBridgeTxHash] = useState<string | null>(null);
  const [bridgeLifiStatus, setBridgeLifiStatus] =
    useState<LifiStatusResponse | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [depositAndOpenLoading, setDepositAndOpenLoading] = useState(false);

  /** Sui→Base bridge: same inline experience as Base→Sui (quote → send → status, no modal). */
  const [withdrawBridgePending, setWithdrawBridgePending] = useState<{
    amountRaw: string;
    fromAddress: string;
    toAddress: string | null;
  } | null>(null);
  const [withdrawBridgeTxHash, setWithdrawBridgeTxHash] = useState<string | null>(null);
  const [withdrawBridgeStatus, setWithdrawBridgeStatus] = useState<LifiStatusResponse | null>(null);
  const [withdrawBridgeLoading, setWithdrawBridgeLoading] = useState(false);
  const [withdrawBridgeError, setWithdrawBridgeError] = useState<string | null>(null);
  /** Which flow started the current bridge: only that flow's tracker is shown. */
  const [withdrawBridgeStartedBy, setWithdrawBridgeStartedBy] = useState<'withdraw-button' | 'close-and-send' | null>(null);
  const onBridgeToBaseRef = useRef<(payload?: { amountRaw: string; fromAddress: string; toAddress: string | null }) => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    if (!embeddedEthWallet) {
      setEvmAddress(null);
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      try {
        const provider = await (embeddedEthWallet as { getProvider?: () => Promise<{ request: (args: { method: string }) => Promise<string[]> }> }).getProvider?.();
        const accounts = provider
          ? (await provider.request({ method: "eth_requestAccounts" })) as string[]
          : [];
        if (!cancelled) setEvmAddress(accounts?.[0] ?? null);
      } catch {
        if (!cancelled) setEvmAddress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embeddedEthWallet]);

  useEffect(() => {
    if (showPlaceOrderBlock || !evmAddress) {
      setBaseBalances([]);
      setBaseBalanceLoading(false);
      return;
    }
    let cancelled = false;
    setBaseBalanceLoading(true);
    fetchAllBaseBalances(evmAddress, "base-mainnet")
      .then((list) => {
        if (!cancelled) setBaseBalances(list);
      })
      .catch(() => {
        if (!cancelled) setBaseBalances([]);
      })
      .finally(() => {
        if (!cancelled) setBaseBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showPlaceOrderBlock, evmAddress]);

  const refetchSuiBalancesForBlock = useCallback(() => {
    if (showPlaceOrderBlock || !suiAddress) return;
    setSuiBalanceLoadingForBlock(true);
    fetchAllSuiBalances(suiAddress)
      .then((list) =>
        setSuiBalancesForBlock(
          list.map((b) => ({ symbol: b.symbol, formatted: b.formatted }))
        )
      )
      .catch(() => setSuiBalancesForBlock([]))
      .finally(() => setSuiBalanceLoadingForBlock(false));
  }, [showPlaceOrderBlock, suiAddress]);

  useEffect(() => {
    if (showPlaceOrderBlock || !suiAddress) {
      setSuiBalancesForBlock([]);
      setSuiBalanceLoadingForBlock(false);
      return;
    }
    refetchSuiBalancesForBlock();
  }, [showPlaceOrderBlock, suiAddress, refetchSuiBalancesForBlock]);

  // Poll LI.FI status for Trade-block bridge (Base→Sui) until DONE/FAILED or timeout
  useEffect(() => {
    if (!bridgeTxHash) return;

    let notFoundCount = 0;
    const maxNotFound = 10;
    const pollMs = 6000;
    const maxPolls = 100; // ~10 min; bridges can take a while
    let pollCount = 0;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const poll = async (): Promise<boolean> => {
      try {
        const status = await fetchLifiStatus(
          bridgeTxHash!,
          BASE_MAINNET_CHAIN_ID
        );
        setBridgeLifiStatus(status);
        if (status.status === "NOT_FOUND") {
          notFoundCount += 1;
          if (notFoundCount >= maxNotFound) return true;
        } else {
          notFoundCount = 0;
          if (status.status === "DONE" || status.status === "FAILED")
            return true;
        }
      } catch {
        // keep polling on network error
      }
      return false;
    };

    const schedulePoll = () => {
      intervalId = setInterval(async () => {
        pollCount += 1;
        if (pollCount > maxPolls && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
          return;
        }
        const done = await poll();
        if (done && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }, pollMs);
    };

    // Run first poll immediately so we show DONE quickly if bridge already completed
    poll().then((done) => {
      if (!done) schedulePoll();
    });

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [bridgeTxHash]);

  // Poll LI.FI status for Sui→Base bridge (withdraw/close-and-send) until DONE/FAILED
  useEffect(() => {
    if (!withdrawBridgeTxHash) return;
    const pollMs = 6000;
    const maxPolls = 100; // ~10 min; bridges can take a while
    let pollCount = 0;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const doPoll = async (): Promise<boolean> => {
      try {
        const status = await fetchLifiStatus(withdrawBridgeTxHash!, SUI_CHAIN_ID);
        setWithdrawBridgeStatus(status);
        return status.status === "DONE" || status.status === "FAILED";
      } catch {
        return false;
      }
    };

    const schedulePoll = () => {
      intervalId = setInterval(async () => {
        pollCount += 1;
        if (pollCount > maxPolls && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
          return;
        }
        const done = await doPoll();
        if (done && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }, pollMs);
    };

    // Run first poll immediately so we show DONE quickly if bridge already completed
    doPoll().then((done) => {
      if (!done) schedulePoll();
    });

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [withdrawBridgeTxHash]);

  // When app comes to foreground, refresh bridge status once (bridge may have completed while away)
  const bridgeTxHashRef = useRef(bridgeTxHash);
  bridgeTxHashRef.current = bridgeTxHash;
  const bridgeLifiStatusRef = useRef(bridgeLifiStatus);
  bridgeLifiStatusRef.current = bridgeLifiStatus;
  const withdrawBridgeTxHashRef = useRef(withdrawBridgeTxHash);
  withdrawBridgeTxHashRef.current = withdrawBridgeTxHash;
  const withdrawBridgeStatusRef = useRef(withdrawBridgeStatus);
  withdrawBridgeStatusRef.current = withdrawBridgeStatus;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState !== "active") return;
      // Base→Sui (Trade block)
      const baseSuiHash = bridgeTxHashRef.current;
      const baseSuiStatus = bridgeLifiStatusRef.current;
      if (baseSuiHash && (!baseSuiStatus || (baseSuiStatus.status !== "DONE" && baseSuiStatus.status !== "FAILED"))) {
        fetchLifiStatus(baseSuiHash, BASE_MAINNET_CHAIN_ID)
          .then((s) => setBridgeLifiStatus(s))
          .catch(() => {});
      }
      // Sui→Base (withdraw)
      const suiBaseHash = withdrawBridgeTxHashRef.current;
      const suiBaseStatus = withdrawBridgeStatusRef.current;
      if (suiBaseHash && (!suiBaseStatus || suiBaseStatus.status === "PENDING")) {
        fetchLifiStatus(suiBaseHash, SUI_CHAIN_ID)
          .then((s) => setWithdrawBridgeStatus(s))
          .catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  const handleSendBridge = useCallback(async () => {
    if (!evmAddress?.trim()) {
      setBridgeError("No Base wallet address");
      return;
    }
    if (!embeddedEthWallet) {
      setBridgeError("No Privy EVM wallet available for sending.");
      return;
    }
    if (!suiAddress?.trim()) {
      setBridgeError("Link a Sui wallet in Home to receive on Sui.");
      return;
    }
    if (!selectedBaseToken) {
      setBridgeError("Select a token");
      return;
    }
    const amountNum = parseFloat(baseTradeAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setBridgeError("Enter a valid amount");
      return;
    }
    const decimals = selectedBaseToken.decimals;
    const amountRaw = BigInt(
      Math.round(amountNum * Math.pow(10, decimals))
    );
    if (amountRaw > BigInt(selectedBaseToken.rawBalance)) {
      setBridgeError("Amount exceeds your balance");
      return;
    }
    const chainIdHex = currentNetwork.evmChainId;
    if (!chainIdHex) {
      setBridgeError("Current network is not configured for cross-chain send.");
      return;
    }

    setBridgeError(null);
    setBridgeTxHash(null);
    setBridgeLifiStatus(null);
    setBridgeLoading(true);

    try {
      const provider = await (embeddedEthWallet as { getProvider?: () => Promise<{ request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }> }).getProvider?.();
      if (!provider) {
        setBridgeError("Could not get wallet provider");
        setBridgeLoading(false);
        return;
      }
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts?.[0];
      if (!from) {
        setBridgeError("No account found in embedded wallet");
        setBridgeLoading(false);
        return;
      }
      try {
        const currentChainId = (await provider.request({ method: "eth_chainId" })) as string;
        if (currentChainId !== chainIdHex) {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: chainIdHex }],
          });
        }
      } catch {
        setBridgeError(`Switch to ${currentNetwork.shortLabel} in your wallet and try again.`);
        setBridgeLoading(false);
        return;
      }

      const fromTokenAddress =
        selectedBaseToken.tokenAddress === null
          ? "0x0000000000000000000000000000000000000000"
          : selectedBaseToken.tokenAddress;

      const quoteResult = (await fetchLifiQuote({
        fromChainId: BASE_MAINNET_CHAIN_ID,
        toChainId: SUI_CHAIN_ID,
        fromTokenAddress,
        toTokenAddress: BRIDGE_TO_MARGIN_RECEIVE_TOKEN_SUI,
        fromAmount: amountRaw.toString(),
        fromAddress: evmAddress,
        toAddress: suiAddress,
        slippage: 0.005,
      })) as {
        transactionRequest?: {
          to?: string;
          data?: string;
          value?: string;
          gasLimit?: string;
          gasPrice?: string;
          maxFeePerGas?: string;
          maxPriorityFeePerGas?: string;
          chainId?: number;
        };
        estimate?: { approvalAddress?: string };
      };

      const txRequest = quoteResult?.transactionRequest;
      if (!txRequest?.to || !txRequest?.data) {
        setBridgeError("No route returned. Try a different amount or token.");
        setBridgeLoading(false);
        return;
      }

      // Fetch current nonce from chain so we don't use a stale one (avoids "nonce too low" after a previous tx completed).
      const nonceHex = (await provider.request({
        method: "eth_getTransactionCount",
        params: [from, "latest"],
      })) as string;
      let nextNonce = parseInt(nonceHex, 16);

      // ERC20 allowance: if the route spends an ERC20 (e.g. USDC), LI.FI returns approvalAddress.
      // We must approve that contract to spend our tokens before the bridge tx (which uses transferFrom).
      const isErc20 = fromTokenAddress !== "0x0000000000000000000000000000000000000000";
      const approvalAddress = quoteResult?.estimate?.approvalAddress;
      if (isErc20 && approvalAddress) {
        const pad64 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
        const approveData =
          "0x095ea7b3" +
          pad64(approvalAddress) +
          pad64(amountRaw.toString(16));
        const approveTxHash = (await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from,
              to: fromTokenAddress,
              data: approveData,
              value: "0x0",
              gasLimit: "0xfde8", // 65000
              nonce: "0x" + nextNonce.toString(16),
            },
          ],
        })) as string;
        nextNonce += 1;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const receipt = (await provider.request({
            method: "eth_getTransactionReceipt",
            params: [approveTxHash],
          })) as { blockNumber?: string } | null;
          if (receipt?.blockNumber) break;
        }
        // Refresh nonce after approval so bridge tx uses the correct one (in case of reorg or delay).
        const nonceAfterApprove = (await provider.request({
          method: "eth_getTransactionCount",
          params: [from, "latest"],
        })) as string;
        nextNonce = parseInt(nonceAfterApprove, 16);
      }

      const tx: Record<string, string> = {
        from,
        to: txRequest.to,
        data: txRequest.data,
        value: txRequest.value ?? "0x0",
        nonce: "0x" + nextNonce.toString(16),
      };
      if (txRequest.gasLimit) tx.gasLimit = txRequest.gasLimit;
      if (txRequest.gasPrice) tx.gasPrice = txRequest.gasPrice;
      if (txRequest.maxFeePerGas) tx.maxFeePerGas = txRequest.maxFeePerGas;
      if (txRequest.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = txRequest.maxPriorityFeePerGas;
      if (txRequest.chainId != null) tx.chainId = "0x" + Number(txRequest.chainId).toString(16);

      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [tx],
      });
      const hashStr = String(txHash);
      setBridgeTxHash(hashStr);
      setBaseTradeAmount("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Bridge send failed";
      setBridgeError(msg);
    } finally {
      setBridgeLoading(false);
    }
  }, [
    evmAddress,
    embeddedEthWallet,
    suiAddress,
    selectedBaseToken,
    baseTradeAmount,
    currentNetwork.evmChainId,
    currentNetwork.shortLabel,
  ]);

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
  const [chartViewMode, setChartViewMode] = useState<"line" | "tradingview">(
    "line"
  );
  const [chartTypeTv, setChartTypeTv] = useState<ChartTypeOption>("candle");
  const [showVolumeTv, setShowVolumeTv] = useState(true);
  const [indicatorsTv, setIndicatorsTv] = useState<IndicatorOption[]>([]);
  const [priceLinesTv, setPriceLinesTv] = useState<PriceLineOption[]>([]);
  const [indicatorsModalVisible, setIndicatorsModalVisible] = useState(false);
  const [drawModalVisible, setDrawModalVisible] = useState(false);
  const [newLinePrice, setNewLinePrice] = useState("");

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

  const {
    candles: candlesTv,
    allCandles: allCandlesTv,
    loading: ohlcvLoadingTv,
    error: ohlcvErrorTv,
    loadOlder: loadOlderTv,
  } = useOhlcv(decodedPoolName, {
    interval: chartInterval,
    displayLimit: TV_CHART_DISPLAY_LIMIT,
    fetchLimit: TV_CHART_FETCH_LIMIT,
    refreshIntervalMs: 10_000,
  });

  useEffect(() => {
    if (__DEV__ && decodedPoolName) {
      debugFetchOhlcv(decodedPoolName, { interval: "1m", limit: 10 }).catch(
        (e) => console.warn("[OHLCV debug] dummy call failed", e)
      );
    }
  }, [decodedPoolName]);

  const toggleIndicatorTv = useCallback(
    (preset: (typeof INDICATOR_PRESETS)[0]) => {
      setIndicatorsTv((prev) => {
        const has = prev.some(
          (i) => i.type === preset.ind.type && i.period === preset.ind.period
        );
        if (has)
          return prev.filter(
            (i) =>
              !(i.type === preset.ind.type && i.period === preset.ind.period)
          );
        return [...prev, preset.ind];
      });
    },
    []
  );
  const hasIndicatorTv = useCallback(
    (preset: (typeof INDICATOR_PRESETS)[0]) =>
      indicatorsTv.some(
        (i) => i.type === preset.ind.type && i.period === preset.ind.period
      ),
    [indicatorsTv]
  );
  const addPriceLineTv = useCallback(() => {
    const p = parseFloat(newLinePrice.trim());
    if (Number.isFinite(p)) {
      setPriceLinesTv((prev) => [
        ...prev,
        { id: `line-${Date.now()}`, price: p, color: "#94a3b8" },
      ]);
      setNewLinePrice("");
    }
  }, [newLinePrice]);
  const removePriceLineTv = useCallback((id: string) => {
    setPriceLinesTv((prev) => prev.filter((l) => l.id !== id));
  }, []);

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

  // When on Base (Trade block): clear bridge state on focus so user can start a new bridge after leaving and returning.
  useFocusEffect(
    useCallback(() => {
      if (!showPlaceOrderBlock) {
        setBridgeTxHash(null);
        setBridgeLifiStatus(null);
        setBridgeError(null);
      }
    }, [showPlaceOrderBlock])
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
  const [closeAndWithdrawLoading, setCloseAndWithdrawLoading] = useState(false);
  const [closeAndSendToBaseLoading, setCloseAndSendToBaseLoading] = useState(false);
  const [withdrawToBaseLoading, setWithdrawToBaseLoading] = useState(false);
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

  /** Show Position block only when at least one of base/quote borrowed (human) is >= 0.09. Indexer state uses human debt. */
  const BORROWED_THRESHOLD_POSITION_BLOCK = 0.09;
  const showPositionBlock = useMemo(() => {
    if (!livePnl.hasPosition || !livePnl.hasDebt || livePnl.positionSide === "none")
      return false;
    const baseBorrowedHuman = state ? Number(state.base_debt) : 0;
    const quoteBorrowedHuman = state ? Number(state.quote_debt) : 0;
    return (
      baseBorrowedHuman >= BORROWED_THRESHOLD_POSITION_BLOCK ||
      quoteBorrowedHuman >= BORROWED_THRESHOLD_POSITION_BLOCK
    );
  }, [
    livePnl.hasPosition,
    livePnl.hasDebt,
    livePnl.positionSide,
    state?.base_debt,
    state?.quote_debt,
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

  const handleDepositAndOpenPosition = useCallback(async () => {
    const status = bridgeLifiStatus;
    if (status?.status !== "DONE" || !status.receiving?.amount) {
      Alert.alert("Deposit & open position", "Bridge not complete or amount unknown.");
      return;
    }
    const rawAmount = status.receiving.amount;
    const decimals = status.receiving.token?.decimals ?? 6;
    const depositAmountHuman = Number(rawAmount) / Math.pow(10, decimals);
    if (
      !Number.isFinite(depositAmountHuman) ||
      depositAmountHuman < MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT
    ) {
      Alert.alert(
        "Deposit & open position",
        `Received amount is below minimum deposit (${MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT}).`
      );
      return;
    }
    if (typeof livePrice !== "number" || livePrice <= 0) {
      Alert.alert("Deposit & open position", "Price not available. Try again in a moment.");
      return;
    }
    if (!suiAddress || !decodedPoolName || !poolInfoForPair) {
      Alert.alert("Deposit & open position", "Missing wallet or pool.");
      return;
    }
    if (!signRawHash || !suiWallet?.publicKey) {
      Alert.alert(
        "Deposit & open position",
        "Signing not available. Link your Sui wallet on Home."
      );
      return;
    }

    let effectiveManagerId = managerForThisPool?.margin_manager_id ?? null;
    setDepositAndOpenLoading(true);
    try {
      const publicKeyHex = publicKeyToHex(suiWallet.publicKey);
      if (!effectiveManagerId) {
        const result = await createMarginManagerViaBackend({
          apiUrl,
          sender: suiAddress,
          poolKey: decodedPoolName,
          signRawHash,
          publicKeyHex,
          network: "mainnet",
        });
        effectiveManagerId = result.margin_manager_id;
        setJustCreatedManager({
          margin_manager_id: result.margin_manager_id,
          deepbook_pool_id: poolInfoForPair.deepbook_pool_id,
        });
        await refreshOwned();
        // Allow the new margin manager object to propagate before deposit tx references it
        await new Promise((r) => setTimeout(r, 2500));
      }
      const doDeposit = () =>
        depositMarginViaBackend({
          apiUrl,
          sender: suiAddress,
          marginManagerId: effectiveManagerId!,
          poolKey: decodedPoolName,
          asset: "quote",
          amount: depositAmountHuman,
          signRawHash,
          publicKeyHex,
          network: "mainnet",
        });
      try {
        await doDeposit();
      } catch (depositErr) {
        const msg =
          depositErr instanceof Error ? depositErr.message : String(depositErr);
        if (msg.includes("does not exist")) {
          await new Promise((r) => setTimeout(r, 2000));
          await doDeposit();
        } else {
          throw depositErr;
        }
      }
      // --- Post-deposit: open position at 2× (same logic as main Sui Place order) ---
      // Step 1: Wait for deposit to be visible on chain (so borrow + order tx sees updated balance).
      await new Promise((r) => setTimeout(r, 3500));

      // Step 2: Read collateral from chain via SDK (balanceManager / calculateAssets). No indexer (avoids delay).
      const chainState = await fetchMarginBorrowedSharesViaBackend({
        apiUrl,
        marginManagerId: effectiveManagerId!,
        poolKey: decodedPoolName,
        network: "mainnet",
      });
      const assets = chainState.calculateAssets;
      if (!assets || (Number(assets.quote_asset) <= 0 && Number(assets.base_asset) <= 0)) {
        throw new Error("Could not read margin balance from chain. Try again in a moment.");
      }

      // Step 3: Convert raw chain amounts to human (chain returns u64 in token smallest units).
      const quoteDecimals = poolInfoForPair?.quote_asset_id
        ? getDecimalsForCoinType(poolInfoForPair.quote_asset_id)
        : 6;
      const baseDecimals = poolInfoForPair?.base_asset_id
        ? getDecimalsForCoinType(poolInfoForPair.base_asset_id)
        : 9;
      const collateralQuoteRaw = Number(assets.quote_asset);
      const collateralBaseRaw = Number(assets.base_asset);
      const collateralQuote = collateralQuoteRaw / Math.pow(10, quoteDecimals);
      const collateralBaseHuman = collateralBaseRaw / Math.pow(10, baseDecimals);

      // Step 4: Borrow same amount as the asset we have. If both > 0, use the one with higher value (quote value vs base value in USD).
      const quoteValue = collateralQuote;
      const baseValue = collateralBaseHuman * livePrice;
      const useQuote =
        collateralQuote > 0 &&
        (collateralBaseHuman <= 0 || quoteValue >= baseValue);

      let borrowQuoteAmount: number | undefined;
      let borrowBaseAmount: number | undefined;
      let orderQty: number;
      const isBid = useQuote;

      if (useQuote) {
        borrowQuoteAmount = Math.round(collateralQuote * 1e6) / 1e6;
        borrowBaseAmount = undefined;
        orderQty = (2 * collateralQuote) / livePrice;
      } else {
        borrowQuoteAmount = undefined;
        borrowBaseAmount = Math.round(collateralBaseHuman * 1e6) / 1e6;
        orderQty = 2 * collateralBaseHuman;
      }

      let orderQtyRounded = Math.floor(orderQty * 10) / 10;
      if (orderQtyRounded < MIN_ORDER_QUANTITY) {
        throw new Error(`Position size at 2× would be below minimum (${MIN_ORDER_QUANTITY}). Need more collateral.`);
      }

      const expectedQuoteAfterBorrow = collateralQuote + (borrowQuoteAmount ?? 0);
      const expectedBaseAfterBorrow = collateralBaseHuman + (borrowBaseAmount ?? 0);

      // Cap order size so we don't use 100% of expected balance (avoids withdraw_with_proof abort from rounding).
      const RESERVE_FRACTION = 0.995; // use at most 99.5% of expected after borrow
      if (isBid) {
        const maxNotionalQuote = expectedQuoteAfterBorrow * RESERVE_FRACTION;
        const maxQtyFromQuote = maxNotionalQuote / livePrice;
        if (orderQtyRounded > maxQtyFromQuote) {
          orderQtyRounded = Math.floor(maxQtyFromQuote * 10) / 10;
        }
      } else {
        const maxBase = expectedBaseAfterBorrow * RESERVE_FRACTION;
        if (orderQtyRounded > maxBase) {
          orderQtyRounded = Math.floor(maxBase * 10) / 10;
        }
      }
      if (orderQtyRounded < MIN_ORDER_QUANTITY) {
        throw new Error(`Position size after reserve would be below minimum (${MIN_ORDER_QUANTITY}). Need more collateral.`);
      }

      const orderNotionalQuote = orderQtyRounded * livePrice;
      console.log("[Deposit & open position] After borrow (expected):", {
        quote: expectedQuoteAfterBorrow,
        base: expectedBaseAfterBorrow,
      });
      console.log("[Deposit & open position] placeMarketOrder using:", {
        quantity: orderQtyRounded,
        isBid,
        notionalQuote: orderNotionalQuote,
      });

      await placeOrderViaBackend({
        apiUrl,
        sender: suiAddress,
        marginManagerId: effectiveManagerId!,
        poolKey: decodedPoolName,
        orderType: "market",
        isBid,
        quantity: orderQtyRounded,
        payWithDeep: false,
        borrowBaseAmount,
        borrowQuoteAmount,
        signRawHash,
        publicKeyHex,
        network: "mainnet",
      });
      refreshMarginState?.();
      refreshMarginHistory?.();
      refreshOpenOrders?.();
      refreshOrderHistory?.();
      refreshTradeHistory?.();
      setBridgeTxHash(null);
      setBridgeLifiStatus(null);
      Alert.alert("Deposit & open position", "Position opened at 2× leverage.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      Alert.alert("Deposit & open position", msg);
    } finally {
      setDepositAndOpenLoading(false);
    }
  }, [
    bridgeLifiStatus,
    livePrice,
    baseTradeSide,
    managerForThisPool,
    suiAddress,
    decodedPoolName,
    poolInfoForPair,
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

  const onClosePosition = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!livePnl.hasPosition || livePnl.positionSide === "none") return;

    const MAX_CLOSE_ITERATIONS = 10;
    // Wait for previous tx to commit so next tx uses fresh object versions (avoids "not available for consumption").
    const CLOSE_WAIT_MS = 12_000;
    let currentState: typeof state = state;
    let iterations = 0;
    let didPlaceAnyOrder = false;
    let didRepayAny = false;
    let dustDeadlock = false;
    let lastDustDebtQuote = 0;

    while (iterations < MAX_CLOSE_ITERATIONS) {
      let baseDebt = currentState ? Number(currentState.base_debt) : 0;
      let quoteDebt = currentState ? Number(currentState.quote_debt) : 0;
      if (iterations === 0 && marginManagerId && decodedPoolName && (baseDebt > 0 || quoteDebt > 0)) {
        try {
          const chain = await fetchMarginBorrowedSharesViaBackend({
            apiUrl,
            marginManagerId,
            poolKey: decodedPoolName,
            network: "mainnet",
          });
          const quoteDecimals = poolInfoForPair?.quote_asset_id
            ? getDecimalsForCoinType(poolInfoForPair.quote_asset_id)
            : 6;
          const baseDecimals = poolInfoForPair?.base_asset_id
            ? getDecimalsForCoinType(poolInfoForPair.base_asset_id)
            : 9;
          if (chain.calculateDebts?.quote_debt)
            quoteDebt = Number(chain.calculateDebts.quote_debt) / Math.pow(10, quoteDecimals);
          if (chain.calculateDebts?.base_debt)
            baseDebt = Number(chain.calculateDebts.base_debt) / Math.pow(10, baseDecimals);
        } catch (_) {
          /* keep indexer values */
        }
      }
      const hasDebt = baseDebt > 0 || quoteDebt > 0;
      const mark =
        Number(
          decodedPoolName && ticker[decodedPoolName]?.last_price
            ? ticker[decodedPoolName].last_price
            : 0
        ) || livePnl.currentPrice;
      const quoteAsset = currentState ? Number(currentState.quote_asset) : 0;
      const baseAsset = currentState ? Number(currentState.base_asset) : 0;
      const netBaseSigned =
        currentState != null
          ? Number(currentState.base_asset) - Number(currentState.base_debt)
          : 0;
      const onChainPositionSize = Math.abs(netBaseSigned);
      // Derive side from on-chain state only. Do not use livePnl.positionSide:
      // after a close-sell the latest trade is "sell" so UI would show "short",
      // but we may still have net long (base_asset > base_debt).
      const currentPositionSide: "long" | "short" =
        netBaseSigned > 0 ? "long" : netBaseSigned < 0 ? "short" : "long";

      if (onChainPositionSize < MIN_ORDER_QUANTITY) break;

      console.log("[ClosePosition] inputs from state & livePnl", {
        iteration: iterations + 1,
        base_asset: baseAsset,
        quote_asset: quoteAsset,
        base_debt: baseDebt,
        quote_debt: quoteDebt,
        netBasePosition: netBaseSigned,
        positionSide: currentPositionSide,
        mark,
        hasDebt,
      });

      // Close quantity = size + unrealized, but contract (ENotReduceOnlyOrder = 3) requires:
      // - Long (ask): quote_quantity from get_quote_quantity_out(quantity) <= quote_debt - quote_asset.
      //   When net quote debt is 0 (position left after repay), we can still close the full base.
      // - Short (bid): quantity <= base_debt - base_asset. When net base debt is 0, close with available quote.
      const unrealizedPnlQuote = livePnl.unrealizedPnlQuote ?? 0;
      const unrealizedInBase = mark > 0 ? unrealizedPnlQuote / mark : 0;
      const sizePlusUnrealized = onChainPositionSize + unrealizedInBase;
      const FEE_BUFFER = 0.99; // stay under contract limit after fees

      let closeQuantity: number;
      if (currentPositionSide === "long") {
        const netQuoteDebt = Math.max(0, quoteDebt - quoteAsset);
        const maxBaseByNetQuoteDebt =
          netQuoteDebt > 0 && mark > 0
            ? (netQuoteDebt * FEE_BUFFER) / mark
            : baseAsset; // no debt => close full base
        closeQuantity = Math.min(
          baseAsset,
          sizePlusUnrealized,
          maxBaseByNetQuoteDebt
        );
        console.log("[ClosePosition] long branch (capped by net quote debt)", {
          onChainPositionSize,
          sizePlusUnrealized,
          baseAsset,
          quoteDebt,
          quoteAsset,
          netQuoteDebt,
          maxBaseByNetQuoteDebt,
          closeQuantityRaw: closeQuantity,
        });
      } else {
        const netBaseDebt = Math.max(0, baseDebt - baseAsset);
        const maxBaseByNetDebt =
          netBaseDebt > 0 ? netBaseDebt * FEE_BUFFER : Infinity; // no debt => close with quote
        if (quoteAsset > 0 && mark > 0) {
          const maxBaseFromQuote = (quoteAsset / mark) * FEE_BUFFER;
          closeQuantity = Math.min(
            maxBaseFromQuote,
            sizePlusUnrealized,
            maxBaseByNetDebt
          );
        } else {
          closeQuantity = Math.min(sizePlusUnrealized, maxBaseByNetDebt);
        }
        console.log("[ClosePosition] short branch (capped by net base debt)", {
          onChainPositionSize,
          sizePlusUnrealized,
          baseDebt,
          baseAsset,
          netBaseDebt,
          maxBaseByNetDebt,
          closeQuantityRaw: closeQuantity,
        });
      }
      // Slight reserve so we stay under on-chain limit (rounding/fees).
      const CLOSE_RESERVE_FRACTION = 0.99;
      closeQuantity = closeQuantity * CLOSE_RESERVE_FRACTION;
      const baseDecimals = poolInfoForPair?.base_asset_id
        ? getDecimalsForCoinType(poolInfoForPair.base_asset_id)
        : 9;
      const scalar = Math.pow(10, baseDecimals);
      let rawFloor = Math.floor(closeQuantity * scalar);
      const safeRaw = Math.max(0, rawFloor - 1);
      closeQuantity = safeRaw / scalar;
      const lotSizeRaw = Math.pow(10, baseDecimals);
      const rawRoundedToLot = Math.floor(safeRaw / lotSizeRaw) * lotSizeRaw;
      closeQuantity = rawRoundedToLot / scalar;
      // Only place order if we have at least MIN and a valid lot multiple (pool rejects e.g. 0.1 if min is 1 WAL).
      const canPlaceCloseOrder = closeQuantity >= MIN_ORDER_QUANTITY;
      console.log("[ClosePosition] after reserve + 1-raw + lot round & min check", {
        CLOSE_RESERVE_FRACTION,
        closeQuantity,
        rawRoundedToLot,
        lotSizeRaw,
        canPlaceCloseOrder,
        MIN_ORDER_QUANTITY,
      });

      if (!marginManagerId || !decodedPoolName || !suiAddress) {
        Alert.alert("Close position", "Select a margin account first.");
        break;
      }
      if (!signRawHash || !suiWallet?.publicKey) {
        Alert.alert("Close position", "Wallet signing not available.");
        break;
      }

      if (iterations === 0 && !silent) setClosePositionLoading(true);
      try {
        const publicKeyHex = publicKeyToHex(suiWallet!.publicKey);
        if (canPlaceCloseOrder) {
          console.log("[ClosePosition] placing close order", {
            poolKey: decodedPoolName,
            isBid: currentPositionSide === "short",
            quantity: closeQuantity,
            positionSide: currentPositionSide,
          });
          await placeOrderViaBackend({
            apiUrl,
            sender: suiAddress,
            marginManagerId,
            poolKey: decodedPoolName,
            orderType: "market",
            isBid: currentPositionSide === "short",
            quantity: closeQuantity,
            payWithDeep: false,
            reduceOnly: true,
            signRawHash,
            publicKeyHex,
            network: "mainnet",
          });
          console.log("[ClosePosition] close order placed successfully");
          didPlaceAnyOrder = true;
          // Let the close tx commit before building repay (avoids stale object version).
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (hasDebt) {
          const stateForRepay = (await refreshMarginState?.()) ?? currentState;
          if (stateForRepay) {
            const quoteAvail = Number(stateForRepay.quote_asset);
            const baseAvail = Number(stateForRepay.base_asset);
            // Repay only what we have; requesting more than balance causes withdraw_with_proof abort.
            const baseRepay =
              baseDebt > 0 ? Math.min(baseDebt, baseAvail) : 0;
            const quoteRepay =
              quoteDebt > 0 ? Math.min(quoteDebt, quoteAvail) : 0;
            console.log("[ClosePosition] repay step", {
              stateAfterClose: {
                base_asset: baseAvail,
                quote_asset: quoteAvail,
              },
              debtToRepay: { base: baseRepay, quote: quoteRepay },
            });
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
              console.log("[ClosePosition] repay completed successfully");
              didRepayAny = true;
            } else if (
              !canPlaceCloseOrder &&
              quoteDebt > 0 &&
              quoteAvail <= 0
            ) {
              dustDeadlock = true;
              lastDustDebtQuote = quoteDebt;
              console.log("[ClosePosition] dust deadlock: cannot close (rounds to 0 lots) and cannot repay (no USDC in margin)");
              break;
            }
          }
        }

        if (!canPlaceCloseOrder && !hasDebt) break;
        iterations += 1;
        if (iterations >= MAX_CLOSE_ITERATIONS) break;
        await new Promise((r) => setTimeout(r, CLOSE_WAIT_MS));
        await refreshTradeHistory?.();
        currentState = (await refreshMarginState?.()) ?? null;
        if (!currentState) break;
        const nextNetBase =
          Number(currentState.base_asset) - Number(currentState.base_debt);
        if (Math.abs(nextNetBase) < MIN_ORDER_QUANTITY) break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Close position failed";
        const stack = err instanceof Error ? err.stack : undefined;
        console.log("[ClosePosition] error", { message: msg, stack });
        if (!silent) Alert.alert("Close position", msg);
        throw err;
      }
    }

    refreshMarginState?.();
    refreshOpenOrders?.();
    refreshOrderHistory?.();
    refreshTradeHistory?.();
    if (!silent) {
      setClosePositionLoading(false);
      if (didPlaceAnyOrder && didRepayAny) {
        Alert.alert("Close position", "Position closed and debt repaid.");
      } else if (didPlaceAnyOrder) {
        Alert.alert("Close position", "Position closed.");
      } else if (didRepayAny) {
        Alert.alert(
          "Close position",
          "Debt repaid. Position size was below minimum order, so no close order was placed; a small position may remain."
        );
      } else if (dustDeadlock) {
        const debtUsd = lastDustDebtQuote.toFixed(2);
        Alert.alert(
          "Small debt left — deposit USDC to finish",
          `A small debt (~$${debtUsd} USDC) remains and there is no USDC in your margin to repay it. The remaining position is too small to close in one order (rounds to 0).\n\nDeposit at least 0.02 USDC to your margin account (from your Sui wallet or bridge from Base), then tap Close again. After repaying, the rest of your position will close and you can withdraw USDC to Base.`
        );
      } else if (iterations > 0) {
        Alert.alert("Close position", "Position closed.");
      } else if (!didPlaceAnyOrder && !didRepayAny) {
        Alert.alert(
          "Close position",
          `Position size is below minimum order ${MIN_ORDER_QUANTITY}. Nothing to repay.`
        );
      }
    }
  }, [
    livePnl.hasPosition,
    livePnl.positionSide,
    livePnl.netBasePosition,
    livePnl.unrealizedPnlQuote,
    livePnl.currentPrice,
    marginManagerId,
    decodedPoolName,
    suiAddress,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    state,
    ticker,
    poolInfoForPair?.base_asset_id,
    refreshMarginState,
    refreshOpenOrders,
    refreshOrderHistory,
    refreshTradeHistory,
  ]);

  const onCloseAndWithdrawToSui = useCallback(async () => {
    if (
      !livePnl.hasPosition ||
      livePnl.positionSide === "none" ||
      !marginManagerId ||
      !decodedPoolName ||
      !suiAddress ||
      !signRawHash ||
      !suiWallet?.publicKey
    )
      return;
    setCloseAndWithdrawLoading(true);
    try {
      await onClosePosition({ silent: true });
      await new Promise((r) => setTimeout(r, 3500));
      const newState = await refreshMarginState?.() ?? null;
      if (newState) {
        const quoteAvail = Number(newState.quote_asset);
        if (quoteAvail >= MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT) {
          const publicKeyHex = publicKeyToHex(suiWallet!.publicKey);
          await withdrawMarginViaBackend({
            apiUrl,
            sender: suiAddress,
            marginManagerId,
            poolKey: decodedPoolName,
            asset: "quote",
            amount: quoteAvail,
            signRawHash,
            publicKeyHex,
            network: "mainnet",
          });
          refreshMarginState?.();
          refreshMarginHistory?.();
          const bridgePayload = {
            amountRaw: Math.round(quoteAvail * 1e6).toString(),
            fromAddress: suiAddress,
            toAddress: evmAddress?.trim() ?? null,
          };
          setWithdrawBridgeStartedBy('close-and-send');
          setWithdrawBridgePending(bridgePayload);
          if (bridgePayload.toAddress) {
            await onBridgeToBaseRef.current(bridgePayload);
          } else {
            Alert.alert(
              "Close & withdraw",
              "USDC withdrawn to your Sui wallet. Enter Base address above and tap \"Bridge to Base\" to send."
            );
          }
        } else {
          Alert.alert(
            "Close & withdraw",
            "Position closed. No USDC above minimum to withdraw."
          );
        }
      } else {
        Alert.alert(
          "Close & withdraw",
          "Position closed. Pull to refresh to see balance."
        );
      }
      refreshMarginState?.();
      refreshMarginHistory?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close & withdraw failed";
      Alert.alert("Close & withdraw", msg);
    } finally {
      setCloseAndWithdrawLoading(false);
    }
  }, [
    livePnl.hasPosition,
    livePnl.hasDebt,
    livePnl.positionSide,
    marginManagerId,
    decodedPoolName,
    suiAddress,
    evmAddress,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    refreshMarginState,
    refreshMarginHistory,
    onClosePosition,
  ]);

  /**
   * Full exit: sell ALL WAL for USDC (one market order), repay borrowed USDC (borrowedQuoteShares),
   * then withdraw rest and open LI.FI to Base.
   * Uses chain state: base_asset (raw) and borrowedQuoteShares (raw) for exact amounts.
   */
  const onCloseAndSendToBase = useCallback(async () => {
    if (
      !livePnl.hasPosition ||
      livePnl.positionSide === "none" ||
      !marginManagerId ||
      !decodedPoolName ||
      !suiAddress ||
      !signRawHash ||
      !suiWallet?.publicKey
    )
      return;
    setCloseAndSendToBaseLoading(true);
    try {
      const publicKeyHex = publicKeyToHex(suiWallet!.publicKey);
      const chain = await fetchMarginBorrowedSharesViaBackend({
        apiUrl,
        marginManagerId,
        poolKey: decodedPoolName,
        network: "mainnet",
      });
      const baseDecimals = poolInfoForPair?.base_asset_id
        ? getDecimalsForCoinType(poolInfoForPair.base_asset_id)
        : 9;
      const quoteDecimals = poolInfoForPair?.quote_asset_id
        ? getDecimalsForCoinType(poolInfoForPair.quote_asset_id)
        : 6;
      const baseAssetHuman =
        chain.calculateAssets?.base_asset != null
          ? Number(chain.calculateAssets.base_asset) / Math.pow(10, baseDecimals)
          : state != null
            ? Number(state.base_asset)
            : 0;
      const lotSize = 1;
      const sellQuantity = Math.floor(baseAssetHuman / lotSize) * lotSize;
      if (sellQuantity < MIN_ORDER_QUANTITY) {
        Alert.alert(
          "Close & send to Base",
          `Not enough WAL to sell (${baseAssetHuman.toFixed(4)}). Min order: ${MIN_ORDER_QUANTITY}.`
        );
        setCloseAndSendToBaseLoading(false);
        return;
      }
      await placeOrderViaBackend({
        apiUrl,
        sender: suiAddress,
        marginManagerId,
        poolKey: decodedPoolName,
        orderType: "market",
        isBid: false,
        quantity: sellQuantity,
        payWithDeep: false,
        reduceOnly: false,
        signRawHash,
        publicKeyHex,
        network: "mainnet",
      });
      await new Promise((r) => setTimeout(r, 5000));
      const quoteDebtHuman =
        chain.borrowedQuoteShares != null
          ? Number(chain.borrowedQuoteShares) / Math.pow(10, quoteDecimals)
          : state != null
            ? Number(state.quote_debt)
            : 0;
      /** Ignore dust: only repay when borrowed quote (e.g. 17722 raw ≈ 0.018 USDC) is above this. */
      const MIN_QUOTE_DEBT_TO_REPAY = 0.02;
      if (quoteDebtHuman >= MIN_QUOTE_DEBT_TO_REPAY) {
        await repayViaBackend({
          apiUrl,
          sender: suiAddress,
          marginManagerId,
          poolKey: decodedPoolName,
          quoteAmount: quoteDebtHuman,
          signRawHash,
          publicKeyHex,
          network: "mainnet",
        });
        await new Promise((r) => setTimeout(r, 3000));
      }
      // Use chain/SDK data (real-time) for post-repay balance; retry once if RPC is slow.
      let chainAfter = await fetchMarginBorrowedSharesViaBackend({
        apiUrl,
        marginManagerId,
        poolKey: decodedPoolName,
        network: "mainnet",
      });
      let quoteAvail =
        chainAfter.calculateAssets?.quote_asset != null
          ? Number(chainAfter.calculateAssets.quote_asset) / Math.pow(10, quoteDecimals)
          : 0;
      if (quoteAvail < MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT) {
        await new Promise((r) => setTimeout(r, 2000));
        chainAfter = await fetchMarginBorrowedSharesViaBackend({
          apiUrl,
          marginManagerId,
          poolKey: decodedPoolName,
          network: "mainnet",
        });
        quoteAvail =
          chainAfter.calculateAssets?.quote_asset != null
            ? Number(chainAfter.calculateAssets.quote_asset) / Math.pow(10, quoteDecimals)
            : 0;
      }
      if (quoteAvail < MIN_MARGIN_DEPOSIT_WITHDRAW_AMOUNT) {
        Alert.alert(
          "Close & send to Base",
          "Position closed. No USDC above minimum to withdraw."
        );
        refreshMarginState?.();
        refreshMarginHistory?.();
        setCloseAndSendToBaseLoading(false);
        return;
      }
      await withdrawMarginViaBackend({
        apiUrl,
        sender: suiAddress,
        marginManagerId,
        poolKey: decodedPoolName,
        asset: "quote",
        amount: quoteAvail,
        signRawHash,
        publicKeyHex,
        network: "mainnet",
      });
      refreshMarginState?.();
      refreshMarginHistory?.();
      const amountRaw = Math.round(quoteAvail * 1e6).toString();
      const bridgePayload = {
        amountRaw,
        fromAddress: suiAddress,
        toAddress: evmAddress?.trim() ?? null,
      };
      setWithdrawBridgeStartedBy('close-and-send');
      setWithdrawBridgePending(bridgePayload);
      // Append bridge: start LiFi bridge immediately so user doesn't have to tap again.
      await onBridgeToBaseRef.current(bridgePayload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close & send to Base failed";
      Alert.alert("Close & send to Base", msg);
    } finally {
      setCloseAndSendToBaseLoading(false);
    }
  }, [
    livePnl.hasPosition,
    livePnl.positionSide,
    marginManagerId,
    decodedPoolName,
    suiAddress,
    evmAddress,
    signRawHash,
    suiWallet?.publicKey,
    apiUrl,
    state,
    poolInfoForPair?.base_asset_id,
    poolInfoForPair?.quote_asset_id,
    refreshMarginState,
    refreshMarginHistory,
  ]);

  /** Send Sui wallet USDC to Base via LI.FI. Only checks Sui wallet balance (ignores margin). */
  const MIN_SUI_WALLET_USDC_TO_BRIDGE = 100_000; // 6 decimals = 0.1 USDC
  const onWithdrawToBase = useCallback(async () => {
    if (!suiAddress || !signRawHash || !suiWallet?.publicKey) return;

    setWithdrawToBaseLoading(true);
    try {
      const { totalBalance } = await fetchSuiBalance(suiAddress, BRIDGE_TO_MARGIN_RECEIVE_TOKEN_SUI);
      const suiWalletUsdcRaw = totalBalance ?? "0";
      const suiWalletUsdcNum = Number(suiWalletUsdcRaw) / 1e6;
      if (__DEV__) {
        console.log("[Withdraw to Base] Sui wallet USDC (raw):", suiWalletUsdcRaw, "human:", suiWalletUsdcNum.toFixed(2));
      }
      if (BigInt(suiWalletUsdcRaw) < BigInt(MIN_SUI_WALLET_USDC_TO_BRIDGE)) {
        Alert.alert(
          "Withdraw to Base",
          `Not enough USDC in your Sui wallet (you have ${suiWalletUsdcNum.toFixed(2)} USDC; min 0.1 to bridge).`
        );
        return;
      }
      const bridgePayload = {
        amountRaw: suiWalletUsdcRaw,
        fromAddress: suiAddress,
        toAddress: evmAddress?.trim() ?? null,
      };
      setWithdrawBridgeStartedBy('withdraw-button');
      setWithdrawBridgePending(bridgePayload);
      if (bridgePayload.toAddress) {
        await onBridgeToBaseRef.current(bridgePayload);
      } else {
        Alert.alert(
          "Withdraw to Base",
          "USDC ready to bridge. Enter your Base wallet address above and tap \"Bridge to Base\" in the Place order section."
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to read Sui wallet balance";
      if (__DEV__) console.warn("[Withdraw to Base]", msg);
      Alert.alert("Withdraw to Base", msg);
    } finally {
      setWithdrawToBaseLoading(false);
    }
  }, [suiAddress, evmAddress, signRawHash, suiWallet?.publicKey]);

  /** Same as Base→Sui handleSendBridge: get quote, send EVM tx or Sui tx if returned, set tx hash for inline status. */
  const onBridgeToBase = useCallback(async (overridePayload?: { amountRaw: string; fromAddress: string; toAddress: string | null }) => {
    const payload = overridePayload ?? withdrawBridgePending;
    if (!payload) return;
    setWithdrawBridgeError(null);
    setWithdrawBridgeTxHash(null);
    setWithdrawBridgeStatus(null);
    setWithdrawBridgeLoading(true);
    try {
      const quoteResult = (await fetchLifiQuote({
        fromChainId: SUI_CHAIN_ID,
        toChainId: BASE_MAINNET_CHAIN_ID,
        fromTokenAddress: BRIDGE_TO_MARGIN_RECEIVE_TOKEN_SUI,
        toTokenAddress: BASE_USDC_ADDRESS,
        fromAmount: payload.amountRaw,
        fromAddress: payload.fromAddress,
        toAddress: payload.toAddress ?? undefined,
        slippage: 0.005,
      })) as Record<string, unknown>;
      if (__DEV__) {
        console.log("[LiFi Sui→Base quote] top-level keys:", Object.keys(quoteResult));
        console.log("[LiFi Sui→Base quote] full response:", JSON.stringify(quoteResult, null, 2));
      }
      const txRequest = quoteResult?.transactionRequest as
        | { to?: string; data?: string; value?: string; chainId?: number }
        | undefined;
      const action = quoteResult?.action as { fromChainId?: number } | undefined;
      const fromChainId = action?.fromChainId;

      // 1) EVM tx (e.g. claim on Base) – chainId 8453
      if (txRequest?.to && txRequest?.data && txRequest?.chainId === BASE_MAINNET_CHAIN_ID && embeddedEthWallet) {
        const provider = await (embeddedEthWallet as { getProvider?: () => Promise<{ request: (p: { method: string; params: unknown[] }) => Promise<string> }> }).getProvider?.();
        if (!provider) throw new Error("No EVM wallet");
        const hash = await provider.request({
          method: "eth_sendTransaction",
          params: [{
            from: evmAddress,
            to: txRequest.to,
            data: txRequest.data,
            value: txRequest.value ?? "0x0",
          }],
        }) as string;
        setWithdrawBridgeTxHash(hash);
        setWithdrawBridgeLoading(false);
        return;
      }

      // 2) Sui tx – LiFi returns transactionRequest.data as base64-encoded Sui transaction (BCS)
      const suiTxBase64 = typeof txRequest?.data === "string" && txRequest.data.length > 0 ? txRequest.data : null;
      if (fromChainId === SUI_CHAIN_ID && suiTxBase64 && signRawHash && suiWallet?.publicKey && suiAddress) {
        const base = apiUrl.replace(/\/$/, "");
        const prepareRes = await fetch(`${base}/api/prepare-external-sui-tx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txBytesBase64: suiTxBase64 }),
        });
        if (!prepareRes.ok) {
          const errText = await prepareRes.text();
          let errJson: Record<string, unknown> = {};
          try {
            errJson = JSON.parse(errText) as Record<string, unknown>;
          } catch {
            // not JSON
          }
          const serverMsg = (errJson.error as string) ?? (errText || "Prepare Sui tx failed");
          if (__DEV__) {
            console.error("[Bridge to Base] prepare-external-sui-tx failed:", prepareRes.status, errText);
          }
          if (prepareRes.status === 404) {
            throw new Error(
              "Backend does not have /api/prepare-external-sui-tx. Restart the backend (cd backend && npm run dev) or rebuild (npm run build && npm run start)."
            );
          }
          throw new Error(serverMsg);
        }
        const prepareJson = await prepareRes.json();
        const intentMessageHashHex =
          prepareJson.intentMessageHashHex ?? prepareJson.intent_message_hash_hex;
        if (!intentMessageHashHex) throw new Error("Missing intentMessageHashHex from backend");
        const { signature: signatureHex } = await signRawHash({
          address: suiAddress,
          chainType: "sui",
          hash: intentMessageHashHex.startsWith("0x")
            ? (intentMessageHashHex as `0x${string}`)
            : (`0x${intentMessageHashHex}` as `0x${string}`),
        });
        const publicKeyHex = publicKeyToHex(suiWallet.publicKey);
        const executeRes = await fetch(`${base}/api/execute-transfer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            txBytesBase64: suiTxBase64,
            signatureHex,
            publicKeyHex: publicKeyHex.startsWith("0x") ? publicKeyHex : "0x" + publicKeyHex,
            network: "mainnet",
          }),
        });
        const executeJson = await executeRes.json();
        if (!executeRes.ok) {
          throw new Error((executeJson.error as string) ?? "Execute failed");
        }
        const digest = executeJson.digest;
        if (digest) {
          setWithdrawBridgeTxHash(digest);
          setWithdrawBridgeLoading(false);
          return;
        }
      }

      setWithdrawBridgeError("This route requires signing on Sui. Use LI.FI Explorer to complete.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bridge quote failed";
      setWithdrawBridgeError(msg);
    } finally {
      setWithdrawBridgeLoading(false);
    }
  }, [
    withdrawBridgePending,
    embeddedEthWallet,
    evmAddress,
    apiUrl,
    signRawHash,
    suiWallet?.publicKey,
    suiAddress,
  ]);
  onBridgeToBaseRef.current = onBridgeToBase;

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

  // Switch network → show list (don’t keep a pool open across networks).
  useEffect(() => {
    const prev = lastNetworkIdForPoolDetail;
    lastNetworkIdForPoolDetail = currentNetworkId;
    if (prev !== null && prev !== currentNetworkId) {
      (navigation as { navigate: (name: string) => void }).navigate("index");
    }
  }, [currentNetworkId, navigation]);

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
              onPress={() => {
                if (cameFromPools) {
                  router.replace("/(app)/pools");
                } else {
                  (navigation as { navigate: (name: string) => void }).navigate("index");
                }
              }}
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
            <View style={styles.chartSegmentRow}>
              <Pressable
                onPress={() => setChartViewMode("line")}
                style={[
                  styles.chartSegmentButton,
                  chartViewMode === "line" && {
                    backgroundColor: colors.tint,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chartSegmentButtonText,
                    {
                      color:
                        chartViewMode === "line"
                          ? colors.background
                          : colors.text,
                    },
                  ]}
                >
                  Line
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setChartViewMode("tradingview")}
                style={[
                  styles.chartSegmentButton,
                  chartViewMode === "tradingview" && {
                    backgroundColor: colors.tint,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chartSegmentButtonText,
                    {
                      color:
                        chartViewMode === "tradingview"
                          ? colors.background
                          : colors.text,
                    },
                  ]}
                >
                  Trading view
                </Text>
              </Pressable>
            </View>
          </View>

          {chartViewMode === "line" ? (
            <>
              <View
                style={[
                  styles.intervalRow,
                  { borderColor: colors.tabIconDefault },
                ]}
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                >
                  {CHART_INTERVALS.map((int) => (
                    <Pressable
                      key={int}
                      onPress={() => setChartInterval(int)}
                      style={[
                        styles.intervalButton,
                        chartInterval === int && {
                          backgroundColor: colors.tint,
                        },
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
            </>
          ) : (
            <>
              <View
                style={[
                  styles.tvToolbar,
                  { borderColor: colors.tabIconDefault },
                ]}
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.tvToolbarScroll}
                >
                  <Text
                    style={[
                      styles.tvToolbarInterval,
                      { color: colors.text },
                    ]}
                  >
                    {chartInterval.toUpperCase()}
                  </Text>
                  <View style={styles.tvToolbarDivider} />
                  <Pressable
                    onPress={() =>
                      setChartTypeTv((t) =>
                        t === "candle" ? "line" : "candle"
                      )
                    }
                    style={styles.tvToolbarButton}
                  >
                    <Text
                      style={[
                        styles.tvToolbarButtonText,
                        { color: colors.text },
                      ]}
                    >
                      {chartTypeTv === "candle" ? "Candle" : "Line"}
                    </Text>
                  </Pressable>
                  <View style={styles.tvToolbarDivider} />
                  <Pressable
                    onPress={() => setIndicatorsModalVisible(true)}
                    style={styles.tvToolbarButton}
                  >
                    <Text
                      style={[
                        styles.tvToolbarButtonText,
                        { color: colors.text },
                      ]}
                    >
                      fₓ Indicators
                    </Text>
                  </Pressable>
                  <View style={styles.tvToolbarDivider} />
                  <Pressable
                    onPress={() => setDrawModalVisible(true)}
                    style={styles.tvToolbarButton}
                  >
                    <Text
                      style={[
                        styles.tvToolbarButtonText,
                        { color: colors.text },
                      ]}
                    >
                      ✎ Draw
                    </Text>
                  </Pressable>
                </ScrollView>
              </View>
              <View
                style={[
                  styles.intervalRow,
                  { borderColor: colors.tabIconDefault },
                ]}
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                >
                  {CHART_INTERVALS.map((int) => (
                    <Pressable
                      key={int}
                      onPress={() => setChartInterval(int)}
                      style={[
                        styles.intervalButton,
                        chartInterval === int && {
                          backgroundColor: colors.tint,
                        },
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
              <View style={styles.tvChartWrap}>
                <TradingViewChart
                  candles={
                    allCandlesTv.length ? allCandlesTv : candlesTv
                  }
                  width={Math.round(Dimensions.get("window").width - 32)}
                  height={TV_CHART_HEIGHT}
                  loading={ohlcvLoadingTv}
                  error={ohlcvErrorTv}
                  chartType={chartTypeTv}
                  indicators={indicatorsTv}
                  showVolume={showVolumeTv}
                  priceLines={priceLinesTv}
                  onRequestOlderData={loadOlderTv}
                />
              </View>
            </>
          )}
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
            {showPlaceOrderBlock && (
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
            </>
            )}

            {!showPlaceOrderBlock && (
              <>
                <Text style={styles.sectionTitle}>Your balances</Text>
                <View style={styles.card}>
                  <Text style={[styles.inputLabel, { color: colors.text }]}>
                    Base (current network)
                  </Text>
                  {baseBalanceLoading ? (
                    <ActivityIndicator size="small" color={colors.tint} style={{ marginVertical: 8 }} />
                  ) : baseBalances.length === 0 ? (
                    <Text style={styles.muted}>No tokens on Base.</Text>
                  ) : (
                    <View style={{ marginTop: 8 }}>
                      {baseBalances.map((b) => (
                        <View
                          key={b.symbol}
                          style={[
                            styles.orderSideRow,
                            { justifyContent: "space-between", marginBottom: 6 },
                          ]}
                        >
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {b.symbol}
                          </Text>
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {b.formatted}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
                <View style={[styles.card, { marginTop: 12 }]}>
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 4,
                    }}
                  >
                    <Text style={[styles.inputLabel, { color: colors.text }]}>
                      Sui network account
                    </Text>
                    <Pressable
                      onPress={refetchSuiBalancesForBlock}
                      disabled={suiBalanceLoadingForBlock}
                      style={({ pressed }) => ({
                        padding: 6,
                        opacity: pressed || suiBalanceLoadingForBlock ? 0.7 : 1,
                      })}
                      accessibilityLabel="Refresh Sui balances"
                    >
                      <Text style={{ fontSize: 16, color: colors.tint }}>⟳</Text>
                    </Pressable>
                  </View>
                  {suiBalanceLoadingForBlock ? (
                    <ActivityIndicator size="small" color={colors.tint} style={{ marginVertical: 8 }} />
                  ) : suiBalancesForBlock.length === 0 ? (
                    <Text style={styles.muted}>
                      No SUI or tokens on your Sui account. Link a Sui wallet in Home to see balances.
                    </Text>
                  ) : (
                    <View style={{ marginTop: 8 }}>
                      {suiBalancesForBlock.map((b) => (
                        <View
                          key={b.symbol}
                          style={[
                            styles.orderSideRow,
                            { justifyContent: "space-between", marginBottom: 6 },
                          ]}
                        >
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {b.symbol}
                          </Text>
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {b.formatted}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                {managerForThisPool && (
                  <View style={[styles.card, { marginTop: 12 }]}>
                    <View
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                      }}
                    >
                      <Text style={[styles.inputLabel, { color: colors.text }]}>
                        Margin account state
                      </Text>
                      <Pressable
                        onPress={() => refreshMarginState?.()}
                        disabled={stateLoading}
                        style={({ pressed }) => ({
                          padding: 6,
                          opacity: pressed || stateLoading ? 0.7 : 1,
                        })}
                        accessibilityLabel="Refresh margin state"
                      >
                        <Text style={{ fontSize: 16, color: colors.tint }}>⟳</Text>
                      </Pressable>
                    </View>
                    {stateLoading && !state ? (
                      <ActivityIndicator size="small" color={colors.tint} style={{ marginVertical: 8 }} />
                    ) : stateError ? (
                      <Text style={[styles.muted, styles.errorText]}>{stateError}</Text>
                    ) : state ? (
                      <View style={{ marginTop: 8 }}>
                        <View
                          style={[
                            styles.orderSideRow,
                            { justifyContent: "space-between", marginBottom: 6 },
                          ]}
                        >
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {poolInfoForPair?.quote_asset_symbol ?? "USDC"} (in margin)
                          </Text>
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {Number(state.quote_asset).toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 6,
                            })}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.orderSideRow,
                            { justifyContent: "space-between", marginBottom: 6 },
                          ]}
                        >
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {poolInfoForPair?.base_asset_symbol ?? "Base"} (in margin)
                          </Text>
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {Number(state.base_asset).toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 6,
                            })}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.orderSideRow,
                            { justifyContent: "space-between", marginBottom: 6 },
                          ]}
                        >
                          <Text style={[styles.muted, { color: colors.text }]}>
                            Collateral (USD)
                          </Text>
                          <Text style={[styles.muted, { color: colors.text }]}>
                            $
                            {collateralUsdTotal.toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.orderSideRow,
                            { justifyContent: "space-between", marginBottom: 6 },
                          ]}
                        >
                          <Text style={[styles.muted, { color: colors.text }]}>
                            Debt (USD)
                          </Text>
                          <Text style={[styles.muted, { color: colors.text }]}>
                            ${debtUsdFromState(state)}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.orderSideRow,
                            { justifyContent: "space-between", marginBottom: 6 },
                          ]}
                        >
                          <Text style={[styles.muted, { color: colors.text }]}>
                            Risk ratio
                          </Text>
                          <Text style={[styles.muted, { color: colors.text }]}>
                            {formatRiskRatio(state.risk_ratio)}×
                          </Text>
                        </View>
                      </View>
                    ) : (
                      <Text style={styles.muted}>No state loaded.</Text>
                    )}
                  </View>
                )}

                {suiAddress && (
                  <Pressable
                    onPress={onWithdrawToBase}
                    disabled={withdrawToBaseLoading}
                    style={[
                      styles.primaryButton,
                      {
                        marginTop: 12,
                        backgroundColor: colors.background,
                        borderWidth: 1,
                        borderColor: "#fff",
                        opacity: withdrawToBaseLoading ? 0.7 : 1,
                      },
                    ]}
                  >
                    {withdrawToBaseLoading ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text
                        style={[
                          styles.primaryButtonText,
                          { color: "#fff" },
                        ]}
                      >
                        Withdraw USDC to Base
                      </Text>
                    )}
                  </Pressable>
                )}

                {/* Sui→Base bridge tracker when Withdraw USDC to Base started the flow */}
                {(withdrawBridgePending || withdrawBridgeTxHash) && withdrawBridgeStartedBy === 'withdraw-button' && (
                  <View style={{ marginTop: 16 }}>
                    {withdrawBridgeError ? (
                      <Text style={[styles.muted, styles.errorText, { marginBottom: 8 }]}>
                        {withdrawBridgeError}
                      </Text>
                    ) : null}
                    {withdrawBridgeTxHash && withdrawBridgeStatus ? (
                      <>
                        <View
                          style={[
                            {
                              alignSelf: "flex-start",
                              paddingHorizontal: 10,
                              paddingVertical: 5,
                              borderRadius: 8,
                              borderWidth: 1,
                            },
                            {
                              backgroundColor:
                                withdrawBridgeStatus.status === "DONE"
                                  ? "#22c55e22"
                                  : withdrawBridgeStatus.status === "FAILED"
                                    ? "#ef444422"
                                    : "#eab30822",
                              borderColor:
                                withdrawBridgeStatus.status === "DONE"
                                  ? "#22c55e"
                                  : withdrawBridgeStatus.status === "FAILED"
                                    ? "#ef4444"
                                    : "#eab308",
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.primaryButtonText,
                              {
                                fontSize: 12,
                                color:
                                  withdrawBridgeStatus.status === "DONE"
                                    ? "#22c55e"
                                    : withdrawBridgeStatus.status === "FAILED"
                                      ? "#ef4444"
                                      : "#eab308",
                              },
                            ]}
                          >
                            {withdrawBridgeStatus.status === "PENDING"
                              ? "Bridging"
                              : withdrawBridgeStatus.status === "DONE"
                                ? "Complete"
                                : withdrawBridgeStatus.status === "FAILED"
                                  ? "Failed"
                                  : withdrawBridgeStatus.status}
                          </Text>
                        </View>
                        {withdrawBridgeStatus.substatusMessage != null &&
                         withdrawBridgeStatus.status === "PENDING" ? (
                          <Text
                            style={[
                              styles.muted,
                              { color: colors.text, fontSize: 11, marginTop: 6 },
                            ]}
                            numberOfLines={2}
                          >
                            {withdrawBridgeStatus.substatusMessage}
                          </Text>
                        ) : null}
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
                          {withdrawBridgeStatus.sending?.txLink ? (
                            <Pressable
                              onPress={() =>
                                withdrawBridgeStatus.sending?.txLink &&
                                Linking.openURL(withdrawBridgeStatus.sending.txLink)
                              }
                              style={({ pressed }) => ({ paddingVertical: 4, opacity: pressed ? 0.8 : 1 })}
                            >
                              <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                                Source tx
                              </Text>
                            </Pressable>
                          ) : null}
                          {withdrawBridgeStatus.receiving?.txLink ? (
                            <Pressable
                              onPress={() =>
                                withdrawBridgeStatus.receiving?.txLink &&
                                Linking.openURL(withdrawBridgeStatus.receiving.txLink)
                              }
                              style={({ pressed }) => ({ paddingVertical: 4, opacity: pressed ? 0.8 : 1 })}
                            >
                              <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                                Destination tx
                              </Text>
                            </Pressable>
                          ) : null}
                          <Pressable
                            onPress={() =>
                              Linking.openURL(
                                withdrawBridgeStatus?.lifiExplorerLink ?? `https://scan.li.fi/tx/${withdrawBridgeTxHash}`
                              )
                            }
                            style={({ pressed }) => ({ paddingVertical: 4, opacity: pressed ? 0.8 : 1 })}
                          >
                            <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                              Track on LI.FI
                            </Text>
                          </Pressable>
                        </View>
                      </>
                    ) : withdrawBridgeTxHash ? (
                      <View>
                        <View
                          style={{
                            alignSelf: "flex-start",
                            paddingHorizontal: 10,
                            paddingVertical: 5,
                            borderRadius: 8,
                            borderWidth: 1,
                            backgroundColor: "#eab30822",
                            borderColor: "#eab308",
                          }}
                        >
                          <Text style={[styles.primaryButtonText, { fontSize: 12, color: "#eab308" }]}>
                            Checking…
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => Linking.openURL(`https://scan.li.fi/tx/${withdrawBridgeTxHash}`)}
                          style={({ pressed }) => ({ paddingVertical: 4, marginTop: 8, opacity: pressed ? 0.8 : 1 })}
                        >
                          <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                            Track on LI.FI
                          </Text>
                        </Pressable>
                      </View>
                    ) : null}
                    {(!withdrawBridgeTxHash || withdrawBridgeStatus?.status === "FAILED") && withdrawBridgePending ? (
                      <>
                        <Pressable
                          onPress={() => onBridgeToBase()}
                          disabled={withdrawBridgeLoading}
                          style={({ pressed }) => [
                            styles.primaryButton,
                            {
                              backgroundColor: colors.tint,
                              opacity: withdrawBridgeLoading || pressed ? 0.8 : 1,
                              marginTop: 12,
                            },
                          ]}
                        >
                          {withdrawBridgeLoading ? (
                            <ActivityIndicator size="small" color={colors.background} />
                          ) : (
                            <Text style={[styles.primaryButtonText, { color: colors.background }]}>
                              Bridge to Base
                            </Text>
                          )}
                        </Pressable>
                        {withdrawBridgeError?.includes("LI.FI Explorer") ? (
                          <Pressable
                            onPress={() => {
                              const p = withdrawBridgePending!;
                              const params = new URLSearchParams({
                                fromChain: String(SUI_CHAIN_ID),
                                toChain: String(BASE_MAINNET_CHAIN_ID),
                                fromToken: BRIDGE_TO_MARGIN_RECEIVE_TOKEN_SUI,
                                toToken: BASE_USDC_ADDRESS,
                                fromAmount: p.amountRaw,
                                fromAddress: p.fromAddress,
                              });
                              if (p.toAddress) params.set("toAddress", p.toAddress);
                              Linking.openURL(`https://explorer.li.fi?${params.toString()}`);
                            }}
                            style={({ pressed }) => ({ paddingVertical: 8, marginTop: 8, opacity: pressed ? 0.8 : 1 })}
                          >
                            <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                              Open LI.FI Explorer
                            </Text>
                          </Pressable>
                        ) : null}
                      </>
                    ) : null}
                  </View>
                )}

                <Text style={[styles.sectionTitle, { marginTop: 24 }]}>
                  Trade
                </Text>
                <View style={styles.card}>
                  <Text style={styles.inputLabel}>Side</Text>
                  <View style={styles.orderSideRow}>
                    <Pressable
                      onPress={() => setBaseTradeSide("long")}
                      style={[
                        styles.sideButton,
                        baseTradeSide === "long" && {
                          backgroundColor: "#22c55e",
                          opacity: 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.sideButtonText,
                          baseTradeSide === "long" && styles.sideButtonTextActive,
                        ]}
                      >
                        Long
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setBaseTradeSide("short")}
                      style={[
                        styles.sideButton,
                        baseTradeSide === "short" && {
                          backgroundColor: "#ef4444",
                          opacity: 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.sideButtonText,
                          baseTradeSide === "short" &&
                            styles.sideButtonTextActive,
                        ]}
                      >
                        Short
                      </Text>
                    </Pressable>
                  </View>
                  <Text style={styles.inputLabel}>Token (Base wallet)</Text>
                  <Pressable
                    onPress={() =>
                      setBaseTradeTokenPickerOpen(!baseTradeTokenPickerOpen)
                    }
                    style={[
                      styles.input,
                      {
                        color: colors.text,
                        borderColor: colors.tabIconDefault,
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.muted,
                        { color: colors.text },
                        !selectedBaseToken && { opacity: 0.7 },
                      ]}
                    >
                      {selectedBaseToken
                        ? `${selectedBaseToken.symbol} (${selectedBaseToken.formatted} available)`
                        : "Select token"}
                    </Text>
                    <FontAwesome
                      name={baseTradeTokenPickerOpen ? "chevron-up" : "chevron-down"}
                      size={14}
                      color={colors.tabIconDefault}
                    />
                  </Pressable>
                  {baseTradeTokenPickerOpen && baseBalances.length > 0 && (
                    <ScrollView
                      style={{
                        marginTop: 6,
                        borderWidth: 1,
                        borderColor: colors.tabIconDefault + "60",
                        borderRadius: 8,
                        overflow: "hidden",
                        maxHeight: baseBalances.length > 4 ? 176 : undefined,
                      }}
                      nestedScrollEnabled
                      showsVerticalScrollIndicator={baseBalances.length > 4}
                    >
                      {baseBalances.map((b) => (
                        <Pressable
                          key={b.symbol}
                          onPress={() => {
                            setSelectedBaseToken(b);
                            setBaseTradeTokenPickerOpen(false);
                          }}
                          style={({
                            pressed,
                          }: {
                            pressed: boolean;
                          }) => ({
                            paddingVertical: 12,
                            paddingHorizontal: 12,
                            backgroundColor:
                              selectedBaseToken?.symbol === b.symbol
                                ? colors.tint + "20"
                                : pressed
                                  ? colors.tabIconDefault + "15"
                                  : "transparent",
                          })}
                        >
                          <Text
                            style={[styles.muted, { color: colors.text }]}
                          >
                            {b.symbol} — {b.formatted}
                          </Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  )}
                  <Text style={[styles.inputLabel, { marginTop: 12 }]}>
                    Amount
                  </Text>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        color: colors.text,
                        borderColor: colors.tabIconDefault,
                      },
                    ]}
                    placeholder="0"
                    placeholderTextColor={colors.tabIconDefault + "99"}
                    value={baseTradeAmount}
                    onChangeText={setBaseTradeAmount}
                    keyboardType="decimal-pad"
                  />
                  {bridgeError ? (
                    <Text
                      style={[styles.muted, styles.errorText, { marginTop: 12 }]}
                    >
                      {bridgeError}
                    </Text>
                  ) : null}
                  {bridgeTxHash && bridgeLifiStatus ? (
                    <>
                      <View
                        style={[
                          {
                            alignSelf: "flex-start",
                            paddingHorizontal: 10,
                            paddingVertical: 5,
                            borderRadius: 8,
                            borderWidth: 1,
                            marginTop: 16,
                          },
                          {
                            backgroundColor:
                              bridgeLifiStatus.status === "DONE"
                                ? "#22c55e22"
                                : bridgeLifiStatus.status === "FAILED"
                                  ? "#ef444422"
                                  : "#eab30822",
                            borderColor:
                              bridgeLifiStatus.status === "DONE"
                                ? "#22c55e"
                                : bridgeLifiStatus.status === "FAILED"
                                  ? "#ef4444"
                                  : "#eab308",
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.primaryButtonText,
                            {
                              fontSize: 12,
                              color:
                                bridgeLifiStatus.status === "DONE"
                                  ? "#22c55e"
                                  : bridgeLifiStatus.status === "FAILED"
                                    ? "#ef4444"
                                    : "#eab308",
                            },
                          ]}
                        >
                          {bridgeLifiStatus.status === "PENDING"
                            ? "Bridging"
                            : bridgeLifiStatus.status === "DONE"
                              ? "Complete"
                              : bridgeLifiStatus.status === "FAILED"
                                ? "Failed"
                                : bridgeLifiStatus.status}
                        </Text>
                      </View>
                      {bridgeLifiStatus.substatusMessage != null &&
                       bridgeLifiStatus.status === "PENDING" ? (
                        <Text
                          style={[
                            styles.muted,
                            { color: colors.text, fontSize: 11, marginTop: 6 },
                          ]}
                          numberOfLines={2}
                        >
                          {bridgeLifiStatus.substatusMessage}
                        </Text>
                      ) : null}
                      <View
                        style={{
                          flexDirection: "row",
                          flexWrap: "wrap",
                          gap: 12,
                          marginTop: 10,
                        }}
                      >
                        {bridgeLifiStatus.sending?.txLink ? (
                          <Pressable
                            onPress={() =>
                              bridgeLifiStatus.sending?.txLink &&
                              Linking.openURL(
                                bridgeLifiStatus.sending.txLink
                              )
                            }
                            style={({ pressed }) => ({
                              paddingVertical: 4,
                              opacity: pressed ? 0.8 : 1,
                            })}
                          >
                            <Text
                              style={[
                                styles.muted,
                                {
                                  fontSize: 12,
                                  textDecorationLine: "underline",
                                  color: colors.tint,
                                },
                              ]}
                            >
                              Source tx
                            </Text>
                          </Pressable>
                        ) : null}
                        {bridgeLifiStatus.receiving?.txLink ? (
                          <Pressable
                            onPress={() =>
                              bridgeLifiStatus.receiving?.txLink &&
                              Linking.openURL(
                                bridgeLifiStatus.receiving.txLink
                              )
                            }
                            style={({ pressed }) => ({
                              paddingVertical: 4,
                              opacity: pressed ? 0.8 : 1,
                            })}
                          >
                            <Text
                              style={[
                                styles.muted,
                                {
                                  fontSize: 12,
                                  textDecorationLine: "underline",
                                  color: colors.tint,
                                },
                              ]}
                            >
                              Destination tx
                            </Text>
                          </Pressable>
                        ) : null}
                        {bridgeLifiStatus.lifiExplorerLink ? (
                          <Pressable
                            onPress={() =>
                              bridgeLifiStatus?.lifiExplorerLink &&
                              Linking.openURL(
                                bridgeLifiStatus.lifiExplorerLink
                              )
                            }
                            style={({ pressed }) => ({
                              paddingVertical: 4,
                              opacity: pressed ? 0.8 : 1,
                            })}
                          >
                            <Text
                              style={[
                                styles.muted,
                                {
                                  fontSize: 12,
                                  textDecorationLine: "underline",
                                  color: colors.tint,
                                },
                              ]}
                            >
                              Track on LI.FI
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    </>
                  ) : bridgeTxHash ? (
                    <View style={{ marginTop: 16 }}>
                      <View
                        style={{
                          alignSelf: "flex-start",
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                          borderRadius: 8,
                          borderWidth: 1,
                          backgroundColor: "#eab30822",
                          borderColor: "#eab308",
                        }}
                      >
                        <Text
                          style={[
                            styles.primaryButtonText,
                            { fontSize: 12, color: "#eab308" },
                          ]}
                        >
                          Checking…
                        </Text>
                      </View>
                      <Pressable
                        onPress={() =>
                          Linking.openURL(
                            `https://scan.li.fi/tx/${bridgeTxHash}`
                          )
                        }
                        style={({ pressed }) => ({
                          paddingVertical: 4,
                          marginTop: 8,
                          opacity: pressed ? 0.8 : 1,
                        })}
                      >
                        <Text
                          style={[
                            styles.muted,
                            {
                              fontSize: 12,
                              textDecorationLine: "underline",
                              color: colors.tint,
                            },
                          ]}
                        >
                          Track on LI.FI
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {bridgeLifiStatus?.status === "DONE" ? (
                    <>
                      <Pressable
                        onPress={handleDepositAndOpenPosition}
                        disabled={depositAndOpenLoading}
                        style={({ pressed }) => [
                          styles.primaryButton,
                          {
                            backgroundColor: colors.tint,
                            opacity: depositAndOpenLoading || pressed ? 0.8 : 1,
                            marginTop: 16,
                          },
                        ]}
                      >
                        {depositAndOpenLoading ? (
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
                            Deposit & open position
                          </Text>
                        )}
                      </Pressable>
                      <Text
                        style={[
                          styles.muted,
                          { color: colors.text, fontSize: 12, marginTop: 10 },
                        ]}
                      >
                        {managerForThisPool
                          ? "You have a margin manager for this pool. Next: deposit USDC and open your position."
                          : "You don't have a margin manager for this pool yet. We'll create one, then deposit and open your position."}
                      </Text>
                    </>
                  ) : !bridgeTxHash || bridgeLifiStatus?.status === "FAILED" ? (
                    <Pressable
                      onPress={handleSendBridge}
                      disabled={bridgeLoading}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        {
                          backgroundColor: colors.tint,
                          opacity: bridgeLoading || pressed ? 0.8 : 1,
                          marginTop: 16,
                        },
                      ]}
                    >
                      {bridgeLoading ? (
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
                          Send
                        </Text>
                      )}
                    </Pressable>
                  ) : null}
                </View>
              </>
            )}

            {showPlaceOrderBlock && (
              <>
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
              </>
            )}

          </>
        )}

            {/* Position block: only when there is open debt and at least one borrowed (human) >= 0.09. */}
            {showPositionBlock && (
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
                    onPress={onCloseAndSendToBase}
                    disabled={
                      closePositionLoading ||
                      closeAndWithdrawLoading ||
                      closeAndSendToBaseLoading
                    }
                    style={({ pressed }) => [
                      styles.primaryButton,
                      {
                        marginTop: 12,
                        backgroundColor: colors.tint,
                        opacity:
                          closePositionLoading ||
                          closeAndWithdrawLoading ||
                          closeAndSendToBaseLoading
                            ? 0.6
                            : pressed
                              ? 0.8
                              : 1,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Close and send to Base"
                  >
                    {closeAndSendToBaseLoading ? (
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
                        Close & send to Base
                      </Text>
                    )}
                  </Pressable>
                  <Text style={[styles.muted, { fontSize: 12, marginTop: 8 }]}>
                    Closes position, repays loan, withdraws USDC to Sui wallet,
                    then starts bridge to Base (sign when prompted).
                  </Text>
                  {/* Sui→Base bridge tracker: shown here when Close & send to Base started the flow */}
                  {(withdrawBridgePending || withdrawBridgeTxHash) && withdrawBridgeStartedBy === 'close-and-send' && (
                    <View style={{ marginTop: 16 }}>
                      {withdrawBridgeError ? (
                        <Text style={[styles.muted, styles.errorText, { marginBottom: 8 }]}>
                          {withdrawBridgeError}
                        </Text>
                      ) : null}
                      {withdrawBridgeTxHash && withdrawBridgeStatus ? (
                        <>
                          <View
                            style={[
                              {
                                alignSelf: "flex-start",
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 8,
                                borderWidth: 1,
                              },
                              {
                                backgroundColor:
                                  withdrawBridgeStatus.status === "DONE"
                                    ? "#22c55e22"
                                    : withdrawBridgeStatus.status === "FAILED"
                                      ? "#ef444422"
                                      : "#eab30822",
                                borderColor:
                                  withdrawBridgeStatus.status === "DONE"
                                    ? "#22c55e"
                                    : withdrawBridgeStatus.status === "FAILED"
                                      ? "#ef4444"
                                      : "#eab308",
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.primaryButtonText,
                                {
                                  fontSize: 12,
                                  color:
                                    withdrawBridgeStatus.status === "DONE"
                                      ? "#22c55e"
                                      : withdrawBridgeStatus.status === "FAILED"
                                        ? "#ef4444"
                                        : "#eab308",
                                },
                              ]}
                            >
                              {withdrawBridgeStatus.status === "PENDING"
                                ? "Bridging"
                                : withdrawBridgeStatus.status === "DONE"
                                  ? "Complete"
                                  : withdrawBridgeStatus.status === "FAILED"
                                    ? "Failed"
                                    : withdrawBridgeStatus.status}
                            </Text>
                          </View>
                          {withdrawBridgeStatus.substatusMessage != null &&
                           withdrawBridgeStatus.status === "PENDING" ? (
                            <Text
                              style={[
                                styles.muted,
                                { color: colors.text, fontSize: 11, marginTop: 6 },
                              ]}
                              numberOfLines={2}
                            >
                              {withdrawBridgeStatus.substatusMessage}
                            </Text>
                          ) : null}
                          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
                            {withdrawBridgeStatus.sending?.txLink ? (
                              <Pressable
                                onPress={() =>
                                  withdrawBridgeStatus.sending?.txLink &&
                                  Linking.openURL(withdrawBridgeStatus.sending.txLink)
                                }
                                style={({ pressed }) => ({ paddingVertical: 4, opacity: pressed ? 0.8 : 1 })}
                              >
                                <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                                  Source tx
                                </Text>
                              </Pressable>
                            ) : null}
                            {withdrawBridgeStatus.receiving?.txLink ? (
                              <Pressable
                                onPress={() =>
                                  withdrawBridgeStatus.receiving?.txLink &&
                                  Linking.openURL(withdrawBridgeStatus.receiving.txLink)
                                }
                                style={({ pressed }) => ({ paddingVertical: 4, opacity: pressed ? 0.8 : 1 })}
                              >
                                <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                                  Destination tx
                                </Text>
                              </Pressable>
                            ) : null}
                            <Pressable
                              onPress={() =>
                                Linking.openURL(
                                  withdrawBridgeStatus?.lifiExplorerLink ?? `https://scan.li.fi/tx/${withdrawBridgeTxHash}`
                                )
                              }
                              style={({ pressed }) => ({ paddingVertical: 4, opacity: pressed ? 0.8 : 1 })}
                            >
                              <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                                Track on LI.FI
                              </Text>
                            </Pressable>
                          </View>
                        </>
                      ) : withdrawBridgeTxHash ? (
                        <View>
                          <View
                            style={{
                              alignSelf: "flex-start",
                              paddingHorizontal: 10,
                              paddingVertical: 5,
                              borderRadius: 8,
                              borderWidth: 1,
                              backgroundColor: "#eab30822",
                              borderColor: "#eab308",
                            }}
                          >
                            <Text style={[styles.primaryButtonText, { fontSize: 12, color: "#eab308" }]}>
                              Checking…
                            </Text>
                          </View>
                          <Pressable
                            onPress={() => Linking.openURL(`https://scan.li.fi/tx/${withdrawBridgeTxHash}`)}
                            style={({ pressed }) => ({ paddingVertical: 4, marginTop: 8, opacity: pressed ? 0.8 : 1 })}
                          >
                            <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                              Track on LI.FI
                            </Text>
                          </Pressable>
                        </View>
                      ) : null}
                      {(!withdrawBridgeTxHash || withdrawBridgeStatus?.status === "FAILED") && withdrawBridgePending ? (
                        <>
                          <Pressable
                            onPress={() => onBridgeToBase()}
                            disabled={withdrawBridgeLoading}
                            style={({ pressed }) => [
                              styles.primaryButton,
                              {
                                backgroundColor: colors.tint,
                                opacity: withdrawBridgeLoading || pressed ? 0.8 : 1,
                                marginTop: 12,
                              },
                            ]}
                          >
                            {withdrawBridgeLoading ? (
                              <ActivityIndicator size="small" color={colors.background} />
                            ) : (
                              <Text style={[styles.primaryButtonText, { color: colors.background }]}>
                                Bridge to Base
                              </Text>
                            )}
                          </Pressable>
                          {withdrawBridgeError?.includes("LI.FI Explorer") ? (
                            <Pressable
                              onPress={() => {
                                const p = withdrawBridgePending!;
                                const params = new URLSearchParams({
                                  fromChain: String(SUI_CHAIN_ID),
                                  toChain: String(BASE_MAINNET_CHAIN_ID),
                                  fromToken: BRIDGE_TO_MARGIN_RECEIVE_TOKEN_SUI,
                                  toToken: BASE_USDC_ADDRESS,
                                  fromAmount: p.amountRaw,
                                  fromAddress: p.fromAddress,
                                });
                                if (p.toAddress) params.set("toAddress", p.toAddress);
                                Linking.openURL(`https://explorer.li.fi?${params.toString()}`);
                              }}
                              style={({ pressed }) => ({ paddingVertical: 8, marginTop: 8, opacity: pressed ? 0.8 : 1 })}
                            >
                              <Text style={[styles.muted, { fontSize: 12, textDecorationLine: "underline", color: colors.tint }]}>
                                Open LI.FI Explorer
                              </Text>
                            </Pressable>
                          ) : null}
                        </>
                      ) : null}
                    </View>
                  )}
                  {showPlaceOrderBlock && (
                    <Pressable
                      onPress={() => onClosePosition()}
                      disabled={closePositionLoading}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        {
                          marginTop: 12,
                          backgroundColor: "transparent",
                          borderWidth: 1,
                          borderColor: colors.tabIconDefault,
                          opacity: closePositionLoading ? 0.6 : pressed ? 0.8 : 1,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Close position only"
                    >
                      {closePositionLoading ? (
                        <ActivityIndicator
                          size="small"
                          color={colors.text}
                        />
                      ) : (
                        <Text
                          style={[
                            styles.primaryButtonText,
                            { color: colors.text, fontSize: 14 },
                          ]}
                        >
                          Close position only (keep USDC in margin)
                        </Text>
                      )}
                    </Pressable>
                  )}
                </View>
              </>
            )}

      </ScrollView>

      <Modal
        visible={indicatorsModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIndicatorsModalVisible(false)}
      >
        <Pressable
          style={styles.chartModalOverlay}
          onPress={() => setIndicatorsModalVisible(false)}
        >
          <Pressable
            style={[
              styles.chartModalContent,
              { backgroundColor: colors.background },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.chartModalHeader}>
              <Text style={[styles.chartModalTitle, { color: colors.text }]}>
                Indicators
              </Text>
              <Pressable onPress={() => setIndicatorsModalVisible(false)}>
                <Text style={[styles.chartModalClose, { color: colors.tint }]}>
                  Done
                </Text>
              </Pressable>
            </View>
            <View style={styles.chartIndicatorRow}>
              <Text style={[styles.chartIndicatorLabel, { color: colors.text }]}>
                Volume
              </Text>
              <Pressable
                onPress={() => setShowVolumeTv((v) => !v)}
                style={[
                  styles.chartToggle,
                  showVolumeTv && { backgroundColor: colors.tint },
                ]}
              >
                <View
                  style={[
                    styles.chartToggleThumb,
                    showVolumeTv && styles.chartToggleThumbOn,
                    { backgroundColor: colors.background },
                  ]}
                />
              </Pressable>
            </View>
            {INDICATOR_PRESETS.map((preset) => (
              <Pressable
                key={preset.key}
                onPress={() => toggleIndicatorTv(preset)}
                style={[
                  styles.chartIndicatorRow,
                  hasIndicatorTv(preset) && {
                    backgroundColor: colors.tint + "20",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chartIndicatorLabel,
                    { color: colors.text },
                  ]}
                >
                  {preset.label}
                </Text>
                <View
                  style={[
                    styles.chartCheckbox,
                    hasIndicatorTv(preset) && { backgroundColor: colors.tint },
                  ]}
                >
                  {hasIndicatorTv(preset) && (
                    <Text style={styles.chartCheckmark}>✓</Text>
                  )}
                </View>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={drawModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setDrawModalVisible(false)}
      >
        <Pressable
          style={styles.chartModalOverlay}
          onPress={() => setDrawModalVisible(false)}
        >
          <Pressable
            style={[
              styles.chartModalContent,
              { backgroundColor: colors.background },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.chartModalHeader}>
              <Text style={[styles.chartModalTitle, { color: colors.text }]}>
                Draw lines
              </Text>
              <Pressable onPress={() => setDrawModalVisible(false)}>
                <Text style={[styles.chartModalClose, { color: colors.tint }]}>
                  Done
                </Text>
              </Pressable>
            </View>
            <Text style={[styles.chartDrawLabel, { color: colors.text }]}>
              Horizontal price line
            </Text>
            <View style={styles.chartDrawRow}>
              <TextInput
                style={[
                  styles.chartDrawInput,
                  {
                    color: colors.text,
                    borderColor: colors.tabIconDefault,
                  },
                ]}
                placeholder="Price"
                placeholderTextColor={colors.tabIconDefault}
                value={newLinePrice}
                onChangeText={setNewLinePrice}
                keyboardType="decimal-pad"
              />
              <Pressable
                onPress={addPriceLineTv}
                style={[
                  styles.chartDrawAddButton,
                  { backgroundColor: colors.tint },
                ]}
              >
                <Text
                  style={[
                    styles.chartDrawAddText,
                    { color: colors.background },
                  ]}
                >
                  Add
                </Text>
              </Pressable>
            </View>
            {priceLinesTv.length > 0 && (
              <View style={styles.chartLineList}>
                <Text
                  style={[styles.chartLineListTitle, { color: colors.text }]}
                >
                  Lines
                </Text>
                {priceLinesTv.map((line) => (
                  <View
                    key={line.id}
                    style={[
                      styles.chartLineItem,
                      { borderColor: colors.tabIconDefault },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chartLineItemPrice,
                        { color: colors.text },
                      ]}
                    >
                      {line.price.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 6,
                      })}
                    </Text>
                    <Pressable
                      onPress={() => removePriceLineTv(line.id)}
                      hitSlop={8}
                    >
                      <Text style={styles.chartLineItemRemove}>Remove</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

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
    marginBottom: 8,
  },
  chartSegmentRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(128,128,128,0.2)",
    borderRadius: 10,
    padding: 3,
  },
  chartSegmentButton: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  chartSegmentButtonText: { fontSize: 13, fontWeight: "600" },
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
  tvToolbar: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    paddingVertical: 10,
    marginBottom: 10,
  },
  tvToolbarScroll: { flexGrow: 0 },
  tvToolbarInterval: { fontSize: 13, fontWeight: "600", marginRight: 8 },
  tvToolbarDivider: {
    width: 1,
    height: 16,
    backgroundColor: "rgba(128,128,128,0.4)",
    marginHorizontal: 8,
  },
  tvToolbarButton: { paddingVertical: 4, paddingHorizontal: 6, marginRight: 4 },
  tvToolbarButtonText: { fontSize: 13, fontWeight: "600" },
  tvChartWrap: {
    marginHorizontal: -20,
    paddingVertical: 12,
    paddingHorizontal: 0,
    borderWidth: 0,
  },
  chartModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  chartModalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 40,
  },
  chartModalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  chartModalTitle: { fontSize: 18, fontWeight: "700" },
  chartModalClose: { fontSize: 16, fontWeight: "600" },
  chartIndicatorRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderRadius: 8,
    marginBottom: 4,
  },
  chartIndicatorLabel: { fontSize: 16, fontWeight: "500" },
  chartToggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    padding: 2,
    justifyContent: "center",
    backgroundColor: "rgba(128,128,128,0.3)",
  },
  chartToggleThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignSelf: "flex-start",
  },
  chartToggleThumbOn: { alignSelf: "flex-end" },
  chartCheckbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "rgba(128,128,128,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  chartCheckmark: { color: "#fff", fontWeight: "bold", fontSize: 14 },
  chartDrawLabel: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  chartDrawRow: { flexDirection: "row", gap: 12, marginBottom: 20 },
  chartDrawInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  chartDrawAddButton: {
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  chartDrawAddText: { fontSize: 16, fontWeight: "600" },
  chartLineList: { marginTop: 8 },
  chartLineListTitle: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  chartLineItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  chartLineItemPrice: { fontSize: 16, fontWeight: "500" },
  chartLineItemRemove: { fontSize: 14, color: "#ef4444", fontWeight: "600" },
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
