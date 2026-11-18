"use client"

import { Info } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DEFAULT_DONCHIAN_PARAMS } from "@/lib/donchian"
import { formatPct, formatPrice } from "@/lib/format"
import { DEFAULT_RSI_PARAMS } from "@/lib/rsi"
import { DEFAULT_PARAMS } from "@/lib/strategy"
import { DEFAULT_SWEEP_PARAMS } from "@/lib/sweep"
import type { DonchianParams, RsiParams, StrategyId, StrategyParams, SweepParams, TradeSummary } from "@/lib/types"
import { cn } from "@/lib/utils"

const DEMOS = ["AAPL", "0700.HK"] as const

type FieldProps = {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}

function Field({ id, label, value, min, max, step, onChange }: FieldProps) {
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0
  const display = digits === 0 ? String(value) : value.toFixed(digits)
  // A controlled input that commits every keystroke cannot spell "10" when the
  // minimum is 2: the leading "1" is clamped before the "0" arrives. Keep the
  // in-progress text local, and commit only a number that is already in range.
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </Label>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={draft ?? display}
          onWheel={(event) => event.currentTarget.blur()}
          onBlur={() => {
            if (draft != null && draft.trim() !== "") {
              const next = Number(draft)
              if (Number.isFinite(next)) onChange(next)
            }
            setDraft(null)
          }}
          onChange={(event) => {
            const raw = event.target.value
            setDraft(raw)
            const next = event.target.valueAsNumber
            if (!Number.isFinite(next) || next < min || next > max) return
            onChange(next)
          }}
          className="h-8 w-[4.75rem] px-2 text-right font-mono text-sm"
        />
      </div>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[Math.min(max, Math.max(min, value))]}
        onValueChange={([next]) => {
          setDraft(null)
          onChange(next)
        }}
      />
    </div>
  )
}

function Stat({
  label,
  value,
  detail,
  testId,
}: {
  label: string
  value: string
  detail?: string
  testId?: string
}) {
  return (
    <div data-testid={testId}>
      <div className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 font-mono text-xl text-foreground">{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  )
}

function sameParams(a: StrategyParams, b: StrategyParams): boolean {
  return (
    a.fastPeriod === b.fastPeriod &&
    a.slowPeriod === b.slowPeriod &&
    a.atrPeriod === b.atrPeriod &&
    a.stopMultiplier === b.stopMultiplier &&
    a.takeProfitMultiplier === b.takeProfitMultiplier
  )
}

function sameSweep(a: SweepParams, b: SweepParams): boolean {
  return (
    a.swingLookback === b.swingLookback &&
    a.volumePeriod === b.volumePeriod &&
    a.volumeMultiple === b.volumeMultiple &&
    a.takeProfitMultiple === b.takeProfitMultiple &&
    a.stopOffset === b.stopOffset
  )
}

function sameDonchian(a: DonchianParams, b: DonchianParams): boolean {
  return (
    a.channelLookback === b.channelLookback &&
    a.volumePeriod === b.volumePeriod &&
    a.volumeMultiple === b.volumeMultiple &&
    a.atrPeriod === b.atrPeriod &&
    a.stopMultiplier === b.stopMultiplier &&
    a.takeProfitMultiplier === b.takeProfitMultiplier
  )
}

function sameRsi(a: RsiParams, b: RsiParams): boolean {
  return (
    a.period === b.period &&
    a.oversold === b.oversold &&
    a.overbought === b.overbought &&
    a.takeProfitMultiple === b.takeProfitMultiple &&
    a.stopOffset === b.stopOffset
  )
}

function atDefaults(
  strategy: StrategyId,
  emaParams: StrategyParams,
  sweepParams: SweepParams,
  donchianParams: DonchianParams,
  rsiParams: RsiParams,
): boolean {
  if (strategy === "sweep") return sameSweep(sweepParams, DEFAULT_SWEEP_PARAMS)
  if (strategy === "donchian") return sameDonchian(donchianParams, DEFAULT_DONCHIAN_PARAMS)
  if (strategy === "rsi") return sameRsi(rsiParams, DEFAULT_RSI_PARAMS)
  return sameParams(emaParams, DEFAULT_PARAMS)
}

export function StrategySwitch({
  strategy,
  onStrategy,
  labelled = false,
  className,
}: {
  strategy: StrategyId
  onStrategy: (strategy: StrategyId) => void
  labelled?: boolean
  className?: string
}) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-1", className)}
      role="group"
      aria-label="Strategy"
      data-testid={labelled ? "strategy-switcher" : undefined}
    >
      <Button
        type="button"
        size="sm"
        variant={strategy === "ema" ? "default" : "outline"}
        aria-pressed={strategy === "ema"}
        data-testid={labelled ? "strategy-ema" : undefined}
        onClick={() => onStrategy("ema")}
      >
        20/50 EMA
      </Button>
      <Button
        type="button"
        size="sm"
        variant={strategy === "sweep" ? "default" : "outline"}
        aria-pressed={strategy === "sweep"}
        data-testid={labelled ? "strategy-sweep" : undefined}
        onClick={() => onStrategy("sweep")}
      >
        Volume sweep
      </Button>
      <Button
        type="button"
        size="sm"
        variant={strategy === "donchian" ? "default" : "outline"}
        aria-pressed={strategy === "donchian"}
        data-testid={labelled ? "strategy-donchian" : undefined}
        onClick={() => onStrategy("donchian")}
      >
        Donchian
      </Button>
      <Button
        type="button"
        size="sm"
        variant={strategy === "rsi" ? "default" : "outline"}
        aria-pressed={strategy === "rsi"}
        data-testid={labelled ? "strategy-rsi" : undefined}
        onClick={() => onStrategy("rsi")}
      >
        RSI reclaim
      </Button>
    </div>
  )
}

