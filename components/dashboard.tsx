"use client"

import { useEffect, useMemo, useState } from "react"
import { PriceChart, type ChartModel } from "@/components/price-chart"
import { SidePanel, StrategySwitch } from "@/components/side-panel"
import { TradeBlotter } from "@/components/trade-blotter"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { OptionsOverlay, type OptionsPanelState } from "@/components/options-overlay"
import { BUNDLED_QUOTES } from "@/lib/bundled"
import { DEFAULT_DONCHIAN_PARAMS, generateDonchianSignals } from "@/lib/donchian"
import { formatChange, formatDate, formatPct, formatPrice } from "@/lib/format"
import {
  DEFAULT_OPTIONS_OVERLAY,
  evaluateOptionsChain,
  optionsAccess,
  overlayBadge,
  stockBookWithOverlay,
  type OptionContract,
  type OptionsOverlayParams,
  type OverlayEffect,
} from "@/lib/options"
import { DEFAULT_RSI_PARAMS, generateRsiSignals } from "@/lib/rsi"
import { DEFAULT_PARAMS, generateSignals, summarizeTrades } from "@/lib/strategy"
import { DEFAULT_SWEEP_PARAMS, generateSweepSignals } from "@/lib/sweep"
import { normalizeSymbol } from "@/lib/symbols"
import {
  STRATEGY_LABEL,
  type DonchianParams,
  type Quote,
  type RangeMode,
  type RsiParams,
  type StrategyId,
  type StrategyParams,
  type SweepParams,
  type Trade,
  type TradeSummary,
} from "@/lib/types"

type LiveState = "loading" | "live" | "fallback"

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sanitizeParams(current: StrategyParams, patch: Partial<StrategyParams>): StrategyParams {
  const next: StrategyParams = { ...current, ...patch }
  next.atrPeriod = clamp(Math.round(next.atrPeriod), 2, 50)
  next.stopMultiplier = clamp(Math.round(next.stopMultiplier * 10) / 10, 0.5, 6)
  next.takeProfitMultiplier = clamp(Math.round(next.takeProfitMultiplier * 10) / 10, 0.5, 10)
  next.fastPeriod = clamp(Math.round(next.fastPeriod), 2, 200)
  next.slowPeriod = clamp(Math.round(next.slowPeriod), 3, 250)
  if (next.fastPeriod >= next.slowPeriod) {
    if (patch.fastPeriod != null && patch.slowPeriod == null) next.fastPeriod = next.slowPeriod - 1
    else next.slowPeriod = Math.min(250, next.fastPeriod + 1)
  }
  return next
}

function sanitizeSweep(current: SweepParams, patch: Partial<SweepParams>): SweepParams {
  const next: SweepParams = { ...current, ...patch }
  next.swingLookback = clamp(Math.round(next.swingLookback), 2, 60)
  next.volumePeriod = clamp(Math.round(next.volumePeriod), 2, 120)
  next.volumeMultiple = clamp(Math.round(next.volumeMultiple * 10) / 10, 1, 5)
  next.takeProfitMultiple = clamp(Math.round(next.takeProfitMultiple * 10) / 10, 0.5, 10)
  next.stopOffset = clamp(Math.round(next.stopOffset * 100) / 100, 0, 1)
  return next
}

function sanitizeDonchian(current: DonchianParams, patch: Partial<DonchianParams>): DonchianParams {
  const next: DonchianParams = { ...current, ...patch }
  next.channelLookback = clamp(Math.round(next.channelLookback), 2, 120)
  next.volumePeriod = clamp(Math.round(next.volumePeriod), 2, 120)
  next.volumeMultiple = clamp(Math.round(next.volumeMultiple * 10) / 10, 1, 5)
  next.atrPeriod = clamp(Math.round(next.atrPeriod), 2, 50)
  next.stopMultiplier = clamp(Math.round(next.stopMultiplier * 10) / 10, 0.5, 6)
  next.takeProfitMultiplier = clamp(Math.round(next.takeProfitMultiplier * 10) / 10, 0.5, 10)
  return next
}

