import { sanitizeBars } from "./strategy"
import type {
  Bar,
  EnrichedBar,
  ExitReason,
  RsiParams,
  RsiSide,
  SignalMarker,
  SignalResult,
  Trade,
  TradeDirection,
} from "./types"

/**
 * RSI(14) extreme reclaim. Mean reversion, long and short.
 *
 * Daily bars, same rules for US and Hong Kong names. The signal price is
 * that session’s close. Volume is not an input: a zero-volume history still
 * trades. Definitions below are the ones the desk and the tests share.
 *
 * Wilder RSI. For each bar after the first, the up-close is
 * max(close − previous close, 0) and the down-close is
 * max(previous close − close, 0). The seed at index `period` (the first
 * index with `period` changes, so `period + 1` closes) is the simple
 * average of those first `period` up-closes and down-closes. After that,
 * average = (previous average × (period − 1) + this bar’s move) / period.
 * RS = average gain / average loss. RSI = 100 − 100 / (1 + RS). When the
 * average loss is 0, RSI is 100, including a flat window where both
 * averages are 0. There is no RSI before index `period`. Default period
 * is 14, so the first reading sits on bar 14 and the first bar that can
 * see a prior reading is bar 15.
 *
 * Buy. RSI on the prior bar was at or below the oversold line (default 30)
 * and this bar’s RSI closes strictly back above it. A current reading that
 * only touches the line does not reclaim. A bar that is still at or below
 * the line, or that crosses down through it, is not a buy.
 *
 * Sell/short is the mirror. Prior RSI at or above the overbought line
 * (default 70), and this bar’s RSI closes strictly back below it. Touching
 * 70 is not a reclaim. Crossing up through 70 is not a short.
 *
 * Both sides. If one bar would qualify as a long and a short, skip it and
 * stay flat. With a single RSI and an oversold level below the overbought
 * level those two crosses cannot happen together; the gate is still
 * explicit so a bar flagged both ways never opens a trade.
 *
 * Entry. The signal bar’s close.
 *
 * Stop. One configurable price increment beyond the signal bar’s wick,
 * the same convention as the volume-sweep strategy. Default 0.01, which
 * is one cent on the US and Hong Kong demos. Northline does not look up
 * the exchange tick schedule. Long stop = signal low − offset. Short stop
 * = signal high + offset. Offset 0 sits the stop on the wick.
 *
 * Risk and target. Risk is the distance from the entry close to that stop.
 * The take-profit is `takeProfitMultiple` times that risk (default 2),
 * beyond the entry in the trade’s direction. A setup with risk ≤ 0 is
 * skipped. With a valid OHLC bar, a strict wick, and a positive offset,
 * risk is positive. Offset 0 and a close that sits on the wick has no risk
 * and is not a trade.
 *
 * Exits. Judged on the close. A wick through the stop or target leaves the
 * trade open. Long stop: close ≤ stop. Long target: close ≥ target. Short
 * stop: close ≥ stop. Short target: close ≤ target. The stop is tested
 * first.
 *
 * While a trade is open, later reclaims are ignored in both directions.
 * An opposite signal does not flip the position. The only exits are the
 * stop and the take-profit. After either exit the book stays flat through
 * the rest of that bar. The next entry is a later bar that qualifies on
 * its own. The signal bar itself is not checked for an exit; with positive
 * risk its close sits strictly between the stop and the target.
 */
export const DEFAULT_RSI_PARAMS: RsiParams = {
  period: 14,
  oversold: 30,
  overbought: 70,
  takeProfitMultiple: 2,
  stopOffset: 0.01,
}

export function rsiParamsError(params: RsiParams): string | null {
  if (!Number.isInteger(params.period) || params.period < 2) {
    return "RSI period must be a whole number of at least 2."
  }
  if (!Number.isFinite(params.oversold) || params.oversold <= 0 || params.oversold >= 100) {
    return "Oversold level must be between 0 and 100."
  }
  if (!Number.isFinite(params.overbought) || params.overbought <= 0 || params.overbought >= 100) {
    return "Overbought level must be between 0 and 100."
  }
  if (params.oversold >= params.overbought) {
    return "Oversold level must be below the overbought level."
  }
  if (!Number.isFinite(params.takeProfitMultiple) || params.takeProfitMultiple <= 0) {
    return "Take-profit multiple must be greater than 0."
  }
  if (!Number.isFinite(params.stopOffset) || params.stopOffset < 0) {
    return "Stop offset must be zero or greater."
  }
  return null
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (!(avgLoss > 0)) return 100
  const relativeStrength = avgGain / avgLoss
  return 100 - 100 / (1 + relativeStrength)
}

/**
 * Wilder RSI. Index `period` holds the first value. Earlier slots are null.
 * Average loss of 0 yields 100.
 */
