import { Text } from "@/components/Themed";
import { getTradingViewChartHtml } from "@/lib/tradingview-chart-html";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, StyleSheet, View } from "react-native";
import WebView from "react-native-webview";

/** OHLCV candle from indexer: [timestamp, open, high, low, close, volume] */
export type OhlcvCandle = [number, number, number, number, number, number];

const CHART_HEIGHT = 220;

export type ChartTypeOption = "candle" | "line";
export type IndicatorOption = { type: "MA" | "EMA"; period: number };
export type PriceLineOption = { id: string; price: number; color?: string };

interface TradingViewChartProps {
  candles: OhlcvCandle[];
  width?: number;
  height?: number;
  loading?: boolean;
  error?: string | null;
  chartType?: ChartTypeOption;
  indicators?: IndicatorOption[];
  showVolume?: boolean;
  priceLines?: PriceLineOption[];
}

/** Convert indexer format to Lightweight Charts format (time in seconds, chronological order). Includes volume for histogram. */
function toLightweightChartsData(
  candles: OhlcvCandle[]
): Array<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}> {
  const tsToMs = (ts: number) => (ts >= 1e12 ? ts : ts * 1000);
  const sorted = [...candles].sort((a, b) => tsToMs(a[0]) - tsToMs(b[0]));
  return sorted.map((c) => {
    let ts = c[0];
    if (ts > 1e12) ts = Math.floor(ts / 1000);
    return {
      time: ts,
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    };
  });
}

export function TradingViewChart({
  candles,
  width = Dimensions.get("window").width - 48,
  height = CHART_HEIGHT,
  loading,
  error,
  chartType = "candle",
  indicators = [],
  showVolume = true,
  priceLines = [],
}: TradingViewChartProps) {
  const webRef = useRef<WebView>(null);
  const [chartReady, setChartReady] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const priceLineIdsRef = useRef<Set<string>>(new Set());

  const injectCandles = useCallback((data: OhlcvCandle[]) => {
    if (!data.length || !webRef.current) return;
    const payload = toLightweightChartsData(data);
    const payloadStr = JSON.stringify(payload).replace(/</g, "\\u003c");
    const script = `(function(){var d=${payloadStr};if(typeof window.updateChart==='function'){window.updateChart(d);}else{window.__chartCandles=d;}})();`;
    webRef.current.injectJavaScript(script);
  }, []);

  useEffect(() => {
    if (!candles.length) return;
    injectCandles(candles);
    const t1 = setTimeout(() => injectCandles(candles), 400);
    const t2 = setTimeout(() => injectCandles(candles), 1200);
    const t3 = setTimeout(() => injectCandles(candles), 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [candles, injectCandles]);

  useEffect(() => {
    if (!chartReady || !webRef.current) return;
    const s = `(function(){if(typeof window.setChartType==='function')window.setChartType(${JSON.stringify(
      chartType
    )});})();`;
    webRef.current.injectJavaScript(s);
  }, [chartReady, chartType]);

  useEffect(() => {
    if (!chartReady || !webRef.current) return;
    const arr = indicators.map((i) => ({ type: i.type, period: i.period }));
    const s = `(function(){if(typeof window.setIndicators==='function')window.setIndicators(${JSON.stringify(
      arr
    )});})();`;
    webRef.current.injectJavaScript(s);
  }, [chartReady, indicators]);

  useEffect(() => {
    if (!chartReady || !webRef.current) return;
    const s = `(function(){if(typeof window.setShowVolume==='function')window.setShowVolume(${JSON.stringify(
      showVolume
    )});})();`;
    webRef.current.injectJavaScript(s);
  }, [chartReady, showVolume]);

  useEffect(() => {
    if (!chartReady || !webRef.current) return;
    const prevIds = priceLineIdsRef.current;
    const currentIds = new Set(priceLines.map((p) => p.id));
    const toRemove = [...prevIds].filter((id) => !currentIds.has(id));
    const toAdd = priceLines;
    const removeCalls = toRemove
      .map((id) => `window.removePriceLine(${JSON.stringify(id)});`)
      .join("");
    const addCalls = toAdd
      .map(
        (p) =>
          `window.addPriceLine(${JSON.stringify({
            id: p.id,
            price: p.price,
            color: p.color,
          })});`
      )
      .join("");
    priceLineIdsRef.current = currentIds;
    webRef.current.injectJavaScript(
      `(function(){${removeCalls}${addCalls}})();`
    );
  }, [chartReady, priceLines]);

  const onMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "chartReady") setChartReady(true);
      if (msg.type === "error") setChartError(msg.message ?? "Chart error");
    } catch {
      // ignore
    }
  }, []);

  if (error || chartError) {
    return (
      <View style={[styles.container, { width, height }]}>
        <Text style={styles.error}>{chartError ?? error}</Text>
      </View>
    );
  }

  if (loading && !candles.length) {
    return (
      <View style={[styles.container, { width, height }]}>
        <Text style={styles.muted}>Loading chart…</Text>
      </View>
    );
  }

  if (!loading && !candles.length) {
    return (
      <View style={[styles.container, { width, height }]}>
        <Text style={styles.muted}>No chart data for this pair.</Text>
      </View>
    );
  }

  const html = getTradingViewChartHtml(Math.round(width), Math.round(height));

  return (
    <View style={[styles.container, { width }]}>
      <WebView
        ref={webRef}
        source={{ html }}
        style={[styles.webview, { width, height }]}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        onMessage={onMessage}
        originWhitelist={["*"]}
        mixedContentMode="compatibility"
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 8,
    minHeight: CHART_HEIGHT,
    overflow: "hidden",
    borderRadius: 8,
  },
  webview: {
    backgroundColor: "transparent",
  },
  muted: {
    fontSize: 14,
    opacity: 0.7,
    textAlign: "center",
    paddingVertical: 24,
  },
  error: {
    fontSize: 14,
    color: "#ef4444",
    textAlign: "center",
    paddingVertical: 24,
  },
});
