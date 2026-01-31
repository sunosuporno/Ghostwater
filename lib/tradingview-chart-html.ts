/**
 * Inline HTML for TradingView Lightweight Charts in a WebView.
 * Loads the library from CDN and exposes updateChart(candles) for our OHLCV data.
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
    function initChart() {
      var container = document.getElementById('chart');
      if (!container || typeof LightweightCharts === 'undefined') {
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: 'Chart init failed' }));
        return;
      }
      var chart = LightweightCharts.createChart(container, {
        width: ${width},
        height: ${height},
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: '#9ca3af',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: 'rgba(128,128,128,0.15)' },
          horzLines: { color: 'rgba(128,128,128,0.15)' },
        },
        crosshair: { mode: 1 },
        rightPriceScale: {
          borderColor: 'rgba(128,128,128,0.2)',
          scaleMargins: { top: 0.1, bottom: 0.2 },
        },
        timeScale: {
          borderColor: 'rgba(128,128,128,0.2)',
          timeVisible: true,
          secondsVisible: false,
        },
      });
      var series = chart.addCandlestickSeries({
        upColor: '#22c55e',
        downColor: '#ef4444',
        borderDownColor: '#ef4444',
        borderUpColor: '#22c55e',
        wickDownColor: '#ef4444',
        wickUpColor: '#22c55e',
      });
      window.updateChart = function(candles) {
        if (!candles || !candles.length) return;
        try {
          series.setData(candles);
          chart.timeScale().fitContent();
        } catch (e) {
          if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: String(e && e.message) }));
        }
      };
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
  <\/script>
</body>
</html>
`;
}
