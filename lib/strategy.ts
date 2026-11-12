import type {
  Bar,
  DecisionRow,
  EnrichedBar,
  ExitReason,
  SignalMarker,
  SignalResult,
  StrategyParams,
  Trade,
  TradeSummary,
} from "./types"

export const DEFAULT_PARAMS: StrategyParams = {
  fastPeriod: 20,
  slowPeriod: 50,
  atrPeriod: 14,
  stopMultiplier: 2,
  takeProfitMultiplier: 3,
}

export const EXIT_LABEL: Record<ExitReason, string> = {
  ema_cross: "EMA cross",
  stop: "Stop",
  take_profit: "Take-profit",
}

export function paramsError(params: StrategyParams): string | null {
  if (!Number.isInteger(params.fastPeriod) || params.fastPeriod < 2) {
    return "Fast EMA must be a whole number of at least 2."
  }
  if (!Number.isInteger(params.slowPeriod) || params.slowPeriod < 3) {
    return "Slow EMA must be a whole number of at least 3."
  }
  if (params.fastPeriod >= params.slowPeriod) {
    return "Fast EMA must be shorter than the slow EMA."
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

/**
 * EMA seeded with a simple average, then k = 2 / (period + 1).
 * The seed sits on the last bar of the first window (index period - 1).
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out

  let sum = 0
  for (let i = 0; i < period; i += 1) sum += values[i]
  let previous = sum / period
  out[period - 1] = previous
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i += 1) {
    previous = (values[i] - previous) * k + previous
    out[i] = previous
  }
  return out
}

function trueRange(high: number, low: number, previousClose: number | null): number {
  const range = high - low
  if (previousClose == null) return range
  return Math.max(range, Math.abs(high - previousClose), Math.abs(low - previousClose))
}

/**
 * Wilder ATR. True range on the first bar is high − low. The seed is the
 * simple average of the first `period` true ranges, then
 * ATR = (previous ATR × (period − 1) + true range) / period.
 */
export function wilderAtr(
  bars: Array<Pick<Bar, "high" | "low" | "close">>,
  period: number,
): (number | null)[] {
  const out: (number | null)[] = Array(bars.length).fill(null)
  if (!Number.isInteger(period) || period < 1 || bars.length < period) return out

  const tr: number[] = bars.map((bar, index) =>
    trueRange(bar.high, bar.low, index === 0 ? null : bars[index - 1].close),
  )
  let sum = 0
  for (let i = 0; i < period; i += 1) sum += tr[i]
  let previous = sum / period
  out[period - 1] = previous
  for (let i = period; i < bars.length; i += 1) {
    previous = (previous * (period - 1) + tr[i]) / period
    out[i] = previous
  }
  return out
}

function crossedDown(previous: DecisionRow | null, row: DecisionRow): boolean {
  if (!previous) return false
  const { emaFast: previousFast, emaSlow: previousSlow } = previous
  const { emaFast: fast, emaSlow: slow } = row
  if (previousFast == null || previousSlow == null || fast == null || slow == null) return false
  return previousFast >= previousSlow && fast < slow
}

function freshCrossUp(previous: DecisionRow | null, row: DecisionRow): boolean {
  if (!previous || row.atr == null) return false
  const { emaFast: previousFast, emaSlow: previousSlow } = previous
  const { emaFast: fast, emaSlow: slow } = row
  if (previousFast == null || previousSlow == null || fast == null || slow == null) return false
  return previousFast <= previousSlow && fast > slow
}

/**
 * Long-only state machine. An exit is judged on the close, never on a wick.
 * When a cross down, stop, and target could coincide, the order is
 * EMA cross, then stop, then take-profit. Entry and exit cannot share a bar.
 * After a stop or take-profit the book stays flat until the next fresh cross;
 * that falls out of requiring the cross itself, not merely fast > slow.
 */
export function decideTrades(
  rows: DecisionRow[],
  params: Pick<StrategyParams, "stopMultiplier" | "takeProfitMultiplier">,
): Trade[] {
  const trades: Trade[] = []
  let open: Trade | null = null

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const previous = index > 0 ? rows[index - 1] : null

    if (open) {
      let reason: ExitReason | null = null
      if (crossedDown(previous, row)) reason = "ema_cross"
      else if (row.close <= open.stop) reason = "stop"
      else if (row.close >= open.target) reason = "take_profit"

      if (reason) {
        open.exitIndex = index
        open.exitDate = row.date
        open.exitPrice = row.close
        open.exitReason = reason
        open = null
      }
      continue
    }

    if (!freshCrossUp(previous, row) || row.atr == null) continue
    const trade: Trade = {
      id: trades.length + 1,
      entryIndex: index,
      entryDate: row.date,
      entryPrice: row.close,
      atrAtEntry: row.atr,
      stop: row.close - params.stopMultiplier * row.atr,
      target: row.close + params.takeProfitMultiplier * row.atr,
      exitIndex: null,
      exitDate: null,
      exitPrice: null,
      exitReason: null,
    }
    trades.push(trade)
    open = trade
  }

  return trades
}

function finiteNumber(value: number): boolean {
  return Number.isFinite(value)
}

export function sanitizeBars(bars: Bar[]): Bar[] {
  const byDate = new Map<string, Bar>()
  for (const bar of bars) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) continue
    if (![bar.open, bar.high, bar.low, bar.close].every(finiteNumber)) continue
    if (bar.high < bar.low) continue
    byDate.set(bar.date, {
      ...bar,
      volume: finiteNumber(bar.volume) ? bar.volume : 0,
    })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function generateSignals(bars: Bar[], params: StrategyParams): SignalResult {
  const cleaned = sanitizeBars(bars)
  if (paramsError(params)) {
    return {
      bars: cleaned.map((bar) => ({ ...bar, emaFast: null, emaSlow: null, atr: null })),
      trades: [],
      markers: [],
      levelsTrade: null,
    }
  }

  const closes = cleaned.map((bar) => bar.close)
  const emaFast = ema(closes, params.fastPeriod)
  const emaSlow = ema(closes, params.slowPeriod)
  const atr = wilderAtr(cleaned, params.atrPeriod)
  const enriched: EnrichedBar[] = cleaned.map((bar, index) => ({
    ...bar,
    emaFast: emaFast[index],
    emaSlow: emaSlow[index],
    atr: atr[index],
  }))
  const rows: DecisionRow[] = enriched.map((bar) => ({
    date: bar.date,
    close: bar.close,
    emaFast: bar.emaFast,
    emaSlow: bar.emaSlow,
    atr: bar.atr,
  }))
  const trades = decideTrades(rows, params)
  const markers: SignalMarker[] = trades.flatMap((trade) => {
    const entry: SignalMarker = {
      date: trade.entryDate,
      side: "entry",
      label: "Buy",
      reason: null,
    }
    if (!trade.exitDate || !trade.exitReason) return [entry]
    return [
      entry,
      {
        date: trade.exitDate,
        side: "exit",
        label: EXIT_LABEL[trade.exitReason],
        reason: trade.exitReason,
      },
    ]
  })

  return {
    bars: enriched,
    trades,
    markers,
    levelsTrade: trades.length > 0 ? trades[trades.length - 1] : null,
  }
}

export function summarizeTrades(trades: Trade[], lastClose: number): TradeSummary {
  const closed = trades.filter((trade) => trade.exitPrice != null)
  const wins = closed.filter((trade) => (trade.exitPrice as number) > trade.entryPrice)
  const returns = closed.map(
    (trade) => ((trade.exitPrice as number) - trade.entryPrice) / trade.entryPrice,
  )
  const open = trades.find((trade) => trade.exitPrice == null) ?? null
  return {
    entries: trades.length,
    exits: closed.length,
    wins: wins.length,
    winRate: closed.length > 0 ? wins.length / closed.length : null,
    avgReturn: returns.length > 0 ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    open,
    unrealized: open && Number.isFinite(lastClose) ? (lastClose - open.entryPrice) / open.entryPrice : null,
  }
}
