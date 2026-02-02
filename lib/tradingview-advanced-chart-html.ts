/**
 * HTML + Datafeed for TradingView Advanced Charts (Charting Library).
 * Connects to our DeepBook indexer for OHLCV. No API key; you host the library yourself.
 * @see https://www.tradingview.com/charting-library-docs/latest/getting_started/
 * @see https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/
 */

const INDEXER_BASE = "https://deepbook-indexer.mainnet.mystenlabs.com";

/** Map TradingView resolution to our indexer interval. */
function resolutionToInterval(resolution: string): string {
  const map: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "30": "30m",
    "60": "1h",
    "120": "2h",
    "240": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  return map[resolution] || "1h";
}

/**
 * Generate HTML that loads the Charting Library and implements the datafeed.
 * @param symbol - Pool name (e.g. BWETH_USDC) for the chart.
 * @param libraryPath - URL to the folder containing charting_library files (e.g. https://your-host.com/charting_library/). You get this after requesting access from TradingView.
 * @param theme - 'light' | 'dark'
 * @param width - Chart width in px.
 * @param height - Chart height in px.
 */
export function getTradingViewAdvancedChartHtml(
  symbol: string,
  libraryPath: string,
  theme: "light" | "dark",
  width: number,
  height: number
): string {
  const libPathEsc = JSON.stringify(libraryPath);
  const symbolEsc = JSON.stringify(symbol);
  const indexerBaseEsc = JSON.stringify(INDEXER_BASE);
  const themeEsc = JSON.stringify(theme);
  const widthNum = Math.round(width);
  const heightNum = Math.round(height);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: ${
      theme === "dark" ? "#131722" : "#fff"
    }; }
    #tv-chart { width: ${widthNum}px; height: ${heightNum}px; }
  </style>
</head>
<body>
  <div id="tv-chart"></div>
  <script>
    (function() {
      var INDEXER_BASE = ${indexerBaseEsc};
      var SYMBOL = ${symbolEsc};
      var LIBRARY_PATH = ${libPathEsc};
      var THEME = ${themeEsc};

      function resolutionToInterval(res) {
        var map = { '1':'1m','5':'5m','15':'15m','30':'30m','60':'1h','120':'2h','240':'4h','1D':'1d','1W':'1w' };
        return map[res] || '1h';
      }

      var datafeed = {
        onReady: function(callback) {
          setTimeout(function() {
            callback({
              supports_search: false,
              supports_group_request: false,
              supported_resolutions: ['1','5','15','30','60','240','1D','1W'],
              supports_marks: false,
              supports_timescale_marks: false,
              supports_time: true,
              exchanges: [{ value: 'DeepBook', name: 'DeepBook', desc: '' }],
              symbols_types: [{ name: 'Crypto', value: 'crypto' }],
            });
          }, 0);
        },

        searchSymbols: function(userInput, exchange, symbolType, onResult) {
          setTimeout(function() {
            var s = (SYMBOL || '').toUpperCase();
            var u = (userInput || '').toUpperCase().replace(/\\\\s/g, '');
            if (!u || s.indexOf(u) >= 0 || s.replace('_','/').indexOf(u) >= 0) {
              onResult([{
                symbol: SYMBOL,
                full_name: SYMBOL,
                description: SYMBOL.replace('_', '/'),
                exchange: 'DeepBook',
                ticker: SYMBOL,
                type: 'crypto',
              }]);
            } else {
              onResult([]);
            }
          }, 0);
        },

        resolveSymbol: function(symbolName, onResolve, onError) {
          setTimeout(function() {
            var name = symbolName && (symbolName.ticker || symbolName.name || symbolName) || SYMBOL;
            var desc = (name || '').replace('_', '/');
            onResolve({
              ticker: name,
              name: name,
              description: desc,
              type: 'crypto',
              session: '24x7',
              timezone: 'Etc/UTC',
              exchange: 'DeepBook',
              minmov: 1,
              pricescale: 100000,
              has_intraday: true,
              has_weekly_and_monthly: false,
              supported_resolutions: ['1','5','15','30','60','240','1D','1W'],
              volume_precision: 2,
              data_status: 'streaming',
            });
          }, 0);
        },

        getBars: function(symbolInfo, resolution, periodParams, onResult, onError) {
          var from = periodParams.from;
          var to = periodParams.to;
          var countBack = periodParams.countBack || 300;
          var interval = resolutionToInterval(resolution);
          var url = INDEXER_BASE + '/ohclv/' + encodeURIComponent(symbolInfo.ticker || SYMBOL)
            + '?interval=' + encodeURIComponent(interval)
            + '&limit=' + Math.min(500, Math.max(countBack, 100))
            + '&end_time=' + to;
          fetch(url)
            .then(function(r) { return r.json(); })
            .then(function(data) {
              var raw = data.candles || [];
              var bars = [];
              for (var i = 0; i < raw.length; i++) {
                var c = raw[i];
                var t = c[0];
                if (t > 1e12) t = t; else t = t * 1000;
                bars.push({
                  time: t,
                  open: c[1],
                  high: c[2],
                  low: c[3],
                  close: c[4],
                  volume: c[5] || 0,
                });
              }
              bars.sort(function(a, b) { return a.time - b.time; });
              var noData = bars.length === 0;
              setTimeout(function() { onResult(bars, { noData: noData }); }, 0);
            })
            .catch(function(err) {
              setTimeout(function() { onError(err && err.message ? err.message : 'Failed to load'); }, 0);
            });
        },

        subscribeBars: function(symbolInfo, resolution, onTick, listenerGuid) {
          window.__tvSubs = window.__tvSubs || {};
          window.__tvSubs[listenerGuid] = { onTick: onTick, symbolInfo: symbolInfo, resolution: resolution };
        },

        unsubscribeBars: function(listenerGuid) {
          if (window.__tvSubs) delete window.__tvSubs[listenerGuid];
        },
      };

      function initWidget() {
        if (typeof TradingView === 'undefined') {
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: 'Charting Library not loaded. Set library path.' }));
          }
          return;
        }
        var widget = new TradingView.widget({
          container: document.getElementById('tv-chart'),
          library_path: LIBRARY_PATH,
          locale: 'en',
          symbol: SYMBOL,
          interval: '15',
          datafeed: datafeed,
          theme: THEME,
          autosize: false,
          width: ${widthNum},
          height: ${heightNum},
          fullscreen: false,
          studies_overrides: {},
          overrides: {},
          disabled_features: ['use_localstorage_for_settings'],
          enabled_features: [],
        });
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chartReady' }));
        }
      }

      if (!LIBRARY_PATH || LIBRARY_PATH === '') {
        document.getElementById('tv-chart').innerHTML = '<div style="padding:24px;color:#9ca3af;text-align:center;">TradingView Charting Library required. Request access at tradingview.com, host the library, and set the library path in the app.</div>';
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chartReady' }));
        }
        return;
      }

      var script = document.createElement('script');
      script.src = LIBRARY_PATH.replace(/\\\\/$/, '') + '/charting_library.standalone.js';
      script.async = false;
      script.onload = initWidget;
      script.onerror = function() {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: 'Failed to load Charting Library from ' + LIBRARY_PATH }));
        }
      };
      document.head.appendChild(script);
    })();
  <\\/script>
</body>
</html>
`;
}
