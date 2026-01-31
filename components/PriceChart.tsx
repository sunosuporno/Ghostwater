import React, { useMemo, useRef } from 'react';
import { View, StyleSheet, Dimensions, PanResponder, Pressable } from 'react-native';
import Svg, { ClipPath, Defs, G, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { Text } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { ohlcvTimestampToMs, type OhlcvInterval } from '@/lib/deepbook-indexer';

/** OHLCV candle: [timestamp, open, high, low, close, volume] */
type OhlcvCandle = [number, number, number, number, number, number];

const CHART_HEIGHT = 200;
const PADDING = { top: 16, right: 12, bottom: 28, left: 52 };
/** Extra right margin so the last x-axis label (e.g. "12:56 AM") is not clipped. */
const RIGHT_LABEL_MARGIN = 44;
const Y_TICKS = 5;
const X_TICKS = 4;
interface PriceChartProps {
  candles: OhlcvCandle[];
  interval?: OhlcvInterval;
  width?: number;
  height?: number;
  loading?: boolean;
  loadingOlder?: boolean;
  error?: string | null;
  candleLimit?: number;
  /** When true, show "Latest" button to jump back to present. */
  canGoToLatest?: boolean;
  onGoToLatest?: () => void;
  /** Total candles (all loaded). When > candleLimit, show bottom scrollbar. */
  totalCandles?: number;
  /** Current window start index (for scrollbar thumb position). */
  windowStart?: number;
  /** Called when user drags the scrollbar to a new position. */
  onScrollbarChange?: (start: number) => void;
  /** Called when user scrolls to the left end (oldest data). Use to fetch more older data. */
  onReachedStart?: () => void;
}

function formatPriceAxis(value: number): string {
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (value >= 1) return value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  if (value >= 0.01) return value.toFixed(2);
  return value.toFixed(4);
}

/** Format X-axis label: use date for 4h/1d/1w so labels don’t repeat across days. */
function formatTimeAxis(
  timestamp: number,
  interval: OhlcvInterval,
  options?: { showDate?: boolean }
): string {
  const ms = ohlcvTimestampToMs(timestamp);
  const d = new Date(ms);
  const hour12 = false;
  if (options?.showDate ?? ['4h', '1d', '1w'].includes(interval)) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12 });
}

