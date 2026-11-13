import { sanitizeBars } from "./strategy"
import type {
  Bar,
  EnrichedBar,
  ExitReason,
  SignalMarker,
  SignalResult,
  SweepParams,
  Trade,
  TradeDirection,
} from "./types"

/**
 * Volume-confirmed liquidity sweep and reclaim.
 *
 * Daily bars, long and short, same rules for US and Hong Kong names.
 * Definitions below are the ones the desk and the tests share.
 *
 * Swing. The N-day swing low is the lowest low of the prior N completed
 * bars, excluding the current bar. The swing high is the highest high of
 * that same window. This is a lookback extreme, not a multi-bar pivot.
 * Default N is 10.
 *
 * Volume. The average is the simple mean of the prior M bars' volume,
 * excluding the current bar, so the signal bar cannot dilute its own spike.
 * A bar confirms when its volume is at least `volumeMultiple` times that
 * average (default 1.5, M = 20). The comparison allows 1e-9 of absolute
 * slack so binary float dust does not reject an exact multiple. A window
 * whose average is 0 does not confirm: there is no baseline to beat.
 * Zero-volume sessions stay in the lookback and in the average; they are
 * real prints. They cannot be the signal bar when the baseline is positive.
 *
 * Entry. The signal bar's close, same as the EMA strategy.
 *
 * Long, all on the same bar: low strictly below the swing low, close
 * strictly back above that swing low, and volume confirmed.
 * Short is the mirror: high strictly above the swing high, close strictly
 * back below it, and volume confirmed. A tie with the extreme is not a
 * sweep. A close that only kisses the swept level is not a reclaim.
 *
 * Both sides. If one bar sweeps and reclaims both the prior low and the
 * prior high, it is not a trade. The book needs one direction.
 *
 * Stop. One configurable price increment beyond the sweep wick. Default
 * 0.01, which is one cent on the US and Hong Kong demos. Northline does
 * not look up the exchange tick schedule. Long stop = signal low − offset.
 * Short stop = signal high + offset. Offset 0 sits the stop on the wick.
 *
 * Risk and target. Risk is the distance from the entry close to that stop.
 * The take-profit is `takeProfitMultiple` times that risk (default 2),
 * beyond the entry in the trade's direction. A setup with risk ≤ 0 is
 * skipped. With a valid OHLC bar and a strict reclaim, risk is positive
 * even when the offset is 0.
 *
 * Exits. Judged on the close, same as the EMA strategy. A wick through the
 * stop or target leaves the trade open. Long stop: close ≤ stop. Long
 * target: close ≥ target. Short stop: close ≥ stop. Short target:
 * close ≤ target. The stop is tested first.
 *
 * While a trade is open, further sweeps are ignored in both directions.
 * An opposite sweep does not flip the position. The only exits are the
 * stop and the take-profit. After either exit the book stays flat through
 * the rest of that bar. The next entry is a later bar that qualifies on
 * its own. The signal bar itself is not checked for an exit; with positive
 * risk its close sits strictly between the stop and the target.
 *
 * Missing volume. If the history has no positive volume, the strategy
 * refuses to run. It does not invent volume and it does not drop the filter.
 */
export const DEFAULT_SWEEP_PARAMS: SweepParams = {
  swingLookback: 10,
  volumePeriod: 20,
  volumeMultiple: 1.5,
  takeProfitMultiple: 2,
  stopOffset: 0.01,
}

export const NO_VOLUME_MESSAGE =
  "This symbol has no volume. The sweep strategy needs real volume to confirm a setup and will not guess or skip that filter."

const VOLUME_EPSILON = 1e-9

export function sweepParamsError(params: SweepParams): string | null {
  if (!Number.isInteger(params.swingLookback) || params.swingLookback < 2) {
    return "Swing lookback must be a whole number of at least 2."
  }
  if (!Number.isInteger(params.volumePeriod) || params.volumePeriod < 2) {
    return "Volume average period must be a whole number of at least 2."
  }
  if (!Number.isFinite(params.volumeMultiple) || params.volumeMultiple <= 0) {
    return "Volume multiple must be greater than 0."
  }
  if (!Number.isFinite(params.takeProfitMultiple) || params.takeProfitMultiple <= 0) {
    return "Take-profit multiple must be greater than 0."
  }
  if (!Number.isFinite(params.stopOffset) || params.stopOffset < 0) {
    return "Stop offset must be zero or greater."
  }
  return null
}

export function hasUsableVolume(bars: Array<Pick<Bar, "volume">>): boolean {
  return bars.some((bar) => Number.isFinite(bar.volume) && bar.volume > 0)
}

/** Lowest low of the prior `lookback` bars. The bar at `index` is excluded. */
export function priorSwingLow(bars: Array<Pick<Bar, "low">>, index: number, lookback: number): number | null {
  if (!Number.isInteger(lookback) || lookback < 1 || index < lookback) return null
  let extreme = bars[index - lookback].low
  for (let cursor = index - lookback + 1; cursor < index; cursor += 1) {
    if (bars[cursor].low < extreme) extreme = bars[cursor].low
  }
  return extreme
}

