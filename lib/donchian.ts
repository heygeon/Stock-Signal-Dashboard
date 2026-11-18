import { sanitizeBars, wilderAtr } from "./strategy"
import type {
  Bar,
  EnrichedBar,
  ExitReason,
  SignalMarker,
  SignalResult,
  DonchianParams,
  Trade,
  TradeDirection,
} from "./types"

/**
 * 20-day Donchian breakout with a volume filter.
 *
 * Daily bars, long and short, same rules for US and Hong Kong names.
 * Definitions below are the ones the desk and the tests share. They do
 * not change the 20/50 EMA book or the volume-sweep book.
 *
 * Channel. The prior N-session high is the highest high of the previous N
 * completed bars. The prior N-session low is the lowest low of that same
 * window. The current bar is excluded from both, so a bar cannot break a
 * level it just printed. Default N is 20. This is a lookback extreme, not
 * a pivot that needs bars on both sides.
 *
 * Breakout. A buy requires the close strictly above that prior high. A
 * sell/short requires the close strictly below that prior low. A close
 * that only touches the prior high or low is not a breakout. The signal
 * uses the close, not an intrabar pierce: a wick through the channel
 * without a close beyond it does not enter.
 *
 * Volume. The average is the simple mean of the prior M bars' volume,
 * excluding the current bar, so the signal bar cannot dilute its own spike.
 * Default M is 20. A bar confirms when its volume is at least
 * `volumeMultiple` times that average (default 1.5). The comparison allows
 * 1e-9 of absolute slack so binary float dust does not reject an exact
 * multiple — the same slack the sweep desk uses. A window whose average is
 * 0 does not confirm: there is no baseline to beat. Zero-volume sessions
 * stay in the lookback and in the average. They cannot be the signal bar
 * when the baseline is positive.
 *
 * Entry. The signal bar's close.
 *
 * ATR. Stop and target use the same Wilder ATR as the EMA strategy
 * (`wilderAtr`): true range is the greatest of high−low, |high−previous
 * close|, and |low−previous close|; the first bar uses high−low; the seed
 * is the simple average of the first `atrPeriod` true ranges; after that
 * ATR = (previous ATR × (period − 1) + true range) / period. The trade
 * stores the ATR on the entry bar. That value includes the entry bar's own
 * true range and no later bar. It stays fixed for the life of the trade.
 * A bar with no ATR yet, or a non-positive ATR, is not an entry.
 *
 * Stop and target. Long stop = entry − stop × ATR. Long target = entry +
 * target × ATR. Short stop = entry + stop × ATR. Short target = entry −
 * target × ATR. Defaults are a 14-day ATR, a 2× stop, and a 3× target.
 *
 * Exits. Judged on the close, same as the rest of the book. A wick through
 * the stop or target leaves the trade open. Long stop: close ≤ stop. Long
 * target: close ≥ target. Short stop: close ≥ stop. Short target:
 * close ≤ target. The stop is tested first. With a positive ATR the stop
 * and target sit on opposite sides of the entry, so one close cannot hit
 * both; the order is still stop, then target.
 *
 * While a trade is open, later breakouts are ignored in both directions.
 * An opposite breakout does not flip the position. After a stop or
 * take-profit the book stays flat through the rest of that bar, even when
 * the exit bar is itself a fresh breakout. The next entry is a later bar
 * that qualifies on its own. The signal bar is not checked for an exit.
 *
 * Missing volume. If the history has no positive volume, the strategy
 * refuses to run. It does not invent volume and it does not drop the filter.
 */
export const DEFAULT_DONCHIAN_PARAMS: DonchianParams = {
  channelLookback: 20,
  volumePeriod: 20,
  volumeMultiple: 1.5,
  atrPeriod: 14,
  stopMultiplier: 2,
  takeProfitMultiplier: 3,
}

export const NO_DONCHIAN_VOLUME_MESSAGE =
  "This symbol has no volume. The Donchian strategy needs real volume to confirm a breakout and will not guess or skip that filter."

const VOLUME_EPSILON = 1e-9

export function donchianParamsError(params: DonchianParams): string | null {
  if (!Number.isInteger(params.channelLookback) || params.channelLookback < 2) {
    return "Channel lookback must be a whole number of at least 2."
  }
  if (!Number.isInteger(params.volumePeriod) || params.volumePeriod < 2) {
    return "Volume average period must be a whole number of at least 2."
  }
  if (!Number.isFinite(params.volumeMultiple) || params.volumeMultiple <= 0) {
    return "Volume multiple must be greater than 0."
  }
  if (!Number.isInteger(params.atrPeriod) || params.atrPeriod < 2) {
    return "ATR period must be a whole number of at least 2."
  }
  if (!Number.isFinite(params.stopMultiplier) || params.stopMultiplier <= 0) {
    return "Stop multiplier must be greater than 0."
  }
  if (!Number.isFinite(params.takeProfitMultiplier) || params.takeProfitMultiplier <= 0) {
    return "Take-profit multiplier must be greater than 0."
  }
  return null
}

