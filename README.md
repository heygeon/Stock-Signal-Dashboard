# Northline

Daily signals for US and Hong Kong stocks. Northline plots four strategies on the same symbol: a 20/50 EMA crossover, a volume-confirmed liquidity sweep, a 20-day Donchian breakout, and an RSI(14) extreme reclaim. It draws entries, exits, stops, and targets on a candlestick chart. It does not place orders or simulate a brokerage fill.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3847](http://localhost:3847). The desk loads Apple (`AAPL`) with about two years of daily bars and the 20/50 EMA signals already drawn. `0700.HK` (Tencent) is the other built-in demo.

Use **20/50 EMA**, **Volume sweep**, **Donchian**, or **RSI reclaim** on the chart or in the left panel. Switching recomputes the signals, the blotter, and the chart for the current symbol. The sliders under the switcher belong to the strategy that is selected. Reset restores that strategy’s defaults. The 20/50 EMA and volume-sweep rules below are unchanged.

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

## Donchian breakout

Long and short, daily bars, same rules for US and Hong Kong names. The signal price is that session’s close. A wick through the channel does not enter, and a wick through the stop or target does not exit. Defaults:

| Control | Default | Slider |
| --- | --- | --- |
| Channel lookback | 20 | 2–120 |
| Volume average | 20 | 2–120 |
| Volume × average | 1.5 | 1.0–5.0 |
| ATR period | 14 | 2–50 |
| Stop × ATR | 2 | 0.5–6 |
| Target × ATR | 3 | 0.5–10 |

- **Channel.** The prior N-session high is the highest high of the previous N completed bars. The prior N-session low is the lowest low of that same window. The current bar is excluded, so a bar cannot break a level it just printed. This is a lookback extreme, not a pivot.
- **Breakout.** **Buy** when the close is strictly above that prior high. **Sell** when the close is strictly below that prior low. A close that only touches the prior high or low is not a breakout.
- **Volume.** The simple average of the prior M bars’ volume. The current bar is excluded. A bar confirms at or above the multiple. The comparison allows `1e-9` of absolute slack so an exact multiple is not rejected by binary dust, the same slack the sweep uses. An average of 0 does not confirm. Zero-volume sessions stay in the window.
- **ATR.** The same Wilder ATR as the 20/50 EMA strategy. True range is the greatest of high−low, |high − previous close|, and |low − previous close|. The first bar uses high−low. The seed is the simple average of the first 14 true ranges; after that, `ATR = (previous ATR × 13 + true range) / 14`. The trade uses the ATR on the entry bar, which includes that bar’s true range and no later bar. A bar with no ATR yet, or a non-positive ATR, is not an entry.
- **Stop and target.** Long stop = entry − stop × ATR. Long target = entry + target × ATR. Short stop and target are the mirror, measured from the entry close. Both stay fixed.
- Exits are the close. The stop is checked first, then the target. With a positive ATR they sit on opposite sides of the entry, so one close cannot hit both.
- While a trade is open, later breakouts are ignored, including an opposite breakout. There is no flip. After a stop or take-profit, that same bar cannot open the next trade. The book waits for a later bar that qualifies on its own.

The chart marks **Buy** and **Sell**, and a short exit as **Cover**. The two lines are the prior channel high and low. The stop and target are the open trade, or the trade you select in the blotter, or the most recent trade when the book is flat.

If a history has no positive volume, the Donchian strategy stops and says so. It does not invent volume and it does not drop the filter.

## RSI reclaim

Long and short, daily bars, same rules for US and Hong Kong names. Volume is not an input. The signal price is that session’s close. A wick through the stop or target does not exit. Defaults:

| Control | Default | Slider |
| --- | --- | --- |
| RSI period | 14 | 2–50 |
| Oversold | 30 | 1–98, and below overbought |
| Overbought | 70 | above oversold, up to 99 |
| Target × risk | 2 | 0.5–10 |
| Stop offset | 0.01 | 0–1.00 |

- **Wilder RSI.** For each bar after the first, the up-close is `max(close − previous close, 0)` and the down-close is `max(previous close − close, 0)`. The seed, on bar `period` (14 changes, so the 15th close), is the simple average of those first moves. After that, `average = (previous average × (period − 1) + this move) / period`. `RS = average gain / average loss`, and `RSI = 100 − 100 / (1 + RS)`. When the average loss is 0, RSI is 100, including a flat window where both averages are 0. There is no RSI before that seed bar.
- **Buy** when RSI on the prior bar was at or below the oversold line and this bar’s RSI closes strictly back above it. A reading that only touches the line is not a reclaim. Staying oversold, or crossing down through the line, is not a buy.
- **Sell** is the mirror: prior RSI at or above the overbought line, and this bar’s RSI closes strictly back below it. Touching the line is not a short. Crossing up through it is not a short.
- **Both sides.** If one bar would qualify as a long and a short, Northline skips it and stays flat. One RSI series cannot do both while oversold sits below overbought; the skip is still applied so a bar flagged both ways never opens a trade.
- **Stop.** The same fixed price offset as the sweep, past the signal wick. Default `0.01`. Long stop = signal low − offset. Short stop = signal high + offset. An offset of 0 sits the stop on the wick. Northline does not look up the exchange tick.
- **Target.** Risk is the distance from the entry close to that stop. The target is `Target × risk` beyond the entry, in the trade’s direction. Risk of 0 or less is skipped.
- Exits are the close. The stop is checked first. While a trade is open, later reclaims are ignored, including an opposite signal. There is no flip. After a stop or take-profit, that same bar cannot open the next trade.

The chart marks **Buy** and **Sell**, and a short exit as **Cover**. The stop and target are the open trade, the trade you select, or the most recent trade when the book is flat. A long wins when the exit close is above the entry. A short wins when the exit close is below the entry.

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