/** Highest high of the prior `lookback` bars. The bar at `index` is excluded. */
export function priorSwingHigh(bars: Array<Pick<Bar, "high">>, index: number, lookback: number): number | null {
  if (!Number.isInteger(lookback) || lookback < 1 || index < lookback) return null
  let extreme = bars[index - lookback].high
  for (let cursor = index - lookback + 1; cursor < index; cursor += 1) {
    if (bars[cursor].high > extreme) extreme = bars[cursor].high
  }
  return extreme
}

/** Simple average of the prior `period` volumes. The bar at `index` is excluded. */
export function priorAverageVolume(
  bars: Array<Pick<Bar, "volume">>,
  index: number,
  period: number,
): number | null {
  if (!Number.isInteger(period) || period < 1 || index < period) return null
  let sum = 0
  for (let cursor = index - period; cursor < index; cursor += 1) sum += bars[cursor].volume
  return sum / period
}

type Setup = {
  direction: TradeDirection
  sweptLevel: number
  stop: number
  target: number
}

function setupAt(bars: Bar[], index: number, params: SweepParams): Setup | null {
  const swingLow = priorSwingLow(bars, index, params.swingLookback)
  const swingHigh = priorSwingHigh(bars, index, params.swingLookback)
  const averageVolume = priorAverageVolume(bars, index, params.volumePeriod)
  if (swingLow == null || swingHigh == null || averageVolume == null || !(averageVolume > 0)) return null

  const bar = bars[index]
  if (!(bar.volume >= params.volumeMultiple * averageVolume - VOLUME_EPSILON)) return null

  const longSweep = bar.low < swingLow && bar.close > swingLow
  const shortSweep = bar.high > swingHigh && bar.close < swingHigh
  // Neither side, or both sides on one bar: stay flat.
  if (longSweep === shortSweep) return null

  const direction: TradeDirection = longSweep ? "long" : "short"
  const sweptLevel = longSweep ? swingLow : swingHigh
  const stop = longSweep ? bar.low - params.stopOffset : bar.high + params.stopOffset
  const risk = longSweep ? bar.close - stop : stop - bar.close
  if (!(risk > 0) || !Number.isFinite(stop)) return null

  const target = longSweep
    ? bar.close + params.takeProfitMultiple * risk
    : bar.close - params.takeProfitMultiple * risk
  return { direction, sweptLevel, stop, target }
}

function closeThroughExit(trade: Trade, close: number): ExitReason | null {
  if (trade.direction === "short") {
    if (close >= trade.stop) return "stop"
    if (close <= trade.target) return "take_profit"
    return null
  }
  if (close <= trade.stop) return "stop"
  if (close >= trade.target) return "take_profit"
  return null
}

/**
 * Flat-until-the-next-sweep state machine. An open trade ignores new
 * sweeps. A stop or take-profit closes it, and that same bar cannot open
 * the next trade.
 */
export function decideSweepTrades(bars: Bar[], params: SweepParams): Trade[] {
  const trades: Trade[] = []
  let open: Trade | null = null

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]

    if (open) {
      const reason = closeThroughExit(open, bar.close)
      if (reason) {
        open.exitIndex = index
        open.exitDate = bar.date
        open.exitPrice = bar.close
        open.exitReason = reason
        open = null
      }
      continue
    }

    const setup = setupAt(bars, index, params)
    if (!setup) continue

    const trade: Trade = {
      id: trades.length + 1,
      entryIndex: index,
      entryDate: bar.date,
      entryPrice: bar.close,
      // ATR belongs to the EMA strategy. Sweep risk is entry-to-stop.
      atrAtEntry: 0,
      stop: setup.stop,
      target: setup.target,
      exitIndex: null,
      exitDate: null,
      exitPrice: null,
      exitReason: null,
      direction: setup.direction,
      sweptLevel: setup.sweptLevel,
    }
    trades.push(trade)
    open = trade
  }

  return trades
}

function exitLabel(direction: TradeDirection, reason: ExitReason): string {
  if (direction === "short") return "Cover"
  if (reason === "stop") return "Stop"
  return "Take-profit"
}

function markersFor(trade: Trade): SignalMarker[] {
  const direction = trade.direction ?? "long"
  const entry: SignalMarker = {
    date: trade.entryDate,
    side: "entry",
    label: direction === "short" ? "Sell" : "Buy",
    reason: null,
    direction,
  }
  if (!trade.exitDate || !trade.exitReason) return [entry]
  return [
    entry,
    {
      date: trade.exitDate,
      side: "exit",
      label: exitLabel(direction, trade.exitReason),
      reason: trade.exitReason,
      direction,
    },
  ]
}

export function generateSweepSignals(bars: Bar[], params: SweepParams): SignalResult {
  const cleaned = sanitizeBars(bars)
  const enriched: EnrichedBar[] = cleaned.map((bar) => ({
    ...bar,
    emaFast: null,
    emaSlow: null,
    atr: null,
  }))

  const paramError = sweepParamsError(params)
  if (paramError) {
    return { bars: enriched, trades: [], markers: [], levelsTrade: null, error: paramError }
  }
  if (cleaned.length > 0 && !hasUsableVolume(cleaned)) {
    return { bars: enriched, trades: [], markers: [], levelsTrade: null, error: NO_VOLUME_MESSAGE }
  }

  const trades = decideSweepTrades(cleaned, params)
  return {
    bars: enriched,
    trades,
    markers: trades.flatMap(markersFor),
    levelsTrade: trades.length > 0 ? trades[trades.length - 1] : null,
    error: null,
  }
}
