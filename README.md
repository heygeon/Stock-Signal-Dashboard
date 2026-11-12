# Northline

Daily EMA crossover signals for US and Hong Kong stocks. Northline plots entries, exits, and fixed ATR stops and targets on a candlestick chart. It does not place orders or simulate a brokerage fill.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3847](http://localhost:3847). The desk loads Apple (`AAPL`) with about two years of daily bars and the default signals already drawn. `0700.HK` (Tencent) is the other built-in demo.

## Strategy

The defaults match the controls on the left. Changing a period or multiplier redraws the chart immediately.

- Timeframe: daily bars. A signal uses that session’s close. A wick through the stop or target does not exit.
- Fast and slow EMAs (20 and 50). Each average is seeded with a simple moving average, then `EMA = previous EMA + (close − previous EMA) × 2 / (N + 1)`.
- ATR (14) uses Wilder’s smoothing. True range is the greatest of high−low, |high − previous close|, and |low − previous close|. The first bar uses high−low. The first ATR is the simple average of the first 14 true ranges; after that, `ATR = (previous ATR × 13 + true range) / 14`.
- **Buy** when the fast EMA closes above the slow EMA and the previous bar’s fast EMA was at or below the slow EMA.
- While long, exit on the first of:
  1. The fast EMA closes back below the slow EMA.
  2. The close is at or below `entry − stop × ATR`, using the ATR from the entry bar.
  3. The close is at or above `entry + target × ATR`, using that same entry ATR.
- Stop and target are fixed prices for that trade.
- If a cross down and a stop or target land on the same close, the cross wins. A stop wins over a target.
- After a stop or take-profit, stay flat until the next fresh crossover. The fast EMA remaining above the slow EMA is not an entry.

The horizontal stop and target belong to the open position, or to the most recent trade if the book is flat. Click a blotter row to inspect an earlier trade. Win rate counts a closed trade as a win when the exit close is above the entry close.

## Data

`/api/quotes?symbol=AAPL` proxies Yahoo Finance daily OHLCV so the browser is not blocked by CORS. `data/AAPL.json` and `data/0700.HK.json` are cached histories. If the live request fails, the desk keeps using that cache.

Refresh the cache (needs network):

```bash
npm run cache
```

## Tests

```bash
npm test
```