function sanitizeRsi(current: RsiParams, patch: Partial<RsiParams>): RsiParams {
  const next: RsiParams = { ...current, ...patch }
  next.period = clamp(Math.round(next.period), 2, 50)
  next.takeProfitMultiple = clamp(Math.round(next.takeProfitMultiple * 10) / 10, 0.5, 10)
  next.stopOffset = clamp(Math.round(next.stopOffset * 100) / 100, 0, 1)
  next.oversold = clamp(Math.round(next.oversold), 1, 98)
  next.overbought = clamp(Math.round(next.overbought), 2, 99)
  if (next.oversold >= next.overbought) {
    if (patch.oversold != null && patch.overbought == null) next.oversold = next.overbought - 1
    else next.overbought = Math.min(99, next.oversold + 1)
  }
  return next
}

function levelsCaption(
  trade: Trade,
  currency: string,
  isOpen: boolean,
  selected: boolean,
  strategy: StrategyId,
): string {
  const which = selected ? `Trade ${trade.id}` : isOpen ? "Open position" : "Most recent trade"
  const entered = `entered ${formatDate(trade.entryDate)} at ${formatPrice(trade.entryPrice, currency)}`
  const band = `stop ${formatPrice(trade.stop, currency)} · target ${formatPrice(trade.target, currency)}`
  if (strategy === "sweep") {
    const side = trade.direction === "short" ? "Short" : "Long"
    const swept = trade.sweptLevel == null ? "—" : formatPrice(trade.sweptLevel, currency)
    return `${which} · ${side} · ${entered} · swept ${swept} · ${band}`
  }
  if (strategy === "donchian") {
    const side = trade.direction === "short" ? "Short" : "Long"
    const broke = trade.channelLevel == null ? "" : ` · broke ${formatPrice(trade.channelLevel, currency)}`
    return `${which} · ${side} · ${entered}${broke} · ${band} · entry ATR ${formatPrice(trade.atrAtEntry, currency)}`
  }
  if (strategy === "rsi") {
    const side = trade.direction === "short" ? "Short" : "Long"
    const wick = trade.wickLevel == null ? "" : ` · wick ${formatPrice(trade.wickLevel, currency)}`
    return `${which} · ${side} · ${entered}${wick} · ${band}`
  }
  return `${which} · ${entered} · ${band} · entry ATR ${formatPrice(trade.atrAtEntry, currency)}`
}

function emptyLevels(strategy: StrategyId): string {
  if (strategy === "sweep") return "No sweep in this window, so there is no swept level, stop, or target to draw."
  if (strategy === "donchian") return "No breakout in this window, so there is no stop or target to draw."
  if (strategy === "rsi") return "No RSI reclaim in this window, so there is no stop or target to draw."
  return "No trade in this window, so there is no stop or target to draw."
}

function BookFootnote({ strategy }: { strategy: StrategyId }) {
  if (strategy === "sweep") {
    return (
      <>
        Sweep signals are judged on the daily close. A wick through the stop or target leaves the trade open. After a
        stop or take-profit the book stays flat until the next fresh sweep, and a new sweep does not flip an open trade.
        Prices come from{" "}
      </>
    )
  }
  if (strategy === "donchian") {
    return (
      <>
        Donchian signals are judged on the daily close. A wick through the stop or target leaves the trade open. The
        stop is checked before the target. After a stop or take-profit the book stays flat until a later bar breaks out
        on its own, and an opposite breakout does not flip an open trade. Prices come from{" "}
      </>
    )
  }
  if (strategy === "rsi") {
    return (
      <>
        RSI reclaims are judged on the daily close. A wick through the stop or target leaves the trade open. The stop
        is checked before the target. A bar that would qualify both sides is skipped. After a stop or take-profit the
        book stays flat until a later bar reclaims on its own, and an opposite signal does not flip an open trade.
        Prices come from{" "}
      </>
    )
  }
  return (
    <>
      Signals are judged on the daily close. A wick through the stop or target does not exit. Same-day conflicts resolve
      in order: EMA cross, then stop, then take-profit. Prices come from{" "}
    </>
  )
}

