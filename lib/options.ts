import type { SignalMarker, SignalResult, Trade } from "./types"
import { normalizeSymbol } from "./symbols"

/**
 * US options volume-versus-open-interest overlay.
 *
 * This is not a fifth strategy and not an options book. It never opens a
 * stock trade by itself, and it does not change the stop or target math of
 * the 20/50 EMA, volume sweep, Donchian, or RSI books.
 *
 * The chain is today's US snapshot only. There is no 20-session baseline and
 * no unusual-flow test. Hong Kong names are skipped before any chain is read.
 *
 * Flag. A contract is one strike + expiry + call/put. It flags only when
 * both thresholds hold: volume is greater than zero, volume is at least
 * `minVolume` (default 1,000), and volume is at least `volumeOiMultiple`
 * times open interest (default 2). The multiple comparison allows 1e-9 of
 * absolute slack so an exact multiple is not rejected by binary dust. Missing
 * volume or missing open interest is not coerced to zero. Open interest that
 * the feed reports as 0 is real input: volume is then at least 2× zero, so
 * the contract can flag once it clears the floor.
 *
 * Tilt. Computed on the flagged set only. Unflagged contracts do not
 * contribute volume.
 * - Flagged call volume > 0 and flagged put volume === 0 → bullish
 *   (net call volume).
 * - Flagged put volume > 0 and flagged call volume === 0 → bearish
 *   (net put volume).
 * - Both flagged call volume and flagged put volume > 0 → volatility.
 *   Both sides lit up, even if one side is larger. Not directional.
 * - Otherwise → no tilt.
 *
 * Confirm / veto. Applied only to a fresh entry: an open trade whose entry
 * bar is the latest bar. A matching tilt confirms it (the trade, stop, and
 * target stay; the desk badges the entry). A conflicting tilt vetoes it
 * (that entry and its entry marker are removed; no opposite stock trade is
 * opened). A volatility event is shown and does not confirm or veto. No
 * tilt, a missing chain, or a skipped chain leaves the strategy book
 * untouched. An open trade entered on an earlier bar is left alone in every
 * case: its stop, target, and exit are not rewritten.
 */

export type OptionRight = "call" | "put"

export type OptionContract = {
  contractSymbol: string
  right: OptionRight
  strike: number
  expiry: string
  volume: number
  openInterest: number
  impliedVolatility: number | null
}

export type OptionsOverlayParams = {
  /** Volume must be at least this multiple of open interest. Default 2. */
  volumeOiMultiple: number
  /** Minimum volume, in contracts. Default 1,000. */
  minVolume: number
}

export const DEFAULT_OPTIONS_OVERLAY: OptionsOverlayParams = {
  volumeOiMultiple: 2,
  minVolume: 1000,
}

/** Absolute slack so an exact 2× print is not dropped by float dust. */
const RATIO_SLACK = 1e-9

export const OVERLAY_TITLE = "Volume vs open interest"

export const OVERLAY_SCOPE =
  "Today's US chain only. This is volume versus open interest, not unusual flow and not a separate trading book."

export const OPTIONS_UNAVAILABLE =
  "The options chain was unavailable, so the overlay is skipped and the stock signals are unchanged."

export type OptionsTilt = "bullish" | "bearish" | "volatility" | "none"

export type FlaggedContract = OptionContract & {
  /** volume / open interest. Infinity when reported open interest is 0. */
  volumeOi: number
}

export type OptionsReading = {
  params: OptionsOverlayParams
  flagged: FlaggedContract[]
  callVolume: number
  putVolume: number
  tilt: OptionsTilt
}

export type OverlayEffect =
  | "confirmed-long"
  | "confirmed-short"
  | "vetoed-long"
  | "vetoed-short"
  | "volatility"
  | "open-left-alone"
  | "no-entry"
  | "no-flag"

export type OverlayDecision = {
  effect: OverlayEffect
  tilt: OptionsTilt
  vetoedTradeIds: number[]
  note: string
}

export type OverlayApplication = {
  result: SignalResult
  decision: OverlayDecision
}

