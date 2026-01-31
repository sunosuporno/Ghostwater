import React, { useMemo } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text } from '@/components/Themed';

/** OHLCV candle: [timestamp, open, high, low, close, volume] */
type OhlcvCandle = [number, number, number, number, number, number];

const CHART_HEIGHT = 180;
const PADDING = { top: 8, right: 8, bottom: 24, left: 48 };

interface PriceChartProps {
  candles: OhlcvCandle[];
  width?: number;
  height?: number;
  loading?: boolean;
  error?: string | null;
}

export function PriceChart({
  candles,
  width = Dimensions.get('window').width - 48,
  height = CHART_HEIGHT,
  loading,
  error,
}: PriceChartProps) {
  const { path, minPrice, maxPrice } = useMemo(() => {
    if (!candles.length) return { path: '', minPrice: 0, maxPrice: 0 };
    const closes = candles.map((c) => c[4]);
    const minP = Math.min(...closes);
    const maxP = Math.max(...closes);
    const range = maxP - minP || 1;
    const w = width - PADDING.left - PADDING.right;
    const h = height - PADDING.top - PADDING.bottom;
    const points = candles.map((c, i) => {
      const x = PADDING.left + (i / (candles.length - 1 || 1)) * w;
      const y = PADDING.top + h - ((c[4] - minP) / range) * h;
      return `${x},${y}`;
    });
    const pathD = points.length ? `M ${points.join(' L ')}` : '';
    return { path: pathD, minPrice: minP, maxPrice: maxP };
  }, [candles, width, height]);

  if (error) {
    return (
      <View style={[styles.container, { width, height }]}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (loading || !candles.length) {
    return (
      <View style={[styles.container, { width, height }]}>
        <Text style={styles.muted}>{loading ? 'Loading chart…' : 'No chart data'}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { width }]}>
      <View style={styles.labels}>
        <Text style={styles.label}>{maxPrice.toFixed(4)}</Text>
        <Text style={[styles.label, styles.labelBottom]}>{minPrice.toFixed(4)}</Text>
      </View>
      <Svg width={width} height={height} style={styles.svg}>
        <Path
          d={path}
          fill="none"
          stroke="#2f95dc"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 8,
    minHeight: CHART_HEIGHT,
  },
  svg: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  labels: {
    position: 'absolute',
    left: 0,
    top: PADDING.top,
    bottom: PADDING.bottom,
    width: PADDING.left - 4,
    justifyContent: 'space-between',
  },
  label: {
    fontSize: 10,
    opacity: 0.8,
  },
  labelBottom: {
    marginTop: 'auto',
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
