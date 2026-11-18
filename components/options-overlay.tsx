"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { formatDate, formatNumber } from "@/lib/format"
import {
  DEFAULT_OPTIONS_OVERLAY,
  OVERLAY_SCOPE,
  OVERLAY_TITLE,
  formatVolumeOi,
  tiltLabel,
  type OptionsOverlayParams,
  type OptionsReading,
  type OverlayDecision,
} from "@/lib/options"

export type OptionsPanelState =
  | { status: "loading"; symbol: string }
  | { status: "skipped"; symbol: string; reason: string }
  | { status: "unavailable"; symbol: string; reason: string }
  | {
      status: "ok"
      symbol: string
      asOf: string | null
      fetchedAt: string
      contractCount: number
      reading: OptionsReading
    }

type FieldProps = {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}

function ThresholdField({ id, label, value, min, max, step, onChange }: FieldProps) {
  const digits = step < 1 ? 1 : 0
  const display = digits === 0 ? String(value) : value.toFixed(digits)
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
          className="h-8 w-[5.5rem] px-2 text-right font-mono text-sm"
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

function formatIv(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return `IV ${(value * 100).toFixed(1)}%`
}

function snapshotLine(state: Extract<OptionsPanelState, { status: "ok" }>): string {
  const when = state.asOf ? formatDate(state.asOf) : "the latest Yahoo snapshot"
  return `${formatNumber(state.contractCount, 0)} contracts · session ${when} · Yahoo Finance`
}

export function OptionsOverlay({
  state,
  params,
  decision,
  onParams,
  onReset,
}: {
  state: OptionsPanelState
  params: OptionsOverlayParams
  decision: OverlayDecision | null
  onParams: (patch: Partial<OptionsOverlayParams>) => void
  onReset: () => void
}) {
  const atDefaults =
    params.volumeOiMultiple === DEFAULT_OPTIONS_OVERLAY.volumeOiMultiple &&
    params.minVolume === DEFAULT_OPTIONS_OVERLAY.minVolume
  const reading = state.status === "ok" ? state.reading : null
  const tilt = reading?.tilt ?? "none"

  return (
    <section className="min-w-0 rounded-xl border border-border bg-card" data-testid="options-overlay">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-medium">{OVERLAY_TITLE}</h2>
          <Badge variant="outline">Today&apos;s US chain</Badge>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{OVERLAY_SCOPE}</p>
      </div>

      <div className="space-y-3 px-4 py-3">
        {state.status === "loading" ? (
          <p className="text-sm text-muted-foreground" role="status" data-testid="options-status">
            Loading today&apos;s US options chain for {state.symbol}…
          </p>
        ) : null}
        {state.status === "skipped" || state.status === "unavailable" ? (
          <p
            className={state.status === "unavailable" ? "text-sm text-stop" : "text-sm text-muted-foreground"}
            role="status"
            data-testid="options-status"
          >
            {state.reason}
          </p>
        ) : null}
        {state.status === "ok" && reading ? (
          <>
            <p className="font-mono text-[11px] text-muted-foreground" data-testid="options-snapshot">
              {snapshotLine(state)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={tilt === "bullish" ? "long" : tilt === "bearish" ? "short" : "flat"}
                data-testid="options-tilt"
              >
                {tiltLabel(tilt)}
              </Badge>
              <span className="font-mono text-[11px] text-muted-foreground">
                Calls {formatNumber(reading.callVolume, 0)} · Puts {formatNumber(reading.putVolume, 0)}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground" data-testid="options-note">
              {decision
                ? decision.note
                : "The stock book is not loaded yet, so this chain is not applied to an entry."}
            </p>
          </>
        ) : null}

        <div className="space-y-3 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Thresholds</h3>
            <Button type="button" size="sm" variant="ghost" onClick={onReset} disabled={atDefaults}>
              Reset
            </Button>
          </div>
          <ThresholdField
            id="oi-multiple"
            label="Volume ≥ × open interest"
            value={params.volumeOiMultiple}
            min={1}
            max={10}
            step={0.1}
            onChange={(value) => onParams({ volumeOiMultiple: value })}
          />
          <ThresholdField
            id="oi-min-volume"
            label="Minimum volume"
            value={params.minVolume}
            min={0}
            max={10000}
            step={100}
            onChange={(value) => onParams({ minVolume: value })}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Both have to hold. A reported open interest of 0 still passes the multiple once volume clears the floor.
            Missing volume or open interest is dropped, not filled in as zero.
            {state.status === "ok"
              ? ""
              : " These controls wait for a US chain. They do not invent a print for this symbol."}
          </p>
        </div>
      </div>

      {reading ? (
        reading.flagged.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground" data-testid="options-flags">
            No contract cleared both thresholds.
          </p>
        ) : (
          <ul
            className="blotter-scroll max-h-[28rem] overflow-auto border-t border-border"
            data-testid="options-flags"
            aria-label="Flagged option contracts"
          >
            {reading.flagged.map((contract) => {
              const iv = formatIv(contract.impliedVolatility)
              return (
                <li
                  key={contract.contractSymbol}
                  className="border-b border-border/80 px-4 py-2.5 last:border-b-0"
                  data-testid="options-flag"
                  data-right={contract.right}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={contract.right === "call" ? "long" : "short"}>
                        {contract.right === "call" ? "Call" : "Put"}
                      </Badge>
                      <span className="font-mono text-sm">{formatNumber(contract.strike, contract.strike >= 1 ? 2 : 4)}</span>
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">{formatDate(contract.expiry)}</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    Vol {formatNumber(contract.volume, 0)} · OI {formatNumber(contract.openInterest, 0)} · Vol/OI{" "}
                    {formatVolumeOi(contract.volume, contract.openInterest)}
                    {iv ? ` · ${iv}` : ""}
                  </p>
                </li>
              )
            })}
          </ul>
        )
      ) : null}
    </section>
  )
}