export type OptionsAccess =
  | { kind: "us"; symbol: string }
  | { kind: "hk"; symbol: string; reason: string }
  | { kind: "invalid"; reason: string }

export function hongKongSkipReason(symbol: string): string {
  return `Hong Kong names are skipped. Northline does not invent options prints for ${symbol}.`
}

export function optionsAccess(input: string): OptionsAccess {
  const symbol = normalizeSymbol(input)
  if (!symbol) return { kind: "invalid", reason: "Enter a ticker like AAPL or 0700.HK." }
  if (symbol.endsWith(".HK")) return { kind: "hk", symbol, reason: hongKongSkipReason(symbol) }
  return { kind: "us", symbol }
}

/**
 * Both thresholds are required. Volume of 0 never flags. Non-finite volume
 * or open interest never flags, including a missing print passed through as
 * NaN. A non-positive multiple or a negative floor flags nothing.
 */
export function contractFlagged(
  contract: { volume: number; openInterest: number },
  params: OptionsOverlayParams,
): boolean {
  const { volume, openInterest } = contract
  if (!Number.isFinite(volume) || !Number.isFinite(openInterest)) return false
  if (volume <= 0 || openInterest < 0) return false
  if (!Number.isFinite(params.minVolume) || !Number.isFinite(params.volumeOiMultiple)) return false
  if (params.minVolume < 0 || params.volumeOiMultiple <= 0) return false
  if (volume + RATIO_SLACK < params.minVolume) return false
  return volume + RATIO_SLACK >= params.volumeOiMultiple * openInterest
}

export function formatVolumeOi(volume: number, openInterest: number): string {
  if (!Number.isFinite(volume) || !Number.isFinite(openInterest) || openInterest < 0) return "—"
  if (openInterest === 0) return "∞"
  const ratio = volume / openInterest
  return Number.isFinite(ratio) ? ratio.toFixed(2) : "—"
}

export function readOptionsOverlay(
  contracts: OptionContract[],
  params: OptionsOverlayParams = DEFAULT_OPTIONS_OVERLAY,
): OptionsReading {
  const flagged: FlaggedContract[] = []
  for (const contract of contracts) {
    if (contract.right !== "call" && contract.right !== "put") continue
    if (!contractFlagged(contract, params)) continue
    flagged.push({
      ...contract,
      volumeOi: contract.openInterest === 0 ? Number.POSITIVE_INFINITY : contract.volume / contract.openInterest,
    })
  }
  flagged.sort(
    (a, b) =>
      b.volume - a.volume ||
      a.expiry.localeCompare(b.expiry) ||
      a.strike - b.strike ||
      (a.right === b.right ? 0 : a.right === "call" ? -1 : 1),
  )

  let callVolume = 0
  let putVolume = 0
  for (const contract of flagged) {
    if (contract.right === "call") callVolume += contract.volume
    else putVolume += contract.volume
  }

  let tilt: OptionsTilt = "none"
  if (callVolume > 0 && putVolume > 0) tilt = "volatility"
  else if (callVolume > 0) tilt = "bullish"
  else if (putVolume > 0) tilt = "bearish"

  return { params, flagged, callVolume, putVolume, tilt }
}

export function tiltLabel(tilt: OptionsTilt): string {
  if (tilt === "bullish") return "Call tilt"
  if (tilt === "bearish") return "Put tilt"
  if (tilt === "volatility") return "Both sides"
  return "No flag"
}

/** Short chart badge. Null when the overlay is not confirming, blocking, or flagging volatility. */
export function overlayBadge(effect: OverlayEffect): string | null {
  if (effect === "confirmed-long") return "OI confirms long"
  if (effect === "confirmed-short") return "OI confirms short"
  if (effect === "vetoed-long") return "OI blocks long"
  if (effect === "vetoed-short") return "OI blocks short"
  if (effect === "volatility") return "OI volatility"
  return null
}

