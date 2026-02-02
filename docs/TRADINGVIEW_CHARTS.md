# TradingView chart options (Lightweight vs full Charting Library)

## Why the TV logo was in our UI

We use **TradingView Lightweight Charts** (open source). The “TV” logo is the library’s attribution; it’s now turned off in our chart via `layout.attributionLogo: false`. You should still credit TradingView somewhere (e.g. “Charts by TradingView” in About or footer) to respect the Apache 2.0 license.

---

## Two categories of TradingView charts

### 1. Lightweight Charts (what we use)

- **What it is:** Small (~45 KB), open-source charting library. You pass in your own data (e.g. OHLCV from our indexer).
- **Pros:** Free, no account, full control, works in WebView with our data.
- **Cons:** No built-in “TradingView” UI. We add our own indicators (MA/EMA), volume, and drawing (e.g. horizontal lines). It will never look/behave exactly like tradingview.com or Groww.

So the “TV” logo was from this library; the “whole TradingView feel” does **not** come from Lightweight Charts.

---

### 2. TradingView Charting Library (Advanced Charts) – “Groww-style” feel

- **What it is:** The full TradingView experience: same UI as tradingview.com (drawing tools, indicators, timeframe bar, etc.). Apps like Groww typically embed this in a WebView/iframe so it feels like “TradingView opened inside the app.”
- **How it works:** You embed the Charting Library (script + config) in a WebView and implement a **datafeed** that answers the library’s requests (e.g. “give me OHLC for symbol X, resolution 1m, from … to …”) by returning your own data (e.g. from our DeepBook OHLCV API).
- **License:**
  - Free for **non-commercial** or **public** use (with their attribution).
  - **Commercial** use (e.g. paid app, behind paywall) needs a commercial license from TradingView.

**Steps to get the full TradingView feel (like Groww):**

1. **Get the library**

   - Go to [TradingView Charting Library](https://www.tradingview.com/charting-library-docs/) and sign up for access (e.g. “Free for non-commercial” or request a commercial license).

2. **Host the library**

   - They provide the library files (or a CDN). You load this in a WebView (e.g. from your app’s assets or a trusted URL).

3. **Implement a datafeed**

   - The library calls your JavaScript API to request bars (OHLCV). You translate those calls into requests to your backend (e.g. our OHLCV endpoint) and return data in the [UDF format](https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF) (or their standard format).

4. **Embed in the app**
   - Create a full-screen WebView (or iframe) that loads an HTML page which:
     - Includes the Charting Library script.
     - Calls the widget constructor with your config (symbol, theme, locale, etc.).
     - Connects your datafeed to the widget.
   - The result is the full TradingView UI (drawings, indicators, timeframe, etc.) driven by your data.

So: **Groww’s “iframe feel” is almost certainly the TradingView Charting Library embedded in a WebView with their own datafeed**, not Lightweight Charts.

---

## Summary

|                          | Lightweight Charts (current)           | Charting Library (Groww-style)               |
| ------------------------ | -------------------------------------- | -------------------------------------------- |
| **Feel**                 | Our UI + our chart                     | Full TradingView UI in WebView               |
| **Data**                 | We push OHLCV into the chart           | Library requests bars; we implement datafeed |
| **Indicators / drawing** | We add (MA, lines, etc.)               | Built-in (many indicators, full drawing)     |
| **License**              | Apache 2.0, free                       | Free (non-commercial) or paid commercial     |
| **TV logo**              | Can hide with `attributionLogo: false` | Typically part of their UI/branding          |

- **TV logo in our UI:** From Lightweight Charts; now disabled. Prefer keeping a short “Charts by TradingView” attribution elsewhere.
- **Full TradingView feel like Groww:** Use the **TradingView Charting Library** in a WebView with a custom datafeed; that’s the “other category” of TradingView charts that gives the iframe-like, full-product experience.
