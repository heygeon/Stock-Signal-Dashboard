# Northline

Daily signals for US and Hong Kong stocks. Northline plots two strategies on the same symbol: a 20/50 EMA crossover, and a volume-confirmed liquidity sweep. It draws entries, exits, stops, and targets on a candlestick chart. It does not place orders or simulate a brokerage fill.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3847](http://localhost:3847). The desk loads Apple (`AAPL`) with about two years of daily bars and the 20/50 EMA signals already drawn. `0700.HK` (Tencent) is the other built-in demo.

Use **20/50 EMA** or **Volume sweep** on the chart or in the left panel. Switching recomputes the signals, the blotter, and the chart for the current symbol. The sliders under the switcher belong to the strategy that is selected. Reset restores that strategy’s defaults.

## 20/50 EMA

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

## Volume sweep

Long and short, daily bars, same rules for US and Hong Kong names. The signal price is that session’s close. A wick through the stop or target leaves the trade open; the exit is the close. Defaults:

| Control | Default | Slider |
| --- | --- | --- |
| Swing lookback | 10 | 2–60 |
| Volume average | 20 | 2–120 |
| Volume × average | 1.5 | 1.0–5.0 |
| Target × risk | 2 | 0.5–10 |
| Stop offset | 0.01 | 0–1.00 |

- **Swing low / high.** The lowest low, or highest high, of the prior N completed bars. The current bar is excluded. This is a lookback extreme, not a pivot that needs bars on both sides.
- **Average volume.** The simple average of the prior M bars’ volume. The current bar is excluded, so a spike is not diluted by itself. A window whose average is 0 does not confirm.
- **Buy** when, on the same bar, the low is strictly below that swing low, the close is strictly back above it, and volume is at least the multiple times the average.
- **Sell** is the mirror: the high is strictly above the swing high, the close is strictly back below it, and volume confirms. A touch of the extreme is not a sweep. A close that only equals the swept level is not a reclaim.
- If one bar sweeps and reclaims both the prior low and the prior high, Northline skips it. The book takes one direction.
- **Stop.** `stop offset` is a fixed price distance past the sweep wick, not an exchange tick lookup. The default `0.01` is one cent on the US and Hong Kong demos. Long stop = signal low − offset. Short stop = signal high + offset. An offset of 0 sits the stop on the wick.
- **Target.** Risk is the distance from the entry close to that stop. The target is `Target × risk` beyond the entry, in the trade’s direction.
- While a trade is open, later sweeps are ignored. An opposite sweep does not flip the position. The only exits are the stop and the take-profit, judged on the close. The stop is checked first.
- After a stop or take-profit, that same bar cannot open the next trade. The book waits for a later bar that qualifies on its own.

The chart marks **Buy** and **Sell**, and a short exit as **Cover**. The dotted line is the swept level. The stop and target are the open trade, or the trade you select in the blotter, or the most recent trade when the book is flat. A long wins when the exit close is above the entry. A short wins when the exit close is below the entry.

If a history has no positive volume, the sweep strategy stops and says so. It does not invent volume and it does not drop the filter. A session that printed zero volume can still sit inside the swing window; it cannot confirm a setup while the baseline is positive.

## Data

`/api/quotes?symbol=AAPL` proxies Yahoo Finance daily OHLCV so the browser is not blocked by CORS. `data/AAPL.json` and `data/0700.HK.json` are cached histories and include volume. If the live request fails, the desk keeps using that cache.

Refresh the cache (needs network):

```bash
npm run cache
```

The refresh refuses to write a file whose bars have no positive volume.

## Tests

```bash
npm test
```