function effectNote(effect: OverlayEffect): string {
  switch (effect) {
    case "confirmed-long":
      return "Bullish call tilt confirms the new long. The entry stays, with the same stop and target. The overlay does not open a trade on its own."
    case "confirmed-short":
      return "Bearish put tilt confirms the new short. The entry stays, with the same stop and target. The overlay does not open a trade on its own."
    case "vetoed-long":
      return "Bearish put tilt blocks the new long. That entry is removed. Earlier open trades keep their stops and targets, and the overlay does not open a short."
    case "vetoed-short":
      return "Bullish call tilt blocks the new short. That entry is removed. Earlier open trades keep their stops and targets, and the overlay does not open a long."
    case "volatility":
      return "Calls and puts both lit up. This is a volatility event, not a bullish or bearish confirm or veto. Stock signals are unchanged."
    case "open-left-alone":
      return "An earlier session already opened this trade. The overlay leaves it alone and does not change its stop or target."
    case "no-entry":
      return "No new stock entry on the latest bar. The overlay does not open a trade by itself."
    case "no-flag":
      return "No contract passed both thresholds. Stock signals are unchanged."
  }
}

function tradeSide(trade: Trade): "long" | "short" {
  return trade.direction === "short" ? "short" : "long"
}

/** Open trade that the strategy entered on the latest bar. */
function freshEntries(result: SignalResult): Trade[] {
  const lastIndex = result.bars.length - 1
  if (lastIndex < 0) return []
  return result.trades.filter((trade) => trade.entryIndex === lastIndex && trade.exitIndex == null)
}

function conflicts(tilt: OptionsTilt, side: "long" | "short"): boolean {
  return (tilt === "bullish" && side === "short") || (tilt === "bearish" && side === "long")
}

function decision(effect: OverlayEffect, tilt: OptionsTilt, vetoedTradeIds: number[]): OverlayDecision {
  return { effect, tilt, vetoedTradeIds, note: effectNote(effect) }
}

/**
 * Apply confirm/veto to a strategy book.
 * Returns the same `result` reference whenever the book is not vetoed, so a
 * confirmation, a volatility event, or a missing directional conflict cannot
 * rewrite stops, targets, or markers.
 */
export function applyOptionsOverlay(result: SignalResult, reading: OptionsReading): OverlayApplication {
  const tilt = reading.tilt
  if (tilt === "none") return { result, decision: decision("no-flag", tilt, []) }
  if (tilt === "volatility") return { result, decision: decision("volatility", tilt, []) }

  const fresh = freshEntries(result)
  if (fresh.length === 0) {
    const openEarlier = result.trades.some((trade) => trade.exitIndex == null)
    return { result, decision: decision(openEarlier ? "open-left-alone" : "no-entry", tilt, []) }
  }

  const vetoed = fresh.filter((trade) => conflicts(tilt, tradeSide(trade)))
  if (vetoed.length === 0) {
    const effect = tradeSide(fresh[0]) === "short" ? "confirmed-short" : "confirmed-long"
    return { result, decision: decision(effect, tilt, []) }
  }

  const vetoedIds = new Set(vetoed.map((trade) => trade.id))
  const vetoedDates = new Set(vetoed.map((trade) => trade.entryDate))
  const trades = result.trades.filter((trade) => !vetoedIds.has(trade.id))
  const markers: SignalMarker[] = result.markers.filter(
    (marker) => !(marker.side === "entry" && vetoedDates.has(marker.date)),
  )
  const levelsTrade =
    result.levelsTrade && vetoedIds.has(result.levelsTrade.id)
      ? trades.length > 0
        ? trades[trades.length - 1]
        : null
      : result.levelsTrade

  return {
    result: { ...result, trades, markers, levelsTrade },
    decision: decision(tradeSide(vetoed[0]) === "short" ? "vetoed-short" : "vetoed-long", tilt, vetoed.map((trade) => trade.id)),
  }
}

/**
 * Missing or skipped overlay: the strategy result is returned unchanged.
 * Callers pass null when the chain was not loaded, failed, or was skipped
 * (including every Hong Kong name). That must not invent a flag.
 */
export function stockBookWithOverlay(result: SignalResult, reading: OptionsReading | null): OverlayApplication | { result: SignalResult; decision: null } {
  if (!reading) return { result, decision: null }
  return applyOptionsOverlay(result, reading)
}
