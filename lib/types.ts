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

export type StrategyParams = {
  fastPeriod: number
  slowPeriod: number
  atrPeriod: number
  stopMultiplier: number
  takeProfitMultiplier: number
}

export type ExitReason = "ema_cross" | "stop" | "take_profit"

export type EnrichedBar = Bar & {
  emaFast: number | null
  emaSlow: number | null
  atr: number | null
}

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
}

export type SignalMarker = {
  date: string
  side: "entry" | "exit"
  label: string
  reason: ExitReason | null
}

export type SignalResult = {
  bars: EnrichedBar[]
  trades: Trade[]
  markers: SignalMarker[]
  levelsTrade: Trade | null
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
