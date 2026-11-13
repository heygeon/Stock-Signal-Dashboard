"use client"

import { useEffect, useRef, useState } from "react"
import { COLORS } from "@/lib/colors"
import { formatNumber } from "@/lib/format"
import type { EnrichedBar, RangeMode, SignalMarker, StrategyId, Trade } from "@/lib/types"

export type ChartModel = {
  symbol: string
  bars: EnrichedBar[]
  markers: SignalMarker[]
  levels: Trade | null
  fastPeriod: number
  slowPeriod: number
  rangeMode: RangeMode
  focus: Trade | null
  strategy: StrategyId
}

function markerColor(marker: SignalMarker): string {
  // Entry arrows sit on teal candles, so the label uses the paper tone instead of the EMA color.
  if (marker.side === "entry") return "#f4efe2"
  if (marker.reason === "stop") return COLORS.stop
  if (marker.reason === "take_profit") return COLORS.target
  return "#ffd27a"
}

function markerAppearance(marker: SignalMarker, strategy: StrategyId): {
  position: "aboveBar" | "belowBar"
  shape: "arrowUp" | "arrowDown"
  color: string
} {
  // The EMA book is long-only. Keep every label above the candle, as before.
  if (strategy !== "sweep") {
    return {
      position: "aboveBar",
      shape: marker.side === "entry" ? "arrowUp" : "arrowDown",
      color: markerColor(marker),
    }
  }
  const short = marker.direction === "short"
  if (marker.side === "entry") {
    return {
      position: short ? "aboveBar" : "belowBar",
      shape: short ? "arrowDown" : "arrowUp",
      color: "#f4efe2",
    }
  }
  // A short exit is a cover: arrow back up, under the bar. Long exits point down.
  return {
    position: short ? "belowBar" : "aboveBar",
    shape: short ? "arrowUp" : "arrowDown",
    color: markerColor(marker),
  }
}

function visibleLogicalRange(model: ChartModel): { from: number; to: number } {
  const last = model.bars.length - 1
  const trade = model.rangeMode === "trade" && model.focus ? model.focus : model.levels
  if (!trade) return { from: Math.max(0, last - 160), to: last }

  if (model.rangeMode === "trade") {
    const end = trade.exitIndex ?? last
    let from = trade.entryIndex - 16
    let to = trade.exitIndex == null ? last : end + 20
    if (to - from < 80) {
      from -= (80 - (to - from)) / 2
    }
    if (to - from > 200) from = to - 200
    from = Math.max(0, from)
    to = Math.min(last, Math.max(to, from + 40))
    return { from, to }
  }

  // Default view keeps the latest close on screen and still includes the
  // level trade when that trade is inside the last nine months or so.
  // A short lead-in keeps the entry label on screen without clipping the previous exit.
  const from = last - trade.entryIndex > 200 ? last - 170 : Math.max(0, trade.entryIndex - 12)
  return { from, to: last }
}

function latestValue(bars: EnrichedBar[], key: "emaFast" | "emaSlow"): number | null {
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const value = bars[index][key]
    if (value != null) return value
  }
  return null
}

