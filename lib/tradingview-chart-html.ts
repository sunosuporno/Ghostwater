/**
 * Inline HTML for TradingView Lightweight Charts in a WebView.
 * Supports: candlestick/line, volume, MA/EMA indicators, price lines, trend lines.
 * @see https://tradingview.github.io/lightweight-charts/
 */

export function getTradingViewChartHtml(w: number, h: number): string {
  const width = w;
  const height = h;
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: transparent; }
    #chart { width: ${width}px; height: ${height}px; }
  </style>
</head>
<body>
  <div id="chart"></div>
  <script>
    (function() {
      var chart, candlestickSeries, lineSeries, volumeSeries;
      var indicatorSeries = {};
      var priceLines = {};
      var trendLineSeries = {};
      var currentCandles = [];
      var chartType = 'candle';
      var showVolume = true;
      var indicators = [];

      function ma(data, period) {
        var out = [];
        for (var i = 0; i < data.length; i++) {
          if (i < period - 1) {
            out.push({ time: data[i].time });
          } else {
            var sum = 0;
            for (var j = 0; j < period; j++) sum += data[i - j].close;
            out.push({ time: data[i].time, value: sum / period });
          }
        }
        return out;
      }
      function ema(data, period) {
        var k = 2 / (period + 1);
        var out = [];
        for (var i = 0; i < data.length; i++) {
          if (i < period - 1) {
            out.push({ time: data[i].time });
          } else if (i === period - 1) {
            var sum = 0;
            for (var j = 0; j < period; j++) sum += data[i - j].close;
            var v = sum / period;
            out.push({ time: data[i].time, value: v });
          } else {
            var v = data[i].close * k + out[out.length - 1].value * (1 - k);
            out.push({ time: data[i].time, value: v });
          }
        }
        return out;
      }

      var INDICATOR_COLORS = ['#818cf8', '#22c55e', '#f59e0b', '#06b6d4'];
      function applyIndicators(candles) {
        if (!candles || !candles.length || !chart) return;
        var data = candles.map(function(c) { return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; });
        indicators.forEach(function(ind, idx) {
          var key = ind.type + (ind.period || '');
          if (indicatorSeries[key]) {
            try { chart.removeSeries(indicatorSeries[key]); } catch (e) {}
            indicatorSeries[key] = null;
          }
          var color = INDICATOR_COLORS[idx % INDICATOR_COLORS.length];
          if (ind.type === 'MA' && ind.period) {
            var maData = ma(data, ind.period);
            var s = chart.addLineSeries({ color: color, lineWidth: 2 });
            s.setData(maData);
            indicatorSeries[key] = s;
          } else if (ind.type === 'EMA' && ind.period) {
            var emaData = ema(data, ind.period);
            var s = chart.addLineSeries({ color: color, lineWidth: 2 });
            s.setData(emaData);
            indicatorSeries[key] = s;
          }
        });
      }

      function initChart() {
        var container = document.getElementById('chart');
        if (!container || typeof LightweightCharts === 'undefined') {
          if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: 'Chart init failed' }));
          return;
        }
        chart = LightweightCharts.createChart(container, {
          width: ${width},
          height: ${height},
          layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: '#9ca3af',
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 11,
            attributionLogo: false,
          },
          grid: {
            vertLines: { color: 'rgba(128,128,128,0.15)' },
            horzLines: { color: 'rgba(128,128,128,0.15)' },
          },
          crosshair: { mode: 1 },
          rightPriceScale: {
            borderColor: 'rgba(128,128,128,0.2)',
            scaleMargins: { top: 0.1, bottom: showVolume ? 0.25 : 0.1 },
          },
          timeScale: {
            borderColor: 'rgba(128,128,128,0.2)',
            timeVisible: true,
            secondsVisible: false,
          },
        });

        candlestickSeries = chart.addCandlestickSeries({
          upColor: '#22c55e',
          downColor: '#ef4444',
          borderDownColor: '#ef4444',
          borderUpColor: '#22c55e',
          wickDownColor: '#ef4444',
          wickUpColor: '#22c55e',
        });
        candlestickSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: showVolume ? 0.25 : 0.1 } });

        lineSeries = chart.addLineSeries({
          color: '#3b82f6',
          lineWidth: 2,
          visible: false,
        });
        lineSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: showVolume ? 0.25 : 0.1 } });

        if (showVolume) {
          volumeSeries = chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: '',
          });
          volumeSeries.priceScale().applyOptions({
            scaleMargins: { top: 0.75, bottom: 0 },
          });
        }

        var olderDataRequestThrottle = 0;
        function maybeRequestOlderData() {
          if (!chart || !currentCandles.length || !window.ReactNativeWebView) return;
          var range = chart.timeScale().getVisibleLogicalRange();
          if (!range || range.from == null) return;
          if (range.from > 5) return;
          var now = Date.now();
          if (now - olderDataRequestThrottle < 2000) return;
          olderDataRequestThrottle = now;
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'requestOlderData' }));
        }

        var hasFitContentOnce = false;
        window.updateChart = function(candles) {
          if (!candles || !candles.length) return;
          var isFirstLoad = currentCandles.length === 0;
          currentCandles = candles;
          try {
            candlestickSeries.setData(candles);
            var closeData = candles.map(function(c) { return { time: c.time, value: c.close }; });
            lineSeries.setData(closeData);
            if (showVolume && volumeSeries) {
              var volData = candles.map(function(c) {
                var v = typeof c.volume === 'number' ? c.volume : 0;
                return {
                  time: c.time,
                  value: v,
                  color: c.close >= (c.open != null ? c.open : c.close) ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)',
                };
              });
              volumeSeries.setData(volData);
            }
            if (isFirstLoad && !hasFitContentOnce) {
              chart.timeScale().fitContent();
              hasFitContentOnce = true;
            }
            applyIndicators(candles);
          } catch (e) {
            if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: String(e && e.message) }));
          }
        };

        function subscribeVisibleRange() {
          if (!chart || typeof chart.timeScale !== 'function') return;
          try {
            chart.timeScale().subscribeVisibleLogicalRangeChange(function(range) {
              maybeRequestOlderData();
            });
          } catch (e) {}
        }

        window.setChartType = function(type) {
          chartType = type === 'line' ? 'line' : 'candle';
          if (candlestickSeries) candlestickSeries.applyOptions({ visible: chartType === 'candle' });
          if (lineSeries) lineSeries.applyOptions({ visible: chartType === 'line' });
        };

        window.setIndicators = function(arr) {
          indicators = arr || [];
          Object.keys(indicatorSeries).forEach(function(k) {
            try { if (indicatorSeries[k]) chart.removeSeries(indicatorSeries[k]); } catch (e) {}
          });
          indicatorSeries = {};
          if (currentCandles.length) applyIndicators(currentCandles);
        };

        window.setShowVolume = function(show) {
          showVolume = !!show;
          if (volumeSeries) {
            try { volumeSeries.applyOptions({ visible: showVolume }); } catch (e) {}
          }
          if (currentCandles.length && volumeSeries && showVolume) {
            var volData = currentCandles.map(function(c) {
              var v = typeof c.volume === 'number' ? c.volume : 0;
              return {
                time: c.time,
                value: v,
                color: c.close >= (c.open != null ? c.open : c.close) ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)',
              };
            });
            volumeSeries.setData(volData);
          }
        };

        window.addPriceLine = function(opts) {
          if (!candlestickSeries || !opts || opts.id == null) return;
          var line = candlestickSeries.createPriceLine({
            price: opts.price,
            color: opts.color || '#94a3b8',
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
          });
          priceLines[opts.id] = line;
        };

        window.removePriceLine = function(id) {
          if (priceLines[id]) {
            candlestickSeries.removePriceLine(priceLines[id]);
            delete priceLines[id];
          }
        };

        window.addTrendLine = function(opts) {
          if (!chart || !opts || opts.id == null || opts.t1 == null || opts.p1 == null || opts.t2 == null || opts.p2 == null) return;
          var s = chart.addLineSeries({ color: opts.color || '#94a3b8', lineWidth: 2 });
          s.setData([{ time: opts.t1, value: opts.p1 }, { time: opts.t2, value: opts.p2 }]);
          trendLineSeries[opts.id] = s;
        };

        window.removeTrendLine = function(id) {
          if (trendLineSeries[id]) {
            try { chart.removeSeries(trendLineSeries[id]); } catch (e) {}
            delete trendLineSeries[id];
          }
        };

        if (window.__chartCandles && window.__chartCandles.length) {
          window.updateChart(window.__chartCandles);
          window.__chartCandles = null;
        }
        subscribeVisibleRange();
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chartReady' }));
        }
      }

      var s = document.createElement('script');
      s.src = 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js';
      s.onload = function() { initChart(); };
      s.onerror = function() {
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: 'Failed to load chart library' }));
      };
      document.head.appendChild(s);
    })();
  <\/script>
</body>
</html>
`;
}
