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
  collateralUsdFromState,
  debtUsdFromState,
  formatRiskRatio,
  useMarginHistory,
  useMarginManagerState,
  useMarginManagersInfo,
  useOhlcv,
  useStoredMarginManager,
  useTicker,
} from "@/hooks/useDeepBookMargin";
import {
  debugFetchOhlcv,
  poolNameFromSymbols,
  type MarginManagerInfo,
  type OhlcvInterval,
} from "@/lib/deepbook-indexer";
import type { StoredMarginManager } from "@/lib/margin-manager-storage";
import { getSuiAddressFromUser } from "@/lib/sui";
import { usePrivy } from "@privy-io/expo";

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

  const { stored, save } = useStoredMarginManager(suiAddress);
  const isManagerForThisPool =
    stored?.deepbook_pool_id === poolInfoForPair?.deepbook_pool_id;
  const {
    state,
    loading: stateLoading,
    error: stateError,
  } = useMarginManagerState(
    isManagerForThisPool ? stored?.margin_manager_id ?? null : null,
    poolInfoForPair?.deepbook_pool_id ?? null
  );
  const {
    collateral,
    borrowed,
    repaid,
    liquidations,
    loading: historyLoading,
    error: historyError,
  } = useMarginHistory(
    isManagerForThisPool ? stored?.margin_manager_id ?? null : null,
    stored?.base_margin_pool_id ?? null,
    stored?.quote_margin_pool_id ?? null
  );

  const [linkManagerId, setLinkManagerId] = useState("");
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [payWithDeep, setPayWithDeep] = useState(true);

  const onSaveLinkedManager = useCallback(() => {
    if (!suiAddress || !linkManagerId.trim() || !poolInfoForPair) {
      Alert.alert("Link manager", "Enter your margin manager ID.");
      return;
    }
    const data: StoredMarginManager = {
      margin_manager_id: linkManagerId.trim(),
      deepbook_pool_id: poolInfoForPair.deepbook_pool_id,
      base_margin_pool_id: poolInfoForPair.base_margin_pool_id,
      quote_margin_pool_id: poolInfoForPair.quote_margin_pool_id,
    };
    save(data);
    setLinkManagerId("");
  }, [suiAddress, linkManagerId, poolInfoForPair, save]);

  const onDeposit = () =>
    Alert.alert("Deposit", "Deposit flow will connect to SDK/backend.");
  const onWithdraw = () =>
    Alert.alert("Withdraw", "Withdraw flow will connect to SDK/backend.");
  const onBorrow = () =>
    Alert.alert("Borrow", "Borrow flow will connect to SDK/backend.");
  const onRepay = () =>
    Alert.alert("Repay", "Repay flow will connect to SDK/backend.");
  const onCreateManager = () =>
    Alert.alert(
      "Create margin manager",
      "Create margin manager will connect to SDK/backend."
    );
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

  const hasManager = !!stored?.margin_manager_id && isManagerForThisPool;
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
                        chartInterval === int ? colors.background : colors.text,
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
            <Text style={styles.cardLabel}>Margin account</Text>
            {!hasManager ? (
              <>
                <Text style={styles.muted}>
                  No margin manager linked for this pair.
                </Text>
                <Pressable
                  onPress={onCreateManager}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    {
                      backgroundColor: colors.tint,
                      opacity: pressed ? 0.8 : 1,
                      marginTop: 16,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.primaryButtonText,
                      { color: colors.background },
                    ]}
                  >
                    Create margin manager
                  </Text>
                </Pressable>
                <Text style={[styles.inputLabel, { marginTop: 20 }]}>
                  Link existing manager
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.tabIconDefault },
                  ]}
                  placeholder="Margin manager ID (0x…)"
                  placeholderTextColor={colors.tabIconDefault}
                  value={linkManagerId}
                  onChangeText={setLinkManagerId}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Pressable
                  onPress={onSaveLinkedManager}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    {
                      backgroundColor: colors.tint,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.primaryButtonText,
                      { color: colors.background },
                    ]}
                  >
                    Save & load
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
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
                          parseFloat(state.risk_ratio) < 1.2
                            ? styles.riskWarning
                            : styles.healthOk,
                        ]}
                      >
                        {formatRiskRatio(state.risk_ratio)}
                      </Text>
                    </View>
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
                <Pressable
                  onPress={onBorrow}
                  style={({ pressed }) => [
                    styles.actionButton,
                    { borderColor: colors.tint, opacity: pressed ? 0.8 : 1 },
                  ]}
                >
                  <Text
                    style={[styles.actionButtonText, { color: colors.tint }]}
                  >
                    Borrow
                  </Text>
                </Pressable>
                <Pressable
                  onPress={onRepay}
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
                    Repay
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
                      {formatTs(e.checkpoint_timestamp_ms)} · {e.amount}
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
                style={[styles.primaryButtonText, { color: colors.background }]}
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
  );
}

const styles = StyleSheet.create({
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
});
