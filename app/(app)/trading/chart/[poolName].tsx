import { Text } from "@/components/Themed";
import {
  TradingViewChart,
  type ChartTypeOption,
  type IndicatorOption,
  type PriceLineOption,
} from "@/components/TradingViewChart";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { useOhlcv, useTicker } from "@/hooks/useDeepBookMargin";
import type { OhlcvInterval } from "@/lib/deepbook-indexer";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const FULL_CHART_INTERVALS: OhlcvInterval[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
  "1w",
];
const FULL_CHART_DISPLAY_LIMIT = 300;
const FULL_CHART_FETCH_LIMIT = 600;
const PRICE_POLL_MS = 5000;
const CHART_HEIGHT = Math.min(Dimensions.get("window").height * 0.5, 340);

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

function formatPairLabel(poolName: string): string {
  return poolName.replace("_", "/");
}

export default function FullScreenChartScreen() {
  const { poolName, interval } = useLocalSearchParams<{
    poolName: string;
    interval?: OhlcvInterval;
  }>();
  const decodedPoolName = poolName ? decodeURIComponent(poolName) : null;

  const [chartInterval, setChartInterval] = useState<OhlcvInterval>(
    (interval as OhlcvInterval | undefined) ?? "1m"
  );
  const [chartType, setChartType] = useState<ChartTypeOption>("candle");
  const [showVolume, setShowVolume] = useState(true);
  const [indicators, setIndicators] = useState<IndicatorOption[]>([]);
  const [priceLines, setPriceLines] = useState<PriceLineOption[]>([]);
  const [indicatorsModalVisible, setIndicatorsModalVisible] = useState(false);
  const [drawModalVisible, setDrawModalVisible] = useState(false);
  const [newLinePrice, setNewLinePrice] = useState("");

  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const insets = useSafeAreaInsets();

  const { ticker } = useTicker(PRICE_POLL_MS);
  const livePrice = decodedPoolName
    ? ticker[decodedPoolName]?.last_price
    : undefined;

  const {
    candles,
    allCandles,
    loading: ohlcvLoading,
    error: ohlcvError,
  } = useOhlcv(decodedPoolName, {
    interval: chartInterval,
    displayLimit: FULL_CHART_DISPLAY_LIMIT,
    fetchLimit: FULL_CHART_FETCH_LIMIT,
  });

  const displayPoolLabel = decodedPoolName
    ? formatPairLabel(decodedPoolName)
    : "—";
  const navigation = useNavigation();

  useEffect(() => {
    navigation.setOptions({ title: `${displayPoolLabel} chart` });
  }, [navigation, displayPoolLabel]);

  const priceLabel = useMemo(() => {
    if (typeof livePrice !== "number") return "—";
    return livePrice.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }, [livePrice]);

  const toggleIndicator = useCallback(
    (preset: (typeof INDICATOR_PRESETS)[0]) => {
      setIndicators((prev) => {
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

  const hasIndicator = useCallback(
    (preset: (typeof INDICATOR_PRESETS)[0]) =>
      indicators.some(
        (i) => i.type === preset.ind.type && i.period === preset.ind.period
      ),
    [indicators]
  );

  const addPriceLine = useCallback(() => {
    const p = parseFloat(newLinePrice.trim());
    if (Number.isFinite(p)) {
      setPriceLines((prev) => [
        ...prev,
        { id: `line-${Date.now()}`, price: p, color: "#94a3b8" },
      ]);
      setNewLinePrice("");
    }
  }, [newLinePrice]);

  const removePriceLine = useCallback((id: string) => {
    setPriceLines((prev) => prev.filter((l) => l.id !== id));
  }, []);

  if (!decodedPoolName) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Invalid pair.</Text>
      </View>
    );
  }

  const topPadding = insets.top + 24;

  return (
    <>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.container,
          { paddingTop: topPadding },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.pairName, { color: colors.text }]}>
              {displayPoolLabel}
            </Text>
            <Text style={styles.muted}>Price</Text>
          </View>
          <View style={styles.priceBox}>
            <Text style={[styles.priceValue, { color: colors.text }]}>
              {priceLabel}
            </Text>
          </View>
        </View>

        {/* Groww-style toolbar */}
        <View style={[styles.toolbar, { borderColor: colors.tabIconDefault }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.toolbarScroll}
          >
            <Text style={[styles.toolbarInterval, { color: colors.text }]}>
              {chartInterval.toUpperCase()}
            </Text>
            <View style={styles.toolbarDivider} />
            <Pressable
              onPress={() =>
                setChartType((t) => (t === "candle" ? "line" : "candle"))
              }
              style={styles.toolbarButton}
            >
              <Text style={[styles.toolbarButtonText, { color: colors.text }]}>
                {chartType === "candle" ? "Candle" : "Line"}
              </Text>
            </Pressable>
            <View style={styles.toolbarDivider} />
            <Pressable
              onPress={() => setIndicatorsModalVisible(true)}
              style={styles.toolbarButton}
            >
              <Text style={[styles.toolbarButtonText, { color: colors.text }]}>
                fₓ Indicators
              </Text>
            </Pressable>
            <View style={styles.toolbarDivider} />
            <Pressable
              onPress={() => setDrawModalVisible(true)}
              style={styles.toolbarButton}
            >
              <Text style={[styles.toolbarButtonText, { color: colors.text }]}>
                ✎ Draw
              </Text>
            </Pressable>
          </ScrollView>
        </View>

        <View
          style={[styles.intervalRow, { borderColor: colors.tabIconDefault }]}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {FULL_CHART_INTERVALS.map((int) => (
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

        <View style={styles.card}>
          <TradingViewChart
            candles={allCandles.length ? allCandles : candles}
            width={Dimensions.get("window").width - 32}
            height={CHART_HEIGHT}
            loading={ohlcvLoading}
            error={ohlcvError}
            chartType={chartType}
            indicators={indicators}
            showVolume={showVolume}
            priceLines={priceLines}
          />
        </View>
      </ScrollView>

      <Modal
        visible={indicatorsModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIndicatorsModalVisible(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setIndicatorsModalVisible(false)}
        >
          <Pressable
            style={[
              styles.modalContent,
              { backgroundColor: colors.background },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                Indicators
              </Text>
              <Pressable onPress={() => setIndicatorsModalVisible(false)}>
                <Text style={[styles.modalClose, { color: colors.tint }]}>
                  Done
                </Text>
              </Pressable>
            </View>
            <View style={styles.indicatorRow}>
              <Text style={[styles.indicatorLabel, { color: colors.text }]}>
                Volume
              </Text>
              <Pressable
                onPress={() => setShowVolume((v) => !v)}
                style={[
                  styles.toggle,
                  showVolume && { backgroundColor: colors.tint },
                ]}
              >
                <View
                  style={[
                    styles.toggleThumb,
                    showVolume && styles.toggleThumbOn,
                    { backgroundColor: colors.background },
                  ]}
                />
              </Pressable>
            </View>
            {INDICATOR_PRESETS.map((preset) => (
              <Pressable
                key={preset.key}
                onPress={() => toggleIndicator(preset)}
                style={[
                  styles.indicatorRow,
                  hasIndicator(preset) && {
                    backgroundColor: colors.tint + "20",
                  },
                ]}
              >
                <Text style={[styles.indicatorLabel, { color: colors.text }]}>
                  {preset.label}
                </Text>
                <View
                  style={[
                    styles.checkbox,
                    hasIndicator(preset) && { backgroundColor: colors.tint },
                  ]}
                >
                  {hasIndicator(preset) && (
                    <Text style={styles.checkmark}>✓</Text>
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
          style={styles.modalOverlay}
          onPress={() => setDrawModalVisible(false)}
        >
          <Pressable
            style={[
              styles.modalContent,
              { backgroundColor: colors.background },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                Draw lines
              </Text>
              <Pressable onPress={() => setDrawModalVisible(false)}>
                <Text style={[styles.modalClose, { color: colors.tint }]}>
                  Done
                </Text>
              </Pressable>
            </View>
            <Text style={[styles.drawLabel, { color: colors.text }]}>
              Horizontal price line
            </Text>
            <View style={styles.drawRow}>
              <TextInput
                style={[
                  styles.drawInput,
                  { color: colors.text, borderColor: colors.tabIconDefault },
                ]}
                placeholder="Price"
                placeholderTextColor={colors.tabIconDefault}
                value={newLinePrice}
                onChangeText={setNewLinePrice}
                keyboardType="decimal-pad"
              />
              <Pressable
                onPress={addPriceLine}
                style={[styles.drawAddButton, { backgroundColor: colors.tint }]}
              >
                <Text
                  style={[styles.drawAddText, { color: colors.background }]}
                >
                  Add
                </Text>
              </Pressable>
            </View>
            {priceLines.length > 0 && (
              <View style={styles.lineList}>
                <Text style={[styles.lineListTitle, { color: colors.text }]}>
                  Lines
                </Text>
                {priceLines.map((line) => (
                  <View
                    key={line.id}
                    style={[
                      styles.lineItem,
                      { borderColor: colors.tabIconDefault },
                    ]}
                  >
                    <Text
                      style={[styles.lineItemPrice, { color: colors.text }]}
                    >
                      {line.price.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 6,
                      })}
                    </Text>
                    <Pressable
                      onPress={() => removePriceLine(line.id)}
                      hitSlop={8}
                    >
                      <Text style={styles.lineItemRemove}>Remove</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  container: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  pairName: { fontSize: 22, fontWeight: "700", marginBottom: 4 },
  priceBox: { alignItems: "flex-end" },
  priceValue: { fontSize: 20, fontWeight: "600" },
  muted: { fontSize: 12, opacity: 0.7 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    paddingVertical: 12,
    marginBottom: 16,
  },
  toolbarScroll: { flexGrow: 0 },
  toolbarInterval: { fontSize: 13, fontWeight: "600", marginRight: 8 },
  toolbarDivider: {
    width: 1,
    height: 16,
    backgroundColor: "rgba(128,128,128,0.4)",
    marginHorizontal: 8,
  },
  toolbarButton: { paddingVertical: 4, paddingHorizontal: 6, marginRight: 4 },
  toolbarButtonText: { fontSize: 13, fontWeight: "600" },
  intervalRow: {
    flexDirection: "row",
    marginBottom: 16,
    paddingVertical: 8,
  },
  intervalButton: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    marginRight: 6,
  },
  intervalButtonText: { fontSize: 12, fontWeight: "600" },
  card: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.3)",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  modalClose: { fontSize: 16, fontWeight: "600" },
  indicatorRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderRadius: 8,
    marginBottom: 4,
  },
  indicatorLabel: { fontSize: 16, fontWeight: "500" },
  toggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    padding: 2,
    justifyContent: "center",
    backgroundColor: "rgba(128,128,128,0.3)",
  },
  toggleThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignSelf: "flex-start",
  },
  toggleThumbOn: { alignSelf: "flex-end" },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "rgba(128,128,128,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  checkmark: { color: "#fff", fontWeight: "bold", fontSize: 14 },
  drawLabel: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  drawRow: { flexDirection: "row", gap: 12, marginBottom: 20 },
  drawInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  drawAddButton: {
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  drawAddText: { fontSize: 16, fontWeight: "600" },
  lineList: { marginTop: 8 },
  lineListTitle: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  lineItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  lineItemPrice: { fontSize: 16, fontWeight: "500" },
  lineItemRemove: { fontSize: 14, color: "#ef4444", fontWeight: "600" },
});