export function PriceChart({
  candles,
  interval = '1h',
  width = Dimensions.get('window').width - 48,
  height = CHART_HEIGHT,
  loading,
  loadingOlder,
  error,
  candleLimit = 168,
  canGoToLatest = false,
  onGoToLatest,
  totalCandles = 0,
  windowStart: windowStartProp = 0,
  onScrollbarChange,
  onReachedStart,
}: PriceChartProps) {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];
  const gridColor = colorScheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const lineColor = colors.tint;

  const useScrollbar = totalCandles > candleLimit && typeof onScrollbarChange === 'function';
  const trackLayoutRef = useRef<{ x: number; width: number } | null>(null);
  const scrollbarTrackRef = useRef<View>(null);
  const scrollbarPanResponder = useMemo(
    () =>
      !useScrollbar || !onScrollbarChange
        ? null
        : PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderMove: (_, g) => {
              const layout = trackLayoutRef.current;
              if (!layout || layout.width <= 0) return;
              const relativeX = g.moveX - layout.x;
              const ratio = Math.max(0, Math.min(1, relativeX / layout.width));
              const maxStart = Math.max(0, totalCandles - candleLimit);
              const newStart = Math.round(ratio * maxStart);
              const clampedStart = Math.max(0, Math.min(maxStart, newStart));
              onScrollbarChange(clampedStart);
              if (clampedStart === 0 && onReachedStart) onReachedStart();
            },
            onPanResponderRelease: (_, g) => {
              const layout = trackLayoutRef.current;
              if (!layout || layout.width <= 0) return;
              const relativeX = g.moveX - layout.x;
              const ratio = Math.max(0, Math.min(1, relativeX / layout.width));
              const maxStart = Math.max(0, totalCandles - candleLimit);
              const newStart = Math.round(ratio * maxStart);
              const clampedStart = Math.max(0, Math.min(maxStart, newStart));
              onScrollbarChange(clampedStart);
              if (clampedStart === 0 && onReachedStart) onReachedStart();
            },
          }),
    [useScrollbar, onScrollbarChange, onReachedStart, totalCandles, candleLimit]
  );

  const contentWidth = width - RIGHT_LABEL_MARGIN;
  const scrollbarTrackWidth = contentWidth - PADDING.left - PADDING.right;
  const maxScroll = Math.max(0, totalCandles - candleLimit);
  const scrollbarThumbWidth =
    maxScroll > 0 ? Math.max(24, (candleLimit / totalCandles) * scrollbarTrackWidth) : scrollbarTrackWidth;
  const scrollbarThumbLeft =
    maxScroll > 0 ? (windowStartProp / maxScroll) * (scrollbarTrackWidth - scrollbarThumbWidth) : 0;
  const chart = useMemo(() => {
    if (!candles.length) return null;
    const sorted = [...candles].sort((a, b) => ohlcvTimestampToMs(a[0]) - ohlcvTimestampToMs(b[0]));
    const lows = sorted.map((c) => c[3]);
    const highs = sorted.map((c) => c[2]);
    const minP = Math.min(...lows);
    const maxP = Math.max(...highs);
    const range = maxP - minP || 1;
    const pad = range * 0.02;
    const scaleMin = minP - pad;
    const scaleMax = maxP + pad;
    const scaleRange = scaleMax - scaleMin;

    const w = contentWidth - PADDING.left - PADDING.right;
    const h = height - PADDING.top - PADDING.bottom;
    const chartW = w;

    const points = sorted.map((c, i) => {
      const x = PADDING.left + (i / (sorted.length - 1 || 1)) * w;
      const y = PADDING.top + h - ((c[4] - scaleMin) / scaleRange) * h;
      return { x, y };
    });
    const lineD = points.length ? `M ${points.map((p) => `${p.x},${p.y}`).join(' L ')}` : '';
    const bottom = height - PADDING.bottom;
    const areaD =
      points.length > 0
        ? `${lineD} L ${points[points.length - 1].x},${bottom} L ${points[0].x},${bottom} Z`
        : '';

    const yTickValues: number[] = [];
    for (let i = 0; i <= Y_TICKS; i++) {
      yTickValues.push(scaleMin + (scaleRange * i) / Y_TICKS);
    }
    const yTicks = yTickValues.map((v) => ({
      value: v,
      y: PADDING.top + h - ((v - scaleMin) / scaleRange) * h,
      label: formatPriceAxis(v),
    }));

    const xTickIndices: number[] = [];
    for (let i = 0; i <= X_TICKS; i++) {
      xTickIndices.push(Math.round((i / X_TICKS) * (sorted.length - 1)));
    }
    const dayKey = (ts: number) => new Date(ohlcvTimestampToMs(ts)).toDateString();
    const firstDay = sorted.length ? dayKey(sorted[0][0]) : '';
    const lastDay = sorted.length ? dayKey(sorted[sorted.length - 1][0]) : '';
    const crossesMidnight = firstDay !== lastDay;
    const sortedIndices = [...new Set(xTickIndices)].sort((a, b) => a - b);
    const xTicks = sortedIndices
      .map((idx, arrIdx) => {
        const c = sorted[idx];
        if (!c) return null;
        const x = PADDING.left + (idx / (sorted.length - 1 || 1)) * w;
        const prevIdx = arrIdx > 0 ? sortedIndices[arrIdx - 1] : null;
        const showDate = crossesMidnight && (arrIdx === 0 || (prevIdx != null && dayKey(c[0]) !== dayKey(sorted[prevIdx][0])));
        return { x, ts: c[0], label: formatTimeAxis(c[0], interval, { showDate }), isDateOnly: showDate };
      })
      .filter(Boolean) as { x: number; ts: number; label: string; isDateOnly?: boolean }[];

    const gridLines = {
      horizontal: yTicks.map((t) => ({ y: t.y })),
      vertical: xTicks.map((t) => ({ x: t.x })),
    };

    return {
      path: lineD,
      areaPath: areaD,
      scaleMin,
      scaleMax,
      yTicks,
      xTicks,
      gridLines,
      chartW,
    };
  }, [candles, contentWidth, height, interval]);

  if (error) {
    return (
      <View style={[styles.container, { width, minHeight: height }]}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (!candles.length) {
    return (
      <View style={[styles.container, { width, minHeight: height }]}>
        <Text style={[styles.muted, { color: colors.text }]}>
          {loading ? 'Loading chart…' : 'No chart data'}
        </Text>
      </View>
    );
  }

  if (!chart) return null;

  const { path, areaPath, yTicks, xTicks, gridLines, chartW } = chart;
  const chartWidth = chartW;
  const chartHeight = height - PADDING.top - PADDING.bottom;
  const yTicksHighToLow = [...yTicks].reverse();

  return (
    <View style={[styles.wrapper, { width: contentWidth }]}>
      {loadingOlder ? (
        <View style={[styles.loadingOlderBar, { backgroundColor: colors.tabIconDefault }]}>
          <Text style={[styles.loadingOlderText, { color: colors.text }]}>Loading older…</Text>
        </View>
      ) : null}
      <View style={styles.yAxis}>
        {yTicksHighToLow.map((t, i) => (
          <Text key={i} style={[styles.yLabel, { color: colors.text }]} numberOfLines={1}>
            {t.label}
          </Text>
        ))}
      </View>
      {canGoToLatest && onGoToLatest ? (
        <Pressable
          onPress={onGoToLatest}
          style={[styles.latestButton, { backgroundColor: colors.tint }]}
        >
          <Text style={[styles.latestButtonText, { color: colors.background }]}>Latest</Text>
        </Pressable>
      ) : null}
      <View style={styles.chartRow}>
        <Svg width={contentWidth} height={height} style={styles.svg} viewBox={`0 0 ${contentWidth} ${height}`} preserveAspectRatio="xMidYMid meet">
          <Defs>
            <LinearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={lineColor} stopOpacity="0.25" />
              <Stop offset="1" stopColor={lineColor} stopOpacity="0" />
            </LinearGradient>
            <ClipPath id="chartClip">
              <Rect x={PADDING.left} y={PADDING.top} width={chartWidth} height={chartHeight} />
            </ClipPath>
          </Defs>
          {/* Plot area background */}
          <Rect
            x={PADDING.left}
            y={PADDING.top}
            width={chartWidth}
            height={chartHeight}
            fill={colorScheme === 'dark' ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)'}
          />
          {/* Grid */}
          {gridLines.horizontal.map((g, i) => (
            <Line
              key={`h-${i}`}
              x1={PADDING.left}
              y1={g.y}
              x2={contentWidth - PADDING.right}
              y2={g.y}
              stroke={gridColor}
              strokeWidth={1}
            />
          ))}
          {gridLines.vertical.map((g, i) => (
            <Line
              key={`v-${i}`}
              x1={g.x}
              y1={PADDING.top}
              x2={g.x}
              y2={height - PADDING.bottom}
              stroke={gridColor}
              strokeWidth={1}
            />
          ))}
          <G clipPath="url(#chartClip)">
            {areaPath ? <Path d={areaPath} fill="url(#chartGrad)" /> : null}
            <Path
              d={path}
              fill="none"
              stroke={lineColor}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </G>
        </Svg>
      </View>
      <View style={[styles.xAxis, { width: chartWidth, marginLeft: PADDING.left }]}>
        {xTicks.map((t, i) => (
          <Text
            key={i}
            style={[styles.xLabel, { color: colors.text }, t.isDateOnly && styles.xLabelBold]}
            numberOfLines={1}
          >
            {t.label}
          </Text>
        ))}
      </View>
      {useScrollbar && scrollbarPanResponder && (
        <View style={styles.scrollbarBox}>
          <View
            ref={scrollbarTrackRef}
            style={[
              styles.scrollbarTrack,
              {
                width: scrollbarTrackWidth,
                marginLeft: PADDING.left,
                backgroundColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
              },
            ]}
            onLayout={(e) => {
              scrollbarTrackRef.current?.measureInWindow((x, y, w) => {
                trackLayoutRef.current = { x, width: w };
              });
            }}
            {...scrollbarPanResponder.panHandlers}
          >
            <View
              style={[
                styles.scrollbarThumb,
                {
                  width: scrollbarThumbWidth,
                  left: scrollbarThumbLeft,
                  backgroundColor: colors.tint,
                },
              ]}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 8,
    justifyContent: 'center',
  },
  wrapper: {
    marginVertical: 4,
    minHeight: CHART_HEIGHT,
    overflow: 'hidden',
  },
  loadingOlderBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 24,
    zIndex: 2,
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.9,
  },
  loadingOlderText: {
    fontSize: 11,
    fontWeight: '500',
  },
  latestButton: {
    position: 'absolute',
    top: 8,
    right: 12,
    zIndex: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  latestButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  svg: {
    position: 'absolute',
    left: 0,
    top: 0,
    overflow: 'hidden',
  },
  chartRow: {
    height: CHART_HEIGHT,
    width: '100%',
    overflow: 'hidden',
  },
  yAxis: {
    position: 'absolute',
    left: 0,
    top: PADDING.top,
    width: PADDING.left - 8,
    height: CHART_HEIGHT - PADDING.top - PADDING.bottom,
    justifyContent: 'space-between',
    zIndex: 1,
  },
  yLabel: {
    fontSize: 11,
    fontWeight: '500',
    opacity: 0.85,
  },
  xAxis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingRight: 8,
    marginTop: -4,
    height: 22,
    alignItems: 'center',
  },
  xLabel: {
    fontSize: 10,
    fontWeight: '600',
    opacity: 0.85,
    maxWidth: 64,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  xLabelBold: {
    fontWeight: '700',
  },
  scrollbarBox: {
    marginTop: 12,
    marginBottom: 4,
    paddingVertical: 14,
    paddingHorizontal: 0,
    borderRadius: 12,
    alignSelf: 'stretch',
  },
  scrollbarTrack: {
    height: 10,
    justifyContent: 'center',
    borderRadius: 5,
    overflow: 'hidden',
  },
  scrollbarThumb: {
    position: 'absolute',
    height: 10,
    borderRadius: 5,
    top: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
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
