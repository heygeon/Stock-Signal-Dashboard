export type Bar = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type Quote = {
  symbol: string
  shortName: string
  currency: string
  exchange: string
  timezone: string
  source: "live" | "cache"
  warning?: string
  fetchedAt: string
  bars: Bar[]
}

export type StrategyId = "ema" | "sweep" | "donchian" | "rsi"

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  ema: "20/50 EMA",
  sweep: "Volume sweep",
  donchian: "Donchian",
  rsi: "RSI reclaim",
}

export type StrategyParams = {
  fastPeriod: number
  slowPeriod: number
  atrPeriod: number
  stopMultiplier: number
  takeProfitMultiplier: number
}

export type SweepParams = {
  swingLookback: number
  volumePeriod: number
  volumeMultiple: number
  takeProfitMultiple: number
  stopOffset: number
}

export type DonchianParams = {
  channelLookback: number
  volumePeriod: number
  volumeMultiple: number
  atrPeriod: number
  stopMultiplier: number
  takeProfitMultiplier: number
}

export type RsiParams = {
  period: number
  oversold: number
  overbought: number
  takeProfitMultiple: number
  stopOffset: number
}

export type ExitReason = "ema_cross" | "stop" | "take_profit"

export type EnrichedBar = Bar & {
  emaFast: number | null
  emaSlow: number | null
  atr: number | null
  /** Prior Donchian high, current bar excluded. Set by that strategy only. */
  channelHigh?: number | null
  /** Prior Donchian low, current bar excluded. Set by that strategy only. */
  channelLow?: number | null
  /** Wilder RSI of this close. Set by the RSI strategy only. */
  rsi?: number | null
}

export type TradeDirection = "long" | "short"

/** Long, short, or a bar that qualifies both and must be skipped. */
export type RsiSide = TradeDirection | "both" | null

export type Trade = {
  id: number
  entryIndex: number
  entryDate: string
  entryPrice: number
  atrAtEntry: number
  stop: number
  target: number
  exitIndex: number | null
  exitDate: string | null
  exitPrice: number | null
  exitReason: ExitReason | null
  /** Absent on EMA trades, which are long-only. */
  direction?: TradeDirection
  /** Level that was swept and reclaimed. Absent on EMA trades. */
  sweptLevel?: number | null
  /** Prior channel extreme the Donchian close broke. Absent on other strategies. */
  channelLevel?: number | null
  /** Signal-bar wick the RSI stop sits beyond. Absent on other strategies. */
  wickLevel?: number | null
}

export type SignalMarker = {
  date: string
  side: "entry" | "exit"
  label: string
  reason: ExitReason | null
  /** Absent on EMA markers, which are long-only. */
  direction?: TradeDirection
}

export type SignalResult = {
  bars: EnrichedBar[]
  trades: Trade[]
  markers: SignalMarker[]
  levelsTrade: Trade | null
  /** Set when a strategy cannot run, for example a sweep with no volume. */
  error?: string | null
}

export type TradeSummary = {
  entries: number
  exits: number
  wins: number
  winRate: number | null
  avgReturn: number | null
  open: Trade | null
  unrealized: number | null
}

export type DecisionRow = {
  date: string
  close: number
  emaFast: number | null
  emaSlow: number | null
  atr: number | null
}

export type RangeMode = "recent" | "all" | "trade"
