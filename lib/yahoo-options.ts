import { barDate } from "./yahoo"
import { normalizeSymbol } from "./symbols"
import {
  OPTIONS_UNAVAILABLE,
  hongKongSkipReason,
  optionsAccess,
  type OptionContract,
  type OptionRight,
} from "./options"

/**
 * Today's US options chain from Yahoo Finance.
 *
 * The daily chart route can call `/v8/finance/chart` with a browser user
 * agent and no session. `/v7/finance/options` rejects that: it wants the
 * cookie from `fc.yahoo.com` and the crumb from `/v1/test/getcrumb`. This
 * module does that handshake, then uses the same two Yahoo hosts and the
 * same 12s timeout as the quote fetch. Contracts are whatever Yahoo returns.
 * Nothing here fills in volume or open interest.
 *
 * A successful chain is kept in memory for five minutes so the desk does not
 * refetch every expiry on each slider tick. The thresholds themselves are
 * applied in the browser, against this snapshot.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

const SUCCESS_TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 20 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000
const MAX_CACHE = 8

type YahooContract = {
  contractSymbol?: string
  strike?: number
  expiration?: number
  volume?: number | null
  openInterest?: number | null
  impliedVolatility?: number | null
}

type YahooOptionsPayload = {
  optionChain?: {
    result?: Array<{
      underlyingSymbol?: string
      expirationDates?: number[]
      quote?: {
        regularMarketTime?: number
        exchangeTimezoneName?: string
        market?: string
      }
      options?: Array<{
        expirationDate?: number
        calls?: YahooContract[]
        puts?: YahooContract[]
      }>
    }> | null
    error?: { description?: string } | null
  }
}

export class OptionsSkipped extends Error {
  symbol: string

  constructor(symbol: string, message: string) {
    super(message)
    this.name = "OptionsSkipped"
    this.symbol = symbol
  }
}

export type ParsedOptionsChain = {
  symbol: string
  asOf: string | null
  market: string | null
  contracts: OptionContract[]
}

type OptionsBody =
  | {
      status: "ok"
      symbol: string
      asOf: string | null
      fetchedAt: string
      source: "live"
      contracts: OptionContract[]
    }
  | { status: "skipped"; symbol: string; reason: string }
  | { status: "unavailable"; symbol: string; reason: string }

export type OptionsChainResult = { httpStatus: number; body: OptionsBody }

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function roundStrike(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** Yahoo's expiration unix time is midnight UTC on the expiry date. */
export function expirationDate(epochSec: number): string | null {
  if (!Number.isFinite(epochSec)) return null
  const iso = new Date(epochSec * 1000).toISOString()
  const date = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function contractFrom(raw: YahooContract, right: OptionRight, groupExpiry: number | undefined): OptionContract | null {
  if (!finiteNonNegative(raw.volume) || !finiteNonNegative(raw.openInterest)) return null
  if (!finiteNonNegative(raw.strike) || raw.strike <= 0) return null
  const expiry = expirationDate(raw.expiration ?? groupExpiry ?? Number.NaN)
  if (!expiry) return null
  const strike = roundStrike(raw.strike)
  const contractSymbol = raw.contractSymbol?.trim() || `${right}-${expiry}-${strike}`
  const impliedVolatility = finiteNonNegative(raw.impliedVolatility) ? raw.impliedVolatility : null
  return {
    contractSymbol,
    right,
    strike,
    expiry,
    volume: Math.round(raw.volume),
    openInterest: Math.round(raw.openInterest),
    impliedVolatility,
  }
}

export function parseYahooOptionsChain(requestedSymbol: string, payload: unknown): ParsedOptionsChain {
  const requested = normalizeSymbol(requestedSymbol) ?? requestedSymbol
  if (!payload || typeof payload !== "object") throw new Error("Empty options response.")
  const optionChain = (payload as YahooOptionsPayload).optionChain
  const result = optionChain?.result?.[0]
  if (!result) throw new Error(optionChain?.error?.description || "No options chain in the response.")

  const echoed = normalizeSymbol(result.underlyingSymbol ?? requested) ?? requested
  const timeZone = result.quote?.exchangeTimezoneName || "America/New_York"
  const asOf =
    typeof result.quote?.regularMarketTime === "number"
      ? barDate(result.quote.regularMarketTime, timeZone)
      : null

  const contracts: OptionContract[] = []
  for (const group of result.options ?? []) {
    const sides: Array<[OptionRight, YahooContract[] | undefined]> = [
      ["call", group.calls],
      ["put", group.puts],
    ]
    for (const [right, rows] of sides) {
      for (const row of rows ?? []) {
        const contract = contractFrom(row, right, group.expirationDate)
        if (contract) contracts.push(contract)
      }
    }
  }

  return {
    symbol: echoed,
    asOf,
    market: result.quote?.market ?? null,
    contracts,
  }
}

export function expirationTimestamps(payload: unknown): number[] {
  if (!payload || typeof payload !== "object") return []
  const dates = (payload as YahooOptionsPayload).optionChain?.result?.[0]?.expirationDates
  if (!Array.isArray(dates)) return []
  return dates.filter((date): date is number => typeof date === "number" && Number.isFinite(date))
}

export function mergeYahooOptionsPayloads(requestedSymbol: string, payloads: unknown[]): ParsedOptionsChain {
  if (payloads.length === 0) throw new Error("Empty options response.")
  const parsed = payloads.map((payload) => parseYahooOptionsChain(requestedSymbol, payload))
  const contracts = new Map<string, OptionContract>()
  for (const chain of parsed) {
    for (const contract of chain.contracts) {
      if (!contracts.has(contract.contractSymbol)) contracts.set(contract.contractSymbol, contract)
    }
  }
  const withAsOf = parsed.find((chain) => chain.asOf)
  return {
    symbol: parsed[0].symbol,
    asOf: withAsOf?.asOf ?? parsed[0].asOf,
    market: parsed[0].market,
    contracts: [...contracts.values()],
  }
}

type YahooSession = { cookie: string; crumb: string; expires: number }

let sessionState: YahooSession | null = null
let sessionInflight: Promise<YahooSession> | null = null

function cookieHeader(headers: Headers): string {
  const rows = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : []
  const single = rows.length > 0 ? rows : headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []
  return single
    .map((row) => row.split(";")[0]?.trim() ?? "")
    .filter((row) => /^(A1|A3|A1S)=/.test(row))
    .join("; ")
}

async function yahooSession(force = false): Promise<YahooSession> {
  if (!force && sessionState && sessionState.expires > Date.now()) return sessionState
  if (!force && sessionInflight) return sessionInflight

  const run = (async () => {
    const seed = await fetch("https://fc.yahoo.com/", {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
    })
    const cookie = cookieHeader(seed.headers)
    if (!cookie) throw new Error("Yahoo did not start an options session.")

    const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: cookie,
        Accept: "text/plain",
      },
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
    })
    const crumb = (await crumbResponse.text()).trim()
    if (!crumbResponse.ok || !crumb || crumb.length > 128 || /[\s<>]/.test(crumb)) {
      throw new Error("Yahoo did not return an options session.")
    }
    sessionState = { cookie, crumb, expires: Date.now() + SESSION_TTL_MS }
    return sessionState
  })()

  sessionInflight = run
  try {
    return await run
  } finally {
    if (sessionInflight === run) sessionInflight = null
  }
}