export function wilderRsi(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(closes.length).fill(null)
  if (!Number.isInteger(period) || period < 1 || closes.length <= period) return out

  let gainSum = 0
  let lossSum = 0
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1]
    if (change > 0) gainSum += change
    else lossSum -= change
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  out[period] = rsiFromAverages(avgGain, avgLoss)

  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1]
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[index] = rsiFromAverages(avgGain, avgLoss)
  }
  return out
}

/**
 * Both flags skip the bar. One flag is that side. Neither flag stays flat.
 * The state machine treats "both" as "do not enter".
 */
export function classifyReclaim(longQualified: boolean, shortQualified: boolean): RsiSide {
  if (longQualified && shortQualified) return "both"
  if (longQualified) return "long"
  if (shortQualified) return "short"
  return null
}

/**
 * Reclaim of an RSI extreme. The current reading has to finish strictly
 * back through the line. Equal to the line is a touch, not a signal.
 * Crossing into the extreme is not a reclaim of it.
 */
export function rsiReclaimSide(
  previous: number | null,
  current: number | null,
  oversold: number,
  overbought: number,
): RsiSide {
  if (previous == null || current == null) return null
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null
  if (!Number.isFinite(oversold) || !Number.isFinite(overbought)) return null
  return classifyReclaim(previous <= oversold && current > oversold, previous >= overbought && current < overbought)
}

export type RsiDecisionRow = {
  date: string
  high: number
  low: number
  close: number
  side: RsiSide
}

type Setup = {
  direction: TradeDirection
  wickLevel: number
  stop: number
  target: number
}

function setupAt(row: RsiDecisionRow, params: Pick<RsiParams, "stopOffset" | "takeProfitMultiple">): Setup | null {
  if (row.side !== "long" && row.side !== "short") return null
  const long = row.side === "long"
  const wickLevel = long ? row.low : row.high
  const stop = long ? row.low - params.stopOffset : row.high + params.stopOffset
  const risk = long ? row.close - stop : stop - row.close
  if (!(risk > 0) || !Number.isFinite(stop)) return null
  const target = long
    ? row.close + params.takeProfitMultiple * risk
    : row.close - params.takeProfitMultiple * risk
  if (!Number.isFinite(target)) return null
  return { direction: row.side, wickLevel, stop, target }
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
 * Flat-until-the-next-reclaim state machine. "both" and null do not enter.
 * An open trade ignores new signals. A stop or take-profit closes it, and
 * that same bar cannot open the next trade.
 */
export function decideRsiTrades(
  rows: RsiDecisionRow[],
  params: Pick<RsiParams, "stopOffset" | "takeProfitMultiple">,
): Trade[] {
  const trades: Trade[] = []
  let open: Trade | null = null

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]

    if (open) {
      const reason = closeThroughExit(open, row.close)
      if (reason) {
        open.exitIndex = index
        open.exitDate = row.date
        open.exitPrice = row.close
        open.exitReason = reason
        open = null
      }
      continue
    }

    const setup = setupAt(row, params)
    if (!setup) continue

    const trade: Trade = {
      id: trades.length + 1,
      entryIndex: index,
      entryDate: row.date,
      entryPrice: row.close,
      // ATR belongs to the EMA and Donchian books. RSI risk is entry-to-stop.
      atrAtEntry: 0,
      stop: setup.stop,
      target: setup.target,
      exitIndex: null,
      exitDate: null,
      exitPrice: null,
      exitReason: null,
      direction: setup.direction,
      wickLevel: setup.wickLevel,
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

export function generateRsiSignals(bars: Bar[], params: RsiParams): SignalResult {
  const cleaned = sanitizeBars(bars)
  const paramError = rsiParamsError(params)
  if (paramError) {
    return {
      bars: cleaned.map((bar) => ({ ...bar, emaFast: null, emaSlow: null, atr: null, rsi: null })),
      trades: [],
      markers: [],
      levelsTrade: null,
      error: paramError,
    }
  }

  const rsi = wilderRsi(
    cleaned.map((bar) => bar.close),
    params.period,
  )
  const enriched: EnrichedBar[] = cleaned.map((bar, index) => ({
    ...bar,
    emaFast: null,
    emaSlow: null,
    atr: null,
    rsi: rsi[index],
  }))
  const rows: RsiDecisionRow[] = cleaned.map((bar, index) => ({
    date: bar.date,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    side: rsiReclaimSide(index > 0 ? rsi[index - 1] : null, rsi[index], params.oversold, params.overbought),
  }))
  const trades = decideRsiTrades(rows, params)
  return {
    bars: enriched,
    trades,
    markers: trades.flatMap(markersFor),
    levelsTrade: trades.length > 0 ? trades[trades.length - 1] : null,
    error: null,
  }
}
