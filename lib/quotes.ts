import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Quote } from "./types"
import { normalizeSymbol } from "./symbols"
import { fetchYahooQuote } from "./yahoo"

export class QuoteError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function readCachedQuote(symbol: string): Promise<Quote | null> {
  const safe = normalizeSymbol(symbol)
  if (!safe) return null
  const file = path.join(process.cwd(), "data", `${safe}.json`)
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Quote>
    if (!parsed || !Array.isArray(parsed.bars) || parsed.bars.length < 10) return null
    return {
      symbol: safe,
      shortName: parsed.shortName || safe,
      currency: parsed.currency || (safe.endsWith(".HK") ? "HKD" : "USD"),
      exchange: parsed.exchange || "",
      timezone: parsed.timezone || "UTC",
      source: "cache",
      fetchedAt: parsed.fetchedAt || new Date(0).toISOString(),
      bars: parsed.bars,
    }
  } catch {
    return null
  }
}

export async function getQuote(input: string): Promise<Quote> {
  const symbol = normalizeSymbol(input)
  if (!symbol) throw new QuoteError(400, "Enter a ticker like AAPL or 0700.HK.")

  try {
    return await fetchYahooQuote(symbol)
  } catch {
    const cached = await readCachedQuote(symbol)
    if (cached) {
      return {
        ...cached,
        warning: "Live daily bars were unavailable, so this is the cached history shipped with Northline.",
      }
    }
    throw new QuoteError(404, `No daily history for ${symbol}. Try AAPL or 0700.HK.`)
  }
}
