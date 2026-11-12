"use client"

import { Badge } from "@/components/ui/badge"
import { barsHeld, formatDate, formatPct, formatPrice } from "@/lib/format"
import { EXIT_LABEL, positionReturn } from "@/lib/strategy"
import type { ExitReason, StrategyId, Trade } from "@/lib/types"
import { cn } from "@/lib/utils"

function reasonVariant(reason: ExitReason | null): "buy" | "cross" | "stop" | "target" {
  if (reason === "stop") return "stop"
  if (reason === "take_profit") return "target"
  if (reason === "ema_cross") return "cross"
  return "buy"
}

export function TradeBlotter({
  trades,
  currency,
  lastClose,
  lastIndex,
  levelsId,
  onSelect,
  strategy,
  emptyMessage,
}: {
  trades: Trade[]
  currency: string
  lastClose: number
  lastIndex: number
  levelsId: number | null
  onSelect: (id: number) => void
  strategy: StrategyId
  emptyMessage?: string
}) {
  const sweep = strategy === "sweep"
  const empty =
    emptyMessage ??
    (sweep
      ? "No volume-confirmed sweep in this window. A session has to take out the prior swing, close back through that level, and do it on at least the volume multiple."
      : "No fresh crossover in this window. The fast EMA has to finish a session at or below the slow EMA, then close above it.")
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Trade blotter</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Click a row to draw that trade’s stop and target. Returns use the signal closes, not a fill simulator.
          </p>
        </div>
      </div>
      {trades.length === 0 ? (
        <p className="px-4 py-8 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="blotter-scroll overflow-x-auto">
          <table className={cn("w-full border-collapse text-sm", sweep ? "min-w-[1080px]" : "min-w-[980px]")}>
            <caption className="sr-only">
              {sweep
                ? "Signal trades with side, entry, exit, swept level, stop, target, and close-to-close return."
                : "Signal trades with entry, exit, reason, stop, target, and close-to-close return."}
            </caption>
            <thead>
              <tr className="text-left text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                <th className="px-4 py-2 font-medium" scope="col">
                  #
                </th>
                {sweep ? (
                  <th className="px-3 py-2 font-medium" scope="col">
                    Side
                  </th>
                ) : null}
                <th className="px-3 py-2 font-medium" scope="col">
                  Entry
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  Price
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  {sweep ? "Swept" : "ATR"}
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  Stop
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  Target
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  Exit
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  Price
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  Reason
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  Return
                </th>
                <th className="px-4 py-2 text-right font-medium" scope="col">
                  Bars
                </th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => {
                const unrealized = trade.exitPrice == null
                const exitPrice = trade.exitPrice ?? lastClose
                const change = positionReturn(trade, exitPrice)
                const onChart = trade.id === levelsId
                const short = trade.direction === "short"
                return (
                  <tr
                    key={trade.id}
                    data-testid="trade-row"
                    aria-selected={onChart}
                    tabIndex={0}
                    onClick={() => onSelect(trade.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        onSelect(trade.id)
                      }
                    }}
                    className={cn(
                      "cursor-pointer border-t border-border/80 hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline-none",
                      onChart && "bg-primary/10 shadow-[inset_3px_0_0_#e4c56a]",
                    )}
                  >
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {trade.id}
                      {onChart ? <span className="ml-2 text-primary">On chart</span> : null}
                    </td>
                    {sweep ? (
                      <td className="px-3 py-2.5">
                        <Badge variant={short ? "short" : "long"}>{short ? "Short" : "Long"}</Badge>
                      </td>
                    ) : null}
                    <td className="px-3 py-2.5 font-mono text-xs">{formatDate(trade.entryDate)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{formatPrice(trade.entryPrice, currency)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {sweep
                        ? trade.sweptLevel == null
                          ? "—"
                          : formatPrice(trade.sweptLevel, currency)
                        : formatPrice(trade.atrAtEntry, currency)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-stop">{formatPrice(trade.stop, currency)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-target">
                      {formatPrice(trade.target, currency)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {trade.exitDate ? formatDate(trade.exitDate) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {trade.exitPrice == null ? "—" : formatPrice(trade.exitPrice, currency)}
                    </td>
                    <td className="px-3 py-2.5">
                      {unrealized ? (
                        <Badge variant={short ? "short" : "long"}>Open</Badge>
                      ) : (
                        <Badge variant={reasonVariant(trade.exitReason)}>
                          {trade.exitReason ? EXIT_LABEL[trade.exitReason] : "—"}
                        </Badge>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2.5 text-right font-mono",
                        change > 0 ? "text-ema-fast" : change < 0 ? "text-stop" : "text-muted-foreground",
                      )}
                    >
                      {formatPct(change)}
                      {unrealized ? <span className="ml-1 text-[10px] text-muted-foreground">open</span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {barsHeld(trade.entryIndex, trade.exitIndex, lastIndex)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
