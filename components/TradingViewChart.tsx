import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Themed';
import WebView from 'react-native-webview';
import { getTradingViewChartHtml } from '@/lib/tradingview-chart-html';

/** OHLCV candle from indexer: [timestamp, open, high, low, close, volume] */
export type OhlcvCandle = [number, number, number, number, number, number];

const CHART_HEIGHT = 220;

interface TradingViewChartProps {
  candles: OhlcvCandle[];
  width?: number;
  height?: number;
  loading?: boolean;
  error?: string | null;
}

/** Convert indexer format to Lightweight Charts format (time in seconds). */
function toLightweightChartsData(candles: OhlcvCandle[]): Array<{ time: number; open: number; high: number; low: number; close: number }> {
  return candles.map((c) => {
    let ts = c[0];
    if (ts > 1e12) ts = Math.floor(ts / 1000);
    return {
      time: ts,
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
    };
  });
}

export function TradingViewChart({
  candles,
  width = Dimensions.get('window').width - 48,
  height = CHART_HEIGHT,
  loading,
  error,
}: TradingViewChartProps) {
  const webRef = useRef<WebView>(null);
  const [chartReady, setChartReady] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);

  const injectCandles = useCallback(
    (data: OhlcvCandle[]) => {
      if (!data.length || !webRef.current) return;
      const payload = toLightweightChartsData(data);
      const script = `(function(){if(typeof window.updateChart==='function'){window.updateChart(${JSON.stringify(payload).replace(/</g, '\\u003c')});}})();`;
      webRef.current.injectJavaScript(script);
    },
    []
  );

  useEffect(() => {
    if (!candles.length) return;
    if (chartReady) {
      injectCandles(candles);
      return;
    }
    const t = setTimeout(() => injectCandles(candles), 800);
    return () => clearTimeout(t);
  }, [chartReady, candles, injectCandles]);

  const onMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'chartReady') setChartReady(true);
      if (msg.type === 'error') setChartError(msg.message ?? 'Chart error');
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
        originWhitelist={['*']}
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
    overflow: 'hidden',
    borderRadius: 8,
  },
  webview: {
    backgroundColor: 'transparent',
  },
  muted: {
    fontSize: 14,
    opacity: 0.7,
    textAlign: 'center',
    paddingVertical: 24,
  },
  error: {
    fontSize: 14,
    color: '#ef4444',
    textAlign: 'center',
    paddingVertical: 24,
  },
});