async function requestOptions(host: string, symbol: string, date: number | null, session: YahooSession): Promise<unknown> {
  const url = new URL(`https://${host}/v7/finance/options/${encodeURIComponent(symbol)}`)
  url.searchParams.set("crumb", session.crumb)
  if (date != null) url.searchParams.set("date", String(date))
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Cookie: session.cookie,
    },
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  })
  if (!response.ok) throw new Error(`Yahoo options responded ${response.status}`)
  return response.json() as Promise<unknown>
}

async function fetchOptionsPayload(symbol: string, date: number | null): Promise<unknown> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await yahooSession(attempt > 0)
    for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
      try {
        return await requestOptions(host, symbol, date, session)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Yahoo options request failed")
        if (/responded 401|responded 403/.test(lastError.message)) break
      }
    }
  }
  throw lastError ?? new Error("Yahoo options request failed")
}

async function mapPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await task(items[index])
    }
  })
  await Promise.all(workers)
}

function frontExpiration(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null
  const date = (payload as YahooOptionsPayload).optionChain?.result?.[0]?.options?.[0]?.expirationDate
  return typeof date === "number" && Number.isFinite(date) ? date : null
}

export async function fetchYahooOptionsChain(symbol: string): Promise<ParsedOptionsChain & { fetchedAt: string }> {
  const normalized = normalizeSymbol(symbol)
  if (!normalized) throw new Error("Invalid symbol.")
  if (normalized.endsWith(".HK")) throw new OptionsSkipped(normalized, hongKongSkipReason(normalized))

  const first = await fetchOptionsPayload(normalized, null)
  const front = frontExpiration(first)
  const rest = expirationTimestamps(first).filter((date) => date !== front)
  const payloads: unknown[] = [first]
  await mapPool(rest, 4, async (date) => {
    payloads.push(await fetchOptionsPayload(normalized, date))
  })

  const parsed = mergeYahooOptionsPayloads(normalized, payloads)
  if (parsed.symbol.endsWith(".HK") || parsed.market === "hk_market") {
    const name = parsed.symbol.endsWith(".HK") ? parsed.symbol : normalized
    throw new OptionsSkipped(name, hongKongSkipReason(name))
  }
  if (parsed.contracts.length === 0) {
    throw new Error(`Yahoo returned no options contracts for ${normalized}, so the overlay is skipped.`)
  }
  return { ...parsed, fetchedAt: new Date().toISOString() }
}