export function SidePanel({
  draft,
  symbol,
  symbolError,
  strategy,
  emaParams,
  sweepParams,
  donchianParams,
  rsiParams,
  summary,
  currency,
  notice,
  onDraft,
  onSubmit,
  onPick,
  onStrategy,
  onEmaParams,
  onSweepParams,
  onDonchianParams,
  onRsiParams,
  onReset,
}: {
  draft: string
  symbol: string
  symbolError: string | null
  strategy: StrategyId
  emaParams: StrategyParams
  sweepParams: SweepParams
  donchianParams: DonchianParams
  rsiParams: RsiParams
  summary: TradeSummary | null
  currency: string
  notice: string | null
  onDraft: (value: string) => void
  onSubmit: () => void
  onPick: (symbol: string) => void
  onStrategy: (strategy: StrategyId) => void
  onEmaParams: (patch: Partial<StrategyParams>) => void
  onSweepParams: (patch: Partial<SweepParams>) => void
  onDonchianParams: (patch: Partial<DonchianParams>) => void
  onRsiParams: (patch: Partial<RsiParams>) => void
  onReset: () => void
}) {
  const winRate = summary?.winRate == null ? "—" : `${Math.round(summary.winRate * 100)}%`
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Symbol</h2>
          <div className="flex items-center gap-1.5">
            {DEMOS.map((demo) => (
              <Button
                key={demo}
                type="button"
                size="sm"
                variant={symbol === demo ? "default" : "outline"}
                onClick={() => onPick(demo)}
              >
                {demo}
              </Button>
            ))}
          </div>
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <Label htmlFor="symbol" className="sr-only">
            Ticker
          </Label>
          <Input
            id="symbol"
            value={draft}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="AAPL or 0700.HK"
            onChange={(event) => onDraft(event.target.value.toUpperCase())}
            className="min-w-0 font-mono uppercase"
          />
          <Button type="submit">Plot</Button>
        </form>
        {symbolError ? <p className="mt-2 text-xs text-stop">{symbolError}</p> : null}
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          US names and Yahoo-style Hong Kong tickers. About two years of daily bars.
        </p>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Strategy</h2>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onReset}
            disabled={atDefaults(strategy, emaParams, sweepParams, donchianParams, rsiParams)}
          >
            Reset
          </Button>
        </div>
        <StrategySwitch strategy={strategy} onStrategy={onStrategy} labelled className="mt-4" />
        {strategy === "donchian" ? (
          <div className="mt-4 space-y-4">
            <Field
              id="channel-lookback"
              label="Channel lookback"
              value={donchianParams.channelLookback}
              min={2}
              max={120}
              step={1}
              onChange={(value) => onDonchianParams({ channelLookback: value })}
            />
            <Field
              id="donchian-volume-period"
              label="Volume average"
              value={donchianParams.volumePeriod}
              min={2}
              max={120}
              step={1}
              onChange={(value) => onDonchianParams({ volumePeriod: value })}
            />
            <Field
              id="donchian-volume-multiple"
              label="Volume × average"
              value={donchianParams.volumeMultiple}
              min={1}
              max={5}
              step={0.1}
              onChange={(value) => onDonchianParams({ volumeMultiple: value })}
            />
            <Field
              id="donchian-atr"
              label="ATR period"
              value={donchianParams.atrPeriod}
              min={2}
              max={50}
              step={1}
              onChange={(value) => onDonchianParams({ atrPeriod: value })}
            />
            <Field
              id="donchian-stop"
              label="Stop × ATR"
              value={donchianParams.stopMultiplier}
              min={0.5}
              max={6}
              step={0.1}
              onChange={(value) => onDonchianParams({ stopMultiplier: value })}
            />
            <Field
              id="donchian-target"
              label="Target × ATR"
              value={donchianParams.takeProfitMultiplier}
              min={0.5}
              max={10}
              step={0.1}
              onChange={(value) => onDonchianParams({ takeProfitMultiplier: value })}
            />
          </div>
        ) : strategy === "rsi" ? (
          <div className="mt-4 space-y-4">
            <Field
              id="rsi-period"
              label="RSI period"
              value={rsiParams.period}
              min={2}
              max={50}
              step={1}
              onChange={(value) => onRsiParams({ period: value })}
            />
            <Field
              id="rsi-oversold"
              label="Oversold"
              value={rsiParams.oversold}
              min={1}
              max={Math.max(1, rsiParams.overbought - 1)}
              step={1}
              onChange={(value) => onRsiParams({ oversold: value })}
            />
            <Field
              id="rsi-overbought"
              label="Overbought"
              value={rsiParams.overbought}
              min={rsiParams.oversold + 1}
              max={99}
              step={1}
              onChange={(value) => onRsiParams({ overbought: value })}
            />
            <Field
              id="rsi-target"
              label="Target × risk"
              value={rsiParams.takeProfitMultiple}
              min={0.5}
              max={10}
              step={0.1}
              onChange={(value) => onRsiParams({ takeProfitMultiple: value })}
            />
            <Field
              id="rsi-stop-offset"
              label="Stop offset"
              value={rsiParams.stopOffset}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => onRsiParams({ stopOffset: value })}
            />
          </div>
        ) : strategy === "sweep" ? (
          <div className="mt-4 space-y-4">
            <Field
              id="swing-lookback"
              label="Swing lookback"
              value={sweepParams.swingLookback}
              min={2}
              max={60}
              step={1}
              onChange={(value) => onSweepParams({ swingLookback: value })}
            />
            <Field
              id="volume-period"
              label="Volume average"
              value={sweepParams.volumePeriod}
              min={2}
              max={120}
              step={1}
              onChange={(value) => onSweepParams({ volumePeriod: value })}
            />
            <Field
              id="volume-multiple"
              label="Volume × average"
              value={sweepParams.volumeMultiple}
              min={1}
              max={5}
              step={0.1}
              onChange={(value) => onSweepParams({ volumeMultiple: value })}
            />
            <Field
              id="risk-multiple"
              label="Target × risk"
              value={sweepParams.takeProfitMultiple}
              min={0.5}
              max={10}
              step={0.1}
              onChange={(value) => onSweepParams({ takeProfitMultiple: value })}
            />
            <Field
              id="stop-offset"
              label="Stop offset"
              value={sweepParams.stopOffset}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => onSweepParams({ stopOffset: value })}
            />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <Field
              id="fast-ema"
              label="Fast EMA"
              value={emaParams.fastPeriod}
              min={2}
              max={Math.max(2, emaParams.slowPeriod - 1)}
              step={1}
              onChange={(value) => onEmaParams({ fastPeriod: value })}
            />
            <Field
              id="slow-ema"
              label="Slow EMA"
              value={emaParams.slowPeriod}
              min={emaParams.fastPeriod + 1}
              max={250}
              step={1}
              onChange={(value) => onEmaParams({ slowPeriod: value })}
            />
            <Field
              id="atr-period"
              label="ATR period"
              value={emaParams.atrPeriod}
              min={2}
              max={50}
              step={1}
              onChange={(value) => onEmaParams({ atrPeriod: value })}
            />
            <Field
              id="stop-mult"
              label="Stop × ATR"
              value={emaParams.stopMultiplier}
              min={0.5}
              max={6}
              step={0.1}
              onChange={(value) => onEmaParams({ stopMultiplier: value })}
            />
            <Field
              id="target-mult"
              label="Target × ATR"
              value={emaParams.takeProfitMultiplier}
              min={0.5}
              max={10}
              step={0.1}
              onChange={(value) => onEmaParams({ takeProfitMultiplier: value })}
            />
          </div>
        )}
        <Separator className="my-4" />
        {strategy === "donchian" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Buy when the close finishes strictly above the prior {donchianParams.channelLookback}-session high and
            volume is at least {donchianParams.volumeMultiple.toFixed(1)}× the prior{" "}
            {donchianParams.volumePeriod}-session average. Sell is the mirror through the prior low. A touch of that
            high or low is not a breakout.
            The stop is {donchianParams.stopMultiplier.toFixed(1)}×ATR({donchianParams.atrPeriod}) from the entry close
            and the target is {donchianParams.takeProfitMultiplier.toFixed(1)}× that same ATR. A later breakout leaves
            an open trade alone. After a stop or take-profit, the next entry is a fresh breakout.
          </p>
        ) : strategy === "rsi" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Buy when Wilder RSI({rsiParams.period}) was at or below {rsiParams.oversold} on the prior close and finishes
            back above {rsiParams.oversold}. Sell when it was at or above {rsiParams.overbought} and closes back below{" "}
            {rsiParams.overbought}. A close that only touches the line does not reclaim. The stop sits{" "}
            {rsiParams.stopOffset.toFixed(2)} beyond the signal wick. The target is{" "}
            {rsiParams.takeProfitMultiple.toFixed(1)}× that risk. A bar that would qualify both sides is skipped. A
            later signal leaves an open trade alone.
          </p>
        ) : strategy === "sweep" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Buy when the low takes out the prior {sweepParams.swingLookback}-session low, volume is at least{" "}
            {sweepParams.volumeMultiple.toFixed(1)}× the prior {sweepParams.volumePeriod}-session average, and the close
            finishes back above that low. Sell is the mirror at the prior high. The stop sits{" "}
            {sweepParams.stopOffset.toFixed(2)} beyond the sweep wick. The target is{" "}
            {sweepParams.takeProfitMultiple.toFixed(1)}× that risk. A later sweep leaves an open trade alone. After a
            stop or take-profit, the next entry is a fresh sweep.
          </p>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Buy the session the {emaParams.fastPeriod}-day EMA closes above the {emaParams.slowPeriod}-day EMA, if the
            prior session finished at or below it. Exit on the first of a cross back down, a close at or below entry −{" "}
            {emaParams.stopMultiplier.toFixed(1)}×ATR({emaParams.atrPeriod}), or a close at or above entry +{" "}
            {emaParams.takeProfitMultiplier.toFixed(1)}×ATR({emaParams.atrPeriod}). Stop and target use the entry
            session’s ATR and stay fixed. After a stop or take-profit, the next buy has to be a new cross.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">This history</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label="How the stats are counted"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {strategy === "ema"
                ? "A win is a closed signal whose exit close is above the entry close. The open signal, if any, is marked unrealized and left out of the win rate."
                : "A win is a closed long whose exit close is above the entry, or a closed short whose exit close is below the entry. The open signal is unrealized and left out of the win rate."}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Stat label="Entries" value={summary ? String(summary.entries) : "—"} testId="stat-entries" />
          <Stat label="Exits" value={summary ? String(summary.exits) : "—"} testId="stat-exits" />
          <Stat
            label="Win rate"
            value={winRate}
            detail={
              summary == null ? undefined : summary.exits > 0 ? `${summary.wins} of ${summary.exits} closed` : "No closed trades"
            }
            testId="stat-win-rate"
          />
          <Stat
            label="Avg return"
            value={summary?.avgReturn == null ? "—" : formatPct(summary.avgReturn)}
            detail="Closed, close to close"
          />
        </div>
        {summary?.open && summary.unrealized != null ? (
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            <Badge variant={summary.open.direction === "short" ? "short" : "long"} className="mr-2">
              {summary.open.direction === "short" ? "Short" : "Long"}
            </Badge>
            Unrealized {formatPct(summary.unrealized)} from {formatPrice(summary.open.entryPrice, currency)} on the
            entry close.
          </p>
        ) : summary ? (
          <p className="mt-4 text-xs text-muted-foreground">
            Flat. Waiting for the next{" "}
            {strategy === "sweep"
              ? "fresh sweep"
              : strategy === "donchian"
                ? "fresh breakout"
                : strategy === "rsi"
                  ? "fresh reclaim"
                  : "fresh cross"}
            .
          </p>
        ) : notice ? (
          <p className="mt-4 text-xs leading-relaxed text-stop">{notice}</p>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">Stats appear once the daily bars load.</p>
        )}
      </section>
    </div>
  )
}