function sanitizeOverlay(current: OptionsOverlayParams, patch: Partial<OptionsOverlayParams>): OptionsOverlayParams {
  const next: OptionsOverlayParams = { ...current, ...patch }
  next.volumeOiMultiple = clamp(Math.round(next.volumeOiMultiple * 10) / 10, 1, 10)
  next.minVolume = clamp(Math.round(next.minVolume), 0, 10000)
  return next
}

type OptionsLoad =
  | { status: "loading" }
  | { status: "skipped"; symbol: string; reason: string }
  | { status: "unavailable"; symbol: string; reason: string }
  | { status: "ok"; symbol: string; asOf: string | null; fetchedAt: string; contracts: OptionContract[] }

function overlayBadgeVariant(effect: OverlayEffect): "long" | "short" | "stop" | "outline" {
  if (effect === "confirmed-long") return "long"
  if (effect === "confirmed-short") return "short"
  if (effect === "vetoed-long" || effect === "vetoed-short") return "stop"
  return "outline"
}

function bookState(summary: TradeSummary | null): "Long" | "Short" | "Flat" {
  if (!summary?.open) return "Flat"
  return summary.open.direction === "short" ? "Short" : "Long"
}

export function Dashboard() {
  const [symbol, setSymbol] = useState("AAPL")
  const [draft, setDraft] = useState("AAPL")
  const [symbolError, setSymbolError] = useState<string | null>(null)
  const [quote, setQuote] = useState<Quote | null>(BUNDLED_QUOTES.AAPL)
  const [liveState, setLiveState] = useState<LiveState>("loading")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [strategy, setStrategy] = useState<StrategyId>("ema")
  const [emaParams, setEmaParams] = useState<StrategyParams>(DEFAULT_PARAMS)
  const [sweepParams, setSweepParams] = useState<SweepParams>(DEFAULT_SWEEP_PARAMS)
  const [donchianParams, setDonchianParams] = useState<DonchianParams>(DEFAULT_DONCHIAN_PARAMS)
  const [rsiParams, setRsiParams] = useState<RsiParams>(DEFAULT_RSI_PARAMS)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [rangeMode, setRangeMode] = useState<RangeMode>("recent")
  const [options, setOptions] = useState<OptionsLoad>({ status: "loading" })
  const [overlayParams, setOverlayParams] = useState<OptionsOverlayParams>(DEFAULT_OPTIONS_OVERLAY)

  useEffect(() => {
    const requested = symbol
    const controller = new AbortController()
    fetch(`/api/quotes?symbol=${encodeURIComponent(requested)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as Quote & { error?: string }
        if (!response.ok) throw new Error(body.error || "Quote request failed.")
        return body
      })
      .then((next) => {
        setQuote(next)
        setLoadError(null)
        setLiveState(next.source === "live" ? "live" : "fallback")
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : "Live bars were unavailable."
        setLiveState("fallback")
        setQuote((current) => {
          if (current?.symbol === requested) {
            return {
              ...current,
              source: "cache",
              warning: current.warning ?? message,
            }
          }
          return current
        })
        setLoadError(message)
      })
    return () => controller.abort()
  }, [symbol, reloadKey])

  useEffect(() => {
    const requested = symbol
    const access = optionsAccess(requested)
    if (access.kind !== "us") {
      setOptions(
        access.kind === "hk"
          ? { status: "skipped", symbol: access.symbol, reason: access.reason }
          : { status: "unavailable", symbol: requested, reason: access.reason },
      )
      return
    }

    const controller = new AbortController()
    setOptions({ status: "loading" })
    fetch(`/api/options?symbol=${encodeURIComponent(access.symbol)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as {
          status?: string
          symbol?: string
          reason?: string
          asOf?: string | null
          fetchedAt?: string
          contracts?: OptionContract[]
        }
        if (controller.signal.aborted) return
        if (body.status === "ok" && body.symbol && Array.isArray(body.contracts)) {
          setOptions({
            status: "ok",
            symbol: body.symbol,
            asOf: body.asOf ?? null,
            fetchedAt: body.fetchedAt || new Date().toISOString(),
            contracts: body.contracts,
          })
          return
        }
        const reason =
          body.reason || "The options chain was unavailable, so the overlay is skipped and the stock signals are unchanged."
        setOptions(
          body.status === "skipped"
            ? { status: "skipped", symbol: body.symbol || access.symbol, reason }
            : { status: "unavailable", symbol: body.symbol || access.symbol, reason },
        )
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const reason =
          error instanceof Error && error.name === "AbortError"
            ? null
            : "The options chain was unavailable, so the overlay is skipped and the stock signals are unchanged."
        if (!reason) return
        setOptions({ status: "unavailable", symbol: access.symbol, reason })
      })
    return () => controller.abort()
  }, [symbol, reloadKey])

  useEffect(() => {
    document.title = `${symbol} signals · Northline`
  }, [symbol])

  const strategyResult = useMemo(() => {
    if (!quote) return null
    if (strategy === "sweep") return generateSweepSignals(quote.bars, sweepParams)
    if (strategy === "donchian") return generateDonchianSignals(quote.bars, donchianParams)
    if (strategy === "rsi") return generateRsiSignals(quote.bars, rsiParams)
    return generateSignals(quote.bars, emaParams)
  }, [quote, strategy, emaParams, sweepParams, donchianParams, rsiParams])

  // Confirm/veto lives outside the four strategy engines. A null reading
  // (Hong Kong, a failed chain, a chain that has not loaded, or a chain with
  // no usable open interest) returns the strategy book unchanged.
  // Definitions: lib/options.ts.
  const evaluation = useMemo(() => {
    if (options.status !== "ok" || options.symbol !== symbol) return null
    return evaluateOptionsChain(options.contracts, overlayParams)
  }, [options, symbol, overlayParams])
  const reading = evaluation?.status === "ready" ? evaluation.reading : null
  const overlaid = useMemo(() => {
    if (!strategyResult) return null
    return stockBookWithOverlay(strategyResult, reading)
  }, [strategyResult, reading])
  const result = overlaid?.result ?? null
  const overlayDecision = overlaid?.decision ?? null
  const optionsPanel: OptionsPanelState = useMemo(() => {
    if (options.status === "loading" || (options.status === "ok" && options.symbol !== symbol)) {
      return { status: "loading", symbol }
    }
    if (options.status === "skipped" || options.status === "unavailable") return options
    if (evaluation?.status === "skipped") {
      return { status: "skipped", symbol: options.symbol, reason: evaluation.reason }
    }
    if (!reading) return { status: "loading", symbol }
    return {
      status: "ok",
      symbol: options.symbol,
      asOf: options.asOf,
      fetchedAt: options.fetchedAt,
      contractCount: options.contracts.length,
      reading,
    }
  }, [options, symbol, evaluation, reading])
  useEffect(() => {
    if (selectedId == null || !result) return
    if (!result.trades.some((trade) => trade.id === selectedId)) {
      setSelectedId(null)
      setRangeMode("recent")
    }
  }, [result, selectedId])

  const summary = useMemo(() => {
    if (!result || !quote || quote.bars.length === 0 || result.error) return null
    return summarizeTrades(result.trades, quote.bars[quote.bars.length - 1].close)
  }, [quote, result])

  const selected = result?.trades.find((trade) => trade.id === selectedId) ?? null
  const levels = selected ?? result?.levelsTrade ?? null
  const model: ChartModel | null = useMemo(() => {
    if (!result || !quote) return null
    const picked = result.trades.find((trade) => trade.id === selectedId) ?? null
    return {
      symbol: quote.symbol,
      bars: result.bars,
      markers: result.markers,
      levels: picked ?? result.levelsTrade,
      fastPeriod: emaParams.fastPeriod,
      slowPeriod: emaParams.slowPeriod,
      channelLookback: donchianParams.channelLookback,
      rsiPeriod: rsiParams.period,
      rsiOversold: rsiParams.oversold,
      rsiOverbought: rsiParams.overbought,
      rangeMode,
      focus: rangeMode === "trade" ? picked : null,
      strategy,
    }
  }, [
    quote,
    result,
    selectedId,
    strategy,
    emaParams.fastPeriod,
    emaParams.slowPeriod,
    donchianParams.channelLookback,
    rsiParams.period,
    rsiParams.oversold,
    rsiParams.overbought,
    rangeMode,
  ])

  function selectSymbol(raw: string) {
    const next = normalizeSymbol(raw)
    if (!next) {
      setSymbolError("Use a ticker such as AAPL or 0700.HK.")
      return
    }
    setSymbolError(null)
    setDraft(next)
    setSelectedId(null)
    setRangeMode("recent")
    setLoadError(null)
    const bundled = BUNDLED_QUOTES[next]
    if (bundled) {
      setQuote(bundled)
      setLiveState("loading")
    } else {
      setQuote(null)
      setLiveState("loading")
    }
    if (next === symbol) setReloadKey((value) => value + 1)
    else setSymbol(next)
  }

  function updateEmaParams(patch: Partial<StrategyParams>) {
    setEmaParams((current) => sanitizeParams(current, patch))
    setSelectedId(null)
    setRangeMode("recent")
  }

  function updateSweepParams(patch: Partial<SweepParams>) {
    setSweepParams((current) => sanitizeSweep(current, patch))
    setSelectedId(null)
    setRangeMode("recent")
  }

  function updateDonchianParams(patch: Partial<DonchianParams>) {
    setDonchianParams((current) => sanitizeDonchian(current, patch))
    setSelectedId(null)
    setRangeMode("recent")
  }

  function updateRsiParams(patch: Partial<RsiParams>) {
    setRsiParams((current) => sanitizeRsi(current, patch))
    setSelectedId(null)
    setRangeMode("recent")
  }

  function updateOverlay(patch: Partial<OptionsOverlayParams>) {
    setOverlayParams((current) => sanitizeOverlay(current, patch))
  }

  function resetParams() {
    if (strategy === "sweep") setSweepParams(DEFAULT_SWEEP_PARAMS)
    else if (strategy === "donchian") setDonchianParams(DEFAULT_DONCHIAN_PARAMS)
    else if (strategy === "rsi") setRsiParams(DEFAULT_RSI_PARAMS)
    else setEmaParams(DEFAULT_PARAMS)
    setSelectedId(null)
    setRangeMode("recent")
  }

  function selectStrategy(next: StrategyId) {
    setStrategy(next)
    setSelectedId(null)
    setRangeMode("recent")
  }

  const lastBar = quote && quote.bars.length > 0 ? quote.bars[quote.bars.length - 1] : null
  const prevBar = quote && quote.bars.length > 1 ? quote.bars[quote.bars.length - 2] : null
  const change = lastBar && prevBar ? lastBar.close - prevBar.close : null
  const showingQuote = quote && quote.symbol === symbol
  const sweepWarmup = Math.max(sweepParams.swingLookback, sweepParams.volumePeriod) + 1
  const donchianWarmup =
    Math.max(donchianParams.channelLookback, donchianParams.volumePeriod, donchianParams.atrPeriod - 1) + 1
  const rsiWarmup = rsiParams.period + 2
  const historyShort =
    showingQuote && strategy === "ema" && quote.bars.length < emaParams.slowPeriod + 2
      ? `The slow EMA needs ${emaParams.slowPeriod} sessions. This history has ${quote.bars.length}.`
      : showingQuote && strategy === "sweep" && quote.bars.length < sweepWarmup
        ? `The sweep needs ${sweepWarmup} sessions. This history has ${quote.bars.length}.`
        : showingQuote && strategy === "donchian" && quote.bars.length < donchianWarmup
          ? `The Donchian breakout needs ${donchianWarmup} sessions. This history has ${quote.bars.length}.`
          : showingQuote && strategy === "rsi" && quote.bars.length < rsiWarmup
            ? `RSI(${rsiParams.period}) needs ${rsiWarmup} sessions before a reclaim can print. This history has ${quote.bars.length}.`
            : null
  const book = bookState(showingQuote ? summary : null)

  return (
    <TooltipProvider>
      <div className="h-0.5 bg-primary" />
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-end justify-between gap-4 px-4 py-4 lg:px-6">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-serif text-[1.85rem] leading-none tracking-tight">Northline</h1>
              <Badge variant="outline">Signals only</Badge>
            </div>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Daily signals for US and Hong Kong names. Compare the 20/50 EMA cross, a volume-confirmed sweep, a
              Donchian breakout, and an RSI reclaim on the same symbol. A US volume-versus-open-interest overlay can
              confirm or block a new entry. It is not a separate book.
            </p>
          </div>
          <p className="font-mono text-[11px] tracking-[0.16em] text-muted-foreground uppercase">No broker · no fills</p>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1440px] gap-4 px-4 py-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:px-6">
        <aside className="order-2 min-w-0 lg:order-1">
          <SidePanel
            draft={draft}
            symbol={symbol}
            symbolError={symbolError}
            strategy={strategy}
            emaParams={emaParams}
            sweepParams={sweepParams}
            donchianParams={donchianParams}
            rsiParams={rsiParams}
            summary={showingQuote ? summary : null}
            currency={quote?.currency ?? "USD"}
            notice={showingQuote ? result?.error ?? null : null}
            onDraft={setDraft}
            onSubmit={() => selectSymbol(draft)}
            onPick={selectSymbol}
            onStrategy={selectStrategy}
            onEmaParams={updateEmaParams}
            onSweepParams={updateSweepParams}
            onDonchianParams={updateDonchianParams}
            onRsiParams={updateRsiParams}
            onReset={resetParams}
          />
        </aside>

        <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          {showingQuote && lastBar && model ? (
            <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-mono text-2xl tracking-tight">{quote.symbol}</h2>
                    <Badge
                      variant={book === "Long" ? "long" : book === "Short" ? "short" : "flat"}
                      data-testid="book-state"
                    >
                      {book}
                    </Badge>
                    <Badge variant="outline" data-testid="active-strategy">
                      {STRATEGY_LABEL[strategy]}
                    </Badge>
                    {overlayDecision && overlayBadge(overlayDecision.effect) ? (
                      <Badge
                        variant={overlayBadgeVariant(overlayDecision.effect)}
                        data-testid="options-badge"
                      >
                        {overlayBadge(overlayDecision.effect)}
                      </Badge>
                    ) : null}
                    <span className="truncate text-sm text-muted-foreground">{quote.shortName}</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {quote.exchange ? `${quote.exchange} · ` : ""}
                    {quote.currency} · {quote.bars.length} sessions · {formatDate(quote.bars[0].date)} –{" "}
                    {formatDate(lastBar.date)}
                  </p>
                  <p className="mt-1 text-xs" role="status">
                    {liveState === "live" ? (
                      <span className="text-ema-fast">Live daily bars · Yahoo Finance</span>
                    ) : liveState === "loading" ? (
                      <span className="text-muted-foreground">Syncing Yahoo Finance…</span>
                    ) : (
                      <span className="text-ema-slow">
                        {quote.warning ?? "Showing the cached history shipped with Northline."}
                      </span>
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <div className="font-mono text-2xl">{formatPrice(lastBar.close, quote.currency)}</div>
                  {change != null && prevBar ? (
                    <div className={change > 0 ? "font-mono text-sm text-ema-fast" : change < 0 ? "font-mono text-sm text-stop" : "font-mono text-sm text-muted-foreground"}>
                      {formatChange(change, quote.currency)} {formatPct(change / prevBar.close)}
                    </div>
                  ) : null}
                  <div className="mt-3 flex justify-end">
                    <StrategySwitch strategy={strategy} onStrategy={selectStrategy} className="w-full max-w-[18rem]" />
                  </div>
                  <div className="mt-2 flex justify-end gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={rangeMode === "recent" ? "default" : "outline"}
                      onClick={() => {
                        setRangeMode("recent")
                        setSelectedId(null)
                      }}
                    >
                      Latest
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={rangeMode === "all" ? "default" : "outline"}
                      onClick={() => setRangeMode("all")}
                    >
                      Full history
                    </Button>
                  </div>
                </div>
              </div>
              {result?.error ? (
                <p className="border-b border-stop/40 bg-stop/10 px-4 py-2.5 text-sm text-stop" role="alert" data-testid="strategy-error">
                  {result.error}
                </p>
              ) : null}
              <div className="h-[480px] sm:h-[540px] lg:h-[600px]">
                <PriceChart model={model} />
              </div>
              <div className="border-t border-border px-4 py-2.5 text-xs leading-relaxed text-muted-foreground" data-testid="levels">
                {result?.error ? (
                  <p>{result.error}</p>
                ) : levels ? (
                  <p>
                    {levelsCaption(levels, quote.currency, levels.exitPrice == null, selected != null, strategy)}
                    {historyShort ? ` ${historyShort}` : ""}
                  </p>
                ) : (
                  <p>
                    {emptyLevels(strategy)}
                    {historyShort ? ` ${historyShort}` : ""}
                  </p>
                )}
              </div>
            </section>
          ) : (
            <section className="flex h-[540px] items-center justify-center rounded-xl border border-border bg-card px-6">
              {loadError && !showingQuote ? (
                <div className="max-w-md text-center">
                  <p className="font-serif text-3xl">No daily bars</p>
                  <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
                  <div className="mt-4 flex justify-center gap-2">
                    <Button type="button" onClick={() => selectSymbol("AAPL")}>
                      Plot AAPL
                    </Button>
                    <Button type="button" variant="outline" onClick={() => selectSymbol("0700.HK")}>
                      Plot 0700.HK
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Fetching daily bars for {symbol}…</p>
              )}
            </section>
          )}
            <OptionsOverlay
              state={optionsPanel}
              params={overlayParams}
              decision={overlayDecision}
              onParams={updateOverlay}
              onReset={() => setOverlayParams(DEFAULT_OPTIONS_OVERLAY)}
            />
          </div>

          {showingQuote && result && lastBar ? (
            <TradeBlotter
              trades={result.trades}
              currency={quote.currency}
              lastClose={lastBar.close}
              lastIndex={result.bars.length - 1}
              levelsId={levels?.id ?? null}
              strategy={strategy}
              emptyMessage={result.error ?? undefined}
              onSelect={(id) => {
                if (selectedId === id) {
                  setSelectedId(null)
                  setRangeMode("recent")
                } else {
                  setSelectedId(id)
                  setRangeMode("trade")
                }
              }}
            />
          ) : null}
        </div>
      </main>

      <footer className="mx-auto max-w-[1440px] px-4 pt-2 pb-8 text-xs leading-relaxed text-muted-foreground lg:px-6">
        <BookFootnote strategy={strategy} />
        <a
          className="underline decoration-border underline-offset-2 hover:text-foreground"
          href="https://finance.yahoo.com/"
          target="_blank"
          rel="noreferrer"
        >
          Yahoo Finance
        </a>
        . Northline does not place orders or simulate a broker fill. The volume-versus-open-interest overlay reads
        today&apos;s US chain only. A matching tilt confirms a new entry on the latest bar. A conflicting tilt removes
        that entry and does not open the other side. A volatility event, a missing chain, or a Hong Kong name leaves
        the stock book unchanged. Open trades from earlier sessions keep their stops and targets.
      </footer>
    </TooltipProvider>
  )
}