function unavailableReason(error: unknown): string {
  const message = error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : ""
  if (message && message.length < 200 && !message.includes("<") && !/crumb|cookie/i.test(message)) {
    return /overlay is skipped/i.test(message)
      ? message
      : `${message} The overlay is skipped and the stock signals are unchanged.`
  }
  return OPTIONS_UNAVAILABLE
}

const memory = new Map<string, { expires: number; body: OptionsBody }>()
const inflight = new Map<string, Promise<OptionsBody>>()

function remember(symbol: string, body: OptionsBody, ttl: number) {
  memory.set(symbol, { expires: Date.now() + ttl, body })
  while (memory.size > MAX_CACHE) {
    const oldest = memory.keys().next().value
    if (oldest == null) break
    memory.delete(oldest)
  }
}

export async function getOptionsChain(input: string): Promise<OptionsChainResult> {
  const access = optionsAccess(input)
  if (access.kind === "invalid") {
    return { httpStatus: 400, body: { status: "unavailable", symbol: input.trim(), reason: access.reason } }
  }
  if (access.kind === "hk") {
    return { httpStatus: 200, body: { status: "skipped", symbol: access.symbol, reason: access.reason } }
  }

  const cached = memory.get(access.symbol)
  if (cached && cached.expires > Date.now()) {
    return { httpStatus: cached.body.status === "unavailable" ? 502 : 200, body: cached.body }
  }

  const pending = inflight.get(access.symbol)
  if (pending) {
    const body = await pending
    return { httpStatus: body.status === "unavailable" ? 502 : 200, body }
  }

  const promise = fetchYahooOptionsChain(access.symbol)
    .then((chain) => {
      const body: OptionsBody = {
        status: "ok",
        symbol: chain.symbol,
        asOf: chain.asOf,
        fetchedAt: chain.fetchedAt,
        source: "live",
        contracts: chain.contracts,
      }
      remember(access.symbol, body, SUCCESS_TTL_MS)
      return body
    })
    .catch((error: unknown) => {
      if (error instanceof OptionsSkipped) {
        const body: OptionsBody = { status: "skipped", symbol: error.symbol, reason: error.message }
        return body
      }
      const body: OptionsBody = {
        status: "unavailable",
        symbol: access.symbol,
        reason: unavailableReason(error),
      }
      remember(access.symbol, body, FAILURE_TTL_MS)
      return body
    })
    .finally(() => {
      inflight.delete(access.symbol)
    })

  inflight.set(access.symbol, promise)
  const body = await promise
  return { httpStatus: body.status === "unavailable" ? 502 : 200, body }
}