export function hasUsableVolume(bars: Array<Pick<Bar, "volume">>): boolean {
  return bars.some((bar) => Number.isFinite(bar.volume) && bar.volume > 0)
}

/** Highest high of the prior `lookback` bars. The bar at `index` is excluded. */
export function priorChannelHigh(bars: Array<Pick<Bar, "high">>, index: number, lookback: number): number | null {
  if (!Number.isInteger(lookback) || lookback < 1 || index < lookback) return null
  let extreme = bars[index - lookback].high
  for (let cursor = index - lookback + 1; cursor < index; cursor += 1) {
    if (bars[cursor].high > extreme) extreme = bars[cursor].high
  }
  return extreme
}

/** Lowest low of the prior `lookback` bars. The bar at `index` is excluded. */
export function priorChannelLow(bars: Array<Pick<Bar, "low">>, index: number, lookback: number): number | null {
  if (!Number.isInteger(lookback) || lookback < 1 || index < lookback) return null
  let extreme = bars[index - lookback].low
  for (let cursor = index - lookback + 1; cursor < index; cursor += 1) {
    if (bars[cursor].low < extreme) extreme = bars[cursor].low
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
  channelLevel: number
  atr: number
  stop: number
  target: number
}

function volumeConfirms(bar: Bar, averageVolume: number, multiple: number): boolean {
  if (!(averageVolume > 0)) return false
  return bar.volume >= multiple * averageVolume - VOLUME_EPSILON
}

function setupAt(bars: Bar[], index: number, atr: number | null, params: DonchianParams): Setup | null {
  if (atr == null || !Number.isFinite(atr) || !(atr > 0)) return null
  const channelHigh = priorChannelHigh(bars, index, params.channelLookback)
  const channelLow = priorChannelLow(bars, index, params.channelLookback)
  const averageVolume = priorAverageVolume(bars, index, params.volumePeriod)
  if (channelHigh == null || channelLow == null || averageVolume == null) return null

  const bar = bars[index]
  if (!volumeConfirms(bar, averageVolume, params.volumeMultiple)) return null

  const longBreak = bar.close > channelHigh
  const shortBreak = bar.close < channelLow
  // A single close cannot clear both sides of one window. Neither side stays flat.
  if (longBreak === shortBreak) return null

  const direction: TradeDirection = longBreak ? "long" : "short"
  const channelLevel = longBreak ? channelHigh : channelLow
  const stop = longBreak
    ? bar.close - params.stopMultiplier * atr
    : bar.close + params.stopMultiplier * atr
  const target = longBreak
    ? bar.close + params.takeProfitMultiplier * atr
    : bar.close - params.takeProfitMultiplier * atr
  if (!Number.isFinite(stop) || !Number.isFinite(target)) return null
  return { direction, channelLevel, atr, stop, target }
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
 * Flat-until-the-next-breakout state machine. An open trade ignores new
 * breakouts, including the opposite side. A stop or take-profit closes it,
 * and that same bar cannot open the next trade.
 */
export function decideDonchianTrades(bars: Bar[], params: DonchianParams): Trade[] {
  const trades: Trade[] = []
  const atr = wilderAtr(bars, params.atrPeriod)
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

    const setup = setupAt(bars, index, atr[index], params)
    if (!setup) continue

    const trade: Trade = {
      id: trades.length + 1,
      entryIndex: index,
      entryDate: bar.date,
      entryPrice: bar.close,
      atrAtEntry: setup.atr,
      stop: setup.stop,
      target: setup.target,
      exitIndex: null,
      exitDate: null,
      exitPrice: null,
      exitReason: null,
      direction: setup.direction,
      channelLevel: setup.channelLevel,
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

function enrich(bars: Bar[], params: DonchianParams, atr: (number | null)[]): EnrichedBar[] {
  return bars.map((bar, index) => ({
    ...bar,
    emaFast: null,
    emaSlow: null,
    atr: atr[index] ?? null,
    channelHigh: priorChannelHigh(bars, index, params.channelLookback),
    channelLow: priorChannelLow(bars, index, params.channelLookback),
  }))
}

export function generateDonchianSignals(bars: Bar[], params: DonchianParams): SignalResult {
  const cleaned = sanitizeBars(bars)
  const paramError = donchianParamsError(params)
  if (paramError) {
    return {
      bars: cleaned.map((bar) => ({ ...bar, emaFast: null, emaSlow: null, atr: null })),
      trades: [],
      markers: [],
      levelsTrade: null,
      error: paramError,
    }
  }

  const atr = wilderAtr(cleaned, params.atrPeriod)
  const enriched = enrich(cleaned, params, atr)
  if (cleaned.length > 0 && !hasUsableVolume(cleaned)) {
    return {
      bars: enriched,
      trades: [],
      markers: [],
      levelsTrade: null,
      error: NO_DONCHIAN_VOLUME_MESSAGE,
    }
  }

  const trades = decideDonchianTrades(cleaned, params)
  return {
    bars: enriched,
    trades,
    markers: trades.flatMap(markersFor),
    levelsTrade: trades.length > 0 ? trades[trades.length - 1] : null,
    error: null,
  }
}
