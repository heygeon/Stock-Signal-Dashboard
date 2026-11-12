"use client"

import { useEffect, useMemo, useState } from "react"
import { PriceChart, type ChartModel } from "@/components/price-chart"
import { SidePanel } from "@/components/side-panel"
import { TradeBlotter } from "@/components/trade-blotter"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { BUNDLED_QUOTES } from "@/lib/bundled"
import { formatChange, formatDate, formatPct, formatPrice } from "@/lib/format"
import { DEFAULT_PARAMS, generateSignals, summarizeTrades } from "@/lib/strategy"
import { normalizeSymbol } from "@/lib/symbols"
import type { Quote, RangeMode, StrategyParams, Trade } from "@/lib/types"

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

function levelsCaption(trade: Trade, currency: string, isOpen: boolean, selected: boolean): string {
  const which = selected ? `Trade ${trade.id}` : isOpen ? "Open position" : "Most recent trade"
  return `${which} · entered ${formatDate(trade.entryDate)} at ${formatPrice(trade.entryPrice, currency)} · stop ${formatPrice(trade.stop, currency)} · target ${formatPrice(trade.target, currency)} · entry ATR ${formatPrice(trade.atrAtEntry, currency)}`
}

export function Dashboard() {
  const [symbol, setSymbol] = useState("AAPL")
  const [draft, setDraft] = useState("AAPL")
  const [symbolError, setSymbolError] = useState<string | null>(null)
  const [quote, setQuote] = useState<Quote | null>(BUNDLED_QUOTES.AAPL)
  const [liveState, setLiveState] = useState<LiveState>("loading")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [params, setParams] = useState<StrategyParams>(DEFAULT_PARAMS)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [rangeMode, setRangeMode] = useState<RangeMode>("recent")

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
    document.title = `${symbol} signals · Northline`
  }, [symbol])

  const result = useMemo(() => (quote ? generateSignals(quote.bars, params) : null), [quote, params])
  const summary = useMemo(() => {
    if (!result || !quote || quote.bars.length === 0) return null
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
      fastPeriod: params.fastPeriod,
      slowPeriod: params.slowPeriod,
      rangeMode,
      focus: rangeMode === "trade" ? picked : null,
    }
  }, [quote, result, selectedId, params.fastPeriod, params.slowPeriod, rangeMode])

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

  function updateParams(patch: Partial<StrategyParams>) {
    setParams((current) => sanitizeParams(current, patch))
    setSelectedId(null)
    setRangeMode("recent")
  }

  const lastBar = quote && quote.bars.length > 0 ? quote.bars[quote.bars.length - 1] : null
  const prevBar = quote && quote.bars.length > 1 ? quote.bars[quote.bars.length - 2] : null
  const change = lastBar && prevBar ? lastBar.close - prevBar.close : null
  const showingQuote = quote && quote.symbol === symbol
  const historyShort =
    showingQuote && quote.bars.length < params.slowPeriod + 2
      ? `The slow EMA needs ${params.slowPeriod} sessions. This history has ${quote.bars.length}.`
      : null

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
              Daily EMA crossover desk for US and Hong Kong names. Entries, stops, and targets — never an order.
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
            params={params}
            summary={showingQuote ? summary : null}
            currency={quote?.currency ?? "USD"}
            onDraft={setDraft}
            onSubmit={() => selectSymbol(draft)}
            onPick={selectSymbol}
            onParams={updateParams}
            onReset={() => {
              setParams(DEFAULT_PARAMS)
              setSelectedId(null)
              setRangeMode("recent")
            }}
          />
        </aside>

        <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
          {showingQuote && lastBar && model ? (
            <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-mono text-2xl tracking-tight">{quote.symbol}</h2>
                    <Badge variant={summary?.open ? "long" : "flat"}>{summary?.open ? "Long" : "Flat"}</Badge>
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
              <div className="h-[480px] sm:h-[540px] lg:h-[600px]">
                <PriceChart model={model} />
              </div>
              <div className="border-t border-border px-4 py-2.5 text-xs leading-relaxed text-muted-foreground" data-testid="levels">
                {levels ? (
                  <p>
                    {levelsCaption(levels, quote.currency, levels.exitPrice == null, selected != null)}
                    {historyShort ? ` ${historyShort}` : ""}
                  </p>
                ) : (
                  <p>
                    No trade in this window, so there is no stop or target to draw.
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

          {showingQuote && result && lastBar ? (
            <TradeBlotter
              trades={result.trades}
              currency={quote.currency}
              lastClose={lastBar.close}
              lastIndex={result.bars.length - 1}
              levelsId={levels?.id ?? null}
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
        Signals are judged on the daily close. A wick through the stop or target does not exit. Same-day conflicts
        resolve in order: EMA cross, then stop, then take-profit. Prices come from{" "}
        <a
          className="underline decoration-border underline-offset-2 hover:text-foreground"
          href="https://finance.yahoo.com/"
          target="_blank"
          rel="noreferrer"
        >
          Yahoo Finance
        </a>
        . Northline does not place orders or simulate a broker fill.
      </footer>
    </TooltipProvider>
  )
}