function Legend({ model }: { model: ChartModel }) {
  const fast = latestValue(model.bars, "emaFast")
  const slow = latestValue(model.bars, "emaSlow")
  return (
    <div
      className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[calc(100%-5rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card/90 px-3 py-2 text-[11px] text-foreground"
      data-testid="legend"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="flex gap-0.5">
          <span className="h-2.5 w-1.5 rounded-[1px] bg-ema-fast" />
          <span className="h-2.5 w-1.5 rounded-[1px] bg-stop" />
        </span>
        Price
      </span>
      {model.strategy === "sweep" ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-4 border-t border-dotted border-swept" />
          Swept
        </span>
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-ema-fast" />
            EMA {model.fastPeriod}
            {fast != null ? <span className="font-mono text-muted-foreground">{formatNumber(fast)}</span> : null}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-ema-slow" />
            EMA {model.slowPeriod}
            {slow != null ? <span className="font-mono text-muted-foreground">{formatNumber(slow)}</span> : null}
          </span>
        </>
      )}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-4 border-t border-dashed border-stop" />
        Stop
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-4 border-t border-dashed border-target" />
        Target
      </span>
    </div>
  )
}

export function PriceChart({ model }: { model: ChartModel }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef(model)
  const applyRef = useRef<(() => void) | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let frame = 0
    let removeChart = () => {}

    ;(async () => {
      try {
        const lc = await import("lightweight-charts")
        if (disposed) return
        const chart = lc.createChart(container, {
          autoSize: true,
          layout: {
            background: { type: lc.ColorType.Solid, color: COLORS.card },
            textColor: COLORS.muted,
            fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
            fontSize: 11,
          },
          grid: {
            vertLines: { color: COLORS.gridVertical },
            horzLines: { color: COLORS.grid },
          },
          rightPriceScale: {
            borderColor: COLORS.border,
            scaleMargins: { top: 0.14, bottom: 0.18 },
          },
          timeScale: {
            borderColor: COLORS.border,
            rightOffset: 6,
          },
          crosshair: {
            vertLine: { color: "rgba(235,230,220,0.28)", labelBackgroundColor: "#243140" },
            horzLine: { color: "rgba(235,230,220,0.28)", labelBackgroundColor: "#243140" },
          },
        })
        const candles = chart.addSeries(lc.CandlestickSeries, {
          upColor: COLORS.candleUp,
          downColor: COLORS.candleDown,
          borderUpColor: COLORS.wickUp,
          borderDownColor: COLORS.wickDown,
          wickUpColor: COLORS.wickUp,
          wickDownColor: COLORS.wickDown,
          priceLineVisible: false,
          lastValueVisible: true,
        })
        const slow = chart.addSeries(lc.LineSeries, {
          color: COLORS.emaSlow,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        })
        const fast = chart.addSeries(lc.LineSeries, {
          color: COLORS.emaFast,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        })
        const markers = lc.createSeriesMarkers(candles, [])
        let stopLine: ReturnType<typeof candles.createPriceLine> | null = null
        let targetLine: ReturnType<typeof candles.createPriceLine> | null = null
        let sweptLine: ReturnType<typeof candles.createPriceLine> | null = null

        const apply = () => {
          if (disposed) return
          const current = modelRef.current
          if (current.bars.length === 0) return
          const digits = Math.abs(current.bars[current.bars.length - 1].close) >= 1 ? 2 : 4
          const format = (price: number) => formatNumber(price, digits)
          chart.applyOptions({ localization: { priceFormatter: format } })
          candles.applyOptions({
            priceFormat: { type: "price", precision: digits, minMove: digits === 2 ? 0.01 : 0.0001 },
          })
          const showEma = current.strategy !== "sweep"
          fast.applyOptions({ title: showEma ? `EMA ${current.fastPeriod}` : "", visible: showEma })
          slow.applyOptions({ title: showEma ? `EMA ${current.slowPeriod}` : "", visible: showEma })
          candles.setData(
            current.bars.map((bar) => ({
              time: bar.date,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
            })),
          )
          fast.setData(
            current.bars.flatMap((bar) => (bar.emaFast == null ? [] : [{ time: bar.date, value: bar.emaFast }])),
          )
          slow.setData(
            current.bars.flatMap((bar) => (bar.emaSlow == null ? [] : [{ time: bar.date, value: bar.emaSlow }])),
          )
          markers.setMarkers(
            current.markers
              .slice()
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((marker) => {
                const appearance = markerAppearance(marker, current.strategy)
                return {
                  time: marker.date,
                  position: appearance.position,
                  shape: appearance.shape,
                  color: appearance.color,
                  text: marker.label,
                  size: 2,
                }
              }),
          )
          if (stopLine) {
            candles.removePriceLine(stopLine)
            stopLine = null
          }
          if (targetLine) {
            candles.removePriceLine(targetLine)
            targetLine = null
          }
          if (sweptLine) {
            candles.removePriceLine(sweptLine)
            sweptLine = null
          }
          const levels = current.levels
          if (
            current.strategy === "sweep" &&
            levels?.sweptLevel != null &&
            Number.isFinite(levels.sweptLevel)
          ) {
            sweptLine = candles.createPriceLine({
              price: levels.sweptLevel,
              color: COLORS.swept,
              lineWidth: 1,
              lineStyle: lc.LineStyle.Dotted,
              axisLabelVisible: true,
              title: "Swept",
              axisLabelTextColor: COLORS.labelInk,
            })
          }
          if (levels && Number.isFinite(levels.stop) && Number.isFinite(levels.target)) {
            stopLine = candles.createPriceLine({
              price: levels.stop,
              color: COLORS.stop,
              lineWidth: 1,
              lineStyle: lc.LineStyle.Dashed,
              axisLabelVisible: true,
              title: "Stop",
              axisLabelTextColor: COLORS.labelInk,
            })
            targetLine = candles.createPriceLine({
              price: levels.target,
              color: COLORS.target,
              lineWidth: 1,
              lineStyle: lc.LineStyle.LargeDashed,
              axisLabelVisible: true,
              title: "Target",
              axisLabelTextColor: COLORS.labelInk,
            })
          }

          const reveal = () => {
            if (disposed) return
            if (current.rangeMode === "all") {
              chart.timeScale().fitContent()
              return
            }
            chart.timeScale().setVisibleLogicalRange(visibleLogicalRange(current))
          }
          reveal()
          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(reveal)
        }

        applyRef.current = apply
        removeChart = () => {
          chart.remove()
        }
        apply()
        if (!disposed) setError(null)
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : "Chart failed to draw.")
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      applyRef.current = null
      removeChart()
    }
  }, [])

  useEffect(() => {
    modelRef.current = model
    applyRef.current?.()
  }, [model])

  return (
    <div className="relative h-full min-h-[420px]">
      <div ref={containerRef} className="absolute inset-0" data-testid="chart" />
      <Legend model={model} />
      {error ? (
        <p className="absolute inset-x-4 bottom-4 rounded-md border border-stop/40 bg-card px-3 py-2 text-sm text-stop">
          {error}
        </p>
      ) : null}
    </div>
  )
}
