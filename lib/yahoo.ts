import type { Bar, Quote } from "./types"
import { normalizeSymbol } from "./symbols"

type YahooPayload = {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string
        shortName?: string
        longName?: string
        currency?: string
        exchangeName?: string
        fullExchangeName?: string
        exchangeTimezoneName?: string
      }
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>
          high?: Array<number | null>
          low?: Array<number | null>
          close?: Array<number | null>
          volume?: Array<number | null>
        }>
      }
    }> | null
    error?: { description?: string } | null
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

function roundPrice(value: number): number {
  return Math.round(value * 10000) / 10000
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function barDate(epochSec: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(epochSec * 1000))
    const year = parts.find((part) => part.type === "year")?.value
    const month = parts.find((part) => part.type === "month")?.value
    const day = parts.find((part) => part.type === "day")?.value
    if (year && month && day) return `${year}-${month}-${day}`
  } catch {
    // Invalid IANA zone — fall through to UTC.
  }
  return new Date(epochSec * 1000).toISOString().slice(0, 10)
}

export function parseYahooChart(requestedSymbol: string, payload: unknown): Quote {
  const symbol = normalizeSymbol(requestedSymbol) ?? requestedSymbol
  if (!payload || typeof payload !== "object") throw new Error("Empty quote response.")

  const chart = (payload as YahooPayload).chart
  const result = chart?.result?.[0]
  const timestamps = result?.timestamp
  const quote = result?.indicators?.quote?.[0]
  if (!result || !timestamps || !quote) {
    throw new Error(chart?.error?.description || "No daily bars in the response.")
  }

  const timeZone = result.meta?.exchangeTimezoneName || "UTC"
  const byDate = new Map<string, Bar>()
  for (let index = 0; index < timestamps.length; index += 1) {
    const open = quote.open?.[index]
    const high = quote.high?.[index]
    const low = quote.low?.[index]
    const close = quote.close?.[index]
    const volume = quote.volume?.[index]
    if (!finite(open) || !finite(high) || !finite(low) || !finite(close) || high < low) continue
    const date = barDate(timestamps[index], timeZone)
    byDate.set(date, {
      date,
      open: roundPrice(open),
      high: roundPrice(high),
      low: roundPrice(low),
      close: roundPrice(close),
      volume: finite(volume) ? Math.round(volume) : 0,
    })
  }

  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (bars.length === 0) throw new Error("No daily bars in the response.")

  const metaSymbol = normalizeSymbol(result.meta?.symbol ?? symbol) ?? symbol
  return {
    symbol: metaSymbol,
    shortName: result.meta?.longName || result.meta?.shortName || metaSymbol,
    currency: result.meta?.currency || (metaSymbol.endsWith(".HK") ? "HKD" : "USD"),
    exchange: result.meta?.fullExchangeName || result.meta?.exchangeName || "",
    timezone: timeZone,
    source: "live",
    fetchedAt: new Date().toISOString(),
    bars,
  }
}

export async function fetchYahooQuote(symbol: string): Promise<Quote> {
  const normalized = normalizeSymbol(symbol)
  if (!normalized) throw new Error("Invalid symbol.")

  let lastError: Error | null = null
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(normalized)}?interval=1d&range=2y&includeAdjustedClose=true`
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(12000),
        cache: "no-store",
      })
      if (!response.ok) throw new Error(`Yahoo responded ${response.status}`)
      const payload: unknown = await response.json()
      const quote = parseYahooChart(normalized, payload)
      if (quote.bars.length < 10) throw new Error("Not enough daily bars.")
      return quote
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Yahoo request failed")
    }
  }
  throw lastError ?? new Error("Yahoo request failed")
}
