import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DEFAULT_DONCHIAN_PARAMS, generateDonchianSignals } from "./donchian.ts"
import {
  DEFAULT_OPTIONS_OVERLAY,
  OVERLAY_SCOPE,
  OVERLAY_TITLE,
  contractFlagged,
  formatVolumeOi,
  optionsAccess,
  overlayBadge,
  readOptionsOverlay,
  stockBookWithOverlay,
  type OptionContract,
  type OptionsReading,
  type OverlayEffect,
} from "./options.ts"
import { readCachedQuote } from "./quotes.ts"
import { DEFAULT_RSI_PARAMS, generateRsiSignals } from "./rsi.ts"
import { DEFAULT_PARAMS, generateSignals } from "./strategy.ts"
import { DEFAULT_SWEEP_PARAMS, generateSweepSignals } from "./sweep.ts"
import type { Bar, SignalResult, Trade } from "./types.ts"
import { barDate } from "./yahoo.ts"
import {
  expirationDate,
  getOptionsChain,
  mergeYahooOptionsPayloads,
  parseYahooOptionsChain,
} from "./yahoo-options.ts"

function contract(partial: {
  right: "call" | "put"
  volume: number
  openInterest: number
  strike?: number
  expiry?: string
  impliedVolatility?: number | null
}): OptionContract {
  const strike = partial.strike ?? (partial.right === "call" ? 230 : 220)
  const expiry = partial.expiry ?? "2026-11-20"
  return {
    contractSymbol: `${partial.right}-${expiry}-${strike}`,
    right: partial.right,
    strike,
    expiry,
    volume: partial.volume,
    openInterest: partial.openInterest,
    impliedVolatility: partial.impliedVolatility ?? null,
  }
}

function readingOf(contracts: OptionContract[], params = DEFAULT_OPTIONS_OVERLAY): OptionsReading {
  return readOptionsOverlay(contracts, params)
}

function bullishReading(): OptionsReading {
  return readingOf([contract({ right: "call", volume: 2000, openInterest: 500 })])
}

function bearishReading(): OptionsReading {
  return readingOf([contract({ right: "put", volume: 2000, openInterest: 400 })])
}

function bar(date: string, low = 10, high = 12, close = 11, volume = 100): Bar {
  return { date, open: close, high, low, close, volume }
}

function trade(partial: Partial<Trade> & Pick<Trade, "id" | "entryIndex" | "entryDate">): Trade {
  return {
    entryPrice: 11,
    atrAtEntry: 1,
    stop: 9,
    target: 14,
    exitIndex: null,
    exitDate: null,
    exitPrice: null,
    exitReason: null,
    ...partial,
  }
}

function book(trades: Trade[], sessions = 3): SignalResult {
  const bars = Array.from({ length: sessions }, (_, index) =>
    bar(`2024-01-${String(index + 2).padStart(2, "0")}`),
  ).map((row) => ({ ...row, emaFast: 1, emaSlow: 1, atr: 1 }))
  return {
    bars,
    trades,
    markers: trades.flatMap((item) => {
      const direction = item.direction ?? "long"
      const entry = {
        date: item.entryDate,
        side: "entry" as const,
        label: direction === "short" ? "Sell" : "Buy",
        reason: null,
        direction,
      }
      if (!item.exitDate || !item.exitReason) return [entry]
      return [
        entry,
        {
          date: item.exitDate,
          side: "exit" as const,
          label: "Stop",
          reason: item.exitReason,
          direction,
        },
      ]
    }),
    levelsTrade: trades.length > 0 ? trades[trades.length - 1] : null,
  }
}

const sweepParams = { ...DEFAULT_SWEEP_PARAMS, swingLookback: 2, volumePeriod: 2 }

describe("options volume versus open interest", () => {
  it("flags a contract at exactly 2× open interest and exactly 1,000 contracts", () => {
    assert.equal(
      contractFlagged({ volume: 1000, openInterest: 500 }, DEFAULT_OPTIONS_OVERLAY),
      true,
    )
    const reading = readingOf([contract({ right: "call", volume: 1000, openInterest: 500 })])
    assert.equal(reading.flagged.length, 1)
    assert.equal(reading.flagged[0].volumeOi, 2)
    assert.equal(formatVolumeOi(1000, 500), "2.00")
  })

  it("does not flag a print under the 1,000-contract floor, even at 2× open interest", () => {
    assert.equal(contractFlagged({ volume: 999, openInterest: 100 }, DEFAULT_OPTIONS_OVERLAY), false)
    assert.equal(contractFlagged({ volume: 999, openInterest: 0 }, DEFAULT_OPTIONS_OVERLAY), false)
    assert.equal(readingOf([contract({ right: "put", volume: 999, openInterest: 100 })]).flagged.length, 0)
  })

  it("does not flag 1,000 contracts when that is under 2× open interest", () => {
    assert.equal(contractFlagged({ volume: 1000, openInterest: 501 }, DEFAULT_OPTIONS_OVERLAY), false)
    assert.equal(contractFlagged({ volume: 1999, openInterest: 1000 }, DEFAULT_OPTIONS_OVERLAY), false)
    assert.equal(readingOf([contract({ right: "call", volume: 1000, openInterest: 501 })]).tilt, "none")
  })

  it("treats a reported open interest of 0 as 2× zero, and does not treat a missing print as zero", () => {
    assert.equal(contractFlagged({ volume: 1000, openInterest: 0 }, DEFAULT_OPTIONS_OVERLAY), true)
    assert.equal(formatVolumeOi(1000, 0), "∞")
    assert.equal(contractFlagged({ volume: Number.NaN, openInterest: 0 }, DEFAULT_OPTIONS_OVERLAY), false)
    assert.equal(contractFlagged({ volume: 5000, openInterest: Number.NaN }, DEFAULT_OPTIONS_OVERLAY), false)
    assert.equal(contractFlagged({ volume: 0, openInterest: 0 }, { volumeOiMultiple: 2, minVolume: 0 }), false)
  })

  it("honors a tuned multiple and a tuned floor, and both are required", () => {
    const params = { volumeOiMultiple: 3, minVolume: 2500 }
    assert.equal(contractFlagged({ volume: 2000, openInterest: 500 }, params), false)
    assert.equal(contractFlagged({ volume: 3000, openInterest: 1000 }, params), true)
    assert.equal(contractFlagged({ volume: 2400, openInterest: 400 }, params), false)
  })

  it("calls the flagged set bullish only when calls alone lit up", () => {
    const reading = readingOf([
      contract({ right: "call", volume: 2000, openInterest: 500, strike: 230 }),
      contract({ right: "put", volume: 50000, openInterest: 40000, strike: 200 }),
    ])
    assert.equal(reading.tilt, "bullish")
    assert.equal(reading.callVolume, 2000)
    assert.equal(reading.putVolume, 0)
    assert.equal(reading.flagged.length, 1)
  })

  it("calls the flagged set bearish only when puts alone lit up", () => {
    const reading = readingOf([
      contract({ right: "put", volume: 1500, openInterest: 200, strike: 180 }),
      contract({ right: "call", volume: 1000, openInterest: 900, strike: 250 }),
    ])
    assert.equal(reading.tilt, "bearish")
    assert.equal(reading.putVolume, 1500)
    assert.equal(reading.callVolume, 0)
  })

  it("treats both sides lighting up as a volatility event, even when calls dominate", () => {
    const reading = readingOf([
      contract({ right: "call", volume: 50000, openInterest: 1000, strike: 230 }),
      contract({ right: "put", volume: 1000, openInterest: 100, strike: 180 }),
    ])
    assert.equal(reading.tilt, "volatility")
    assert.equal(reading.callVolume, 50000)
    assert.equal(reading.putVolume, 1000)
    assert.equal(overlayBadge("volatility"), "OI volatility")
  })
})

describe("options confirm and veto", () => {
  it("confirms a new long and leaves the strategy stop and target untouched", () => {
    const open = trade({ id: 4, entryIndex: 1, entryDate: "2024-01-03", stop: 8.5, target: 16 })
    const result = book([open], 2)
    const applied = stockBookWithOverlay(result, bullishReading())
    assert.equal(applied.result, result)
    assert.equal(applied.decision?.effect, "confirmed-long")
    assert.equal(applied.decision?.vetoedTradeIds.length, 0)
    assert.equal(result.trades[0].stop, 8.5)
    assert.equal(result.trades[0].target, 16)
    assert.equal(overlayBadge("confirmed-long"), "OI confirms long")
  })

  it("blocks a new long when the tilt is bearish and does not open a short", () => {
    const fresh = trade({ id: 2, entryIndex: 2, entryDate: "2024-01-04", stop: 8.25, target: 15 })
    const earlier = trade({
      id: 1,
      entryIndex: 0,
      entryDate: "2024-01-02",
      exitIndex: 1,
      exitDate: "2024-01-03",
      exitPrice: 9,
      exitReason: "stop",
      stop: 8,
      target: 14,
    })
    const result = book([earlier, fresh], 3)
    const stop = fresh.stop
    const applied = stockBookWithOverlay(result, bearishReading())
    assert.equal(applied.decision?.effect, "vetoed-long")
    assert.deepEqual(applied.decision?.vetoedTradeIds, [2])
    assert.equal(applied.result.trades.length, 1)
    assert.equal(applied.result.trades[0], earlier)
    assert.equal(earlier.stop, 8)
    assert.equal(earlier.target, 14)
    assert.equal(fresh.stop, stop)
    assert.equal(
      applied.result.trades.some((item) => item.direction === "short"),
      false,
    )
    assert.equal(
      applied.result.markers.some((marker) => marker.side === "entry" && marker.date === "2024-01-04"),
      false,
    )
    assert.equal(
      applied.result.markers.some((marker) => marker.side === "exit" && marker.date === "2024-01-03"),
      true,
    )
    assert.equal(applied.result.levelsTrade, earlier)
    assert.equal(applied.result.bars, result.bars)
    assert.equal(result.trades.length, 2)
  })

  it("confirms a new short and blocks that short when the tilt is bullish, without opening a long", () => {
    const fresh = trade({
      id: 1,
      entryIndex: 1,
      entryDate: "2024-01-03",
      direction: "short",
      stop: 13,
      target: 8,
    })
    const result = book([fresh], 2)
    const confirmed = stockBookWithOverlay(result, bearishReading())
    assert.equal(confirmed.result, result)
    assert.equal(confirmed.decision?.effect, "confirmed-short")
    assert.equal(result.trades[0].stop, 13)
    assert.equal(result.trades[0].target, 8)

    const blocked = stockBookWithOverlay(result, bullishReading())
    assert.equal(blocked.decision?.effect, "vetoed-short")
    assert.equal(blocked.result.trades.length, 0)
    assert.equal(blocked.result.markers.length, 0)
    assert.equal(blocked.result.levelsTrade, null)
    assert.equal(
      blocked.result.trades.some((item) => item.direction !== "short"),
      false,
    )
  })

  it("does not open a stock trade from options flow alone", () => {
    const result = book([], 3)
    for (const reading of [bullishReading(), bearishReading()]) {
      const applied = stockBookWithOverlay(result, reading)
      assert.equal(applied.result, result)
      assert.equal(applied.result.trades.length, 0)
      assert.equal(applied.decision?.effect, "no-entry")
    }
  })

  it("leaves an earlier open trade alone, including a conflicting tilt", () => {
    const open = trade({ id: 1, entryIndex: 0, entryDate: "2024-01-02", stop: 7.5, target: 18, direction: "long" })
    const result = book([open], 4)
    for (const reading of [bullishReading(), bearishReading()]) {
      const applied = stockBookWithOverlay(result, reading)
      assert.equal(applied.result, result)
      assert.equal(applied.decision?.effect, "open-left-alone")
      assert.equal(open.stop, 7.5)
      assert.equal(open.target, 18)
      assert.equal(applied.decision?.effect === "confirmed-long", false)
    }
  })

  it("shows a volatility event and does not confirm or veto", () => {
    const fresh = trade({ id: 1, entryIndex: 1, entryDate: "2024-01-03" })
    const result = book([fresh], 2)
    const reading = readingOf([
      contract({ right: "call", volume: 4000, openInterest: 500 }),
      contract({ right: "put", volume: 1200, openInterest: 200 }),
    ])
    const applied = stockBookWithOverlay(result, reading)
    assert.equal(applied.result, result)
    assert.equal(applied.decision?.effect, "volatility")
    assert.match(applied.decision?.note ?? "", /not a bullish or bearish/)
    assert.doesNotMatch(applied.decision?.note ?? "", /unusual/i)
  })

  it("skips the overlay when options data is missing and does not invent a flag", () => {
    const fresh = trade({ id: 1, entryIndex: 1, entryDate: "2024-01-03", stop: 6, target: 20 })
    const result = book([fresh], 2)
    const applied = stockBookWithOverlay(result, null)
    assert.equal(applied.result, result)
    assert.equal(applied.decision, null)
    assert.equal(fresh.stop, 6)
    assert.equal(result.trades.length, 1)
  })

  it("does not badge a book when nothing flagged", () => {
    const fresh = trade({ id: 1, entryIndex: 0, entryDate: "2024-01-02" })
    const result = book([fresh], 1)
    const applied = stockBookWithOverlay(result, readingOf([contract({ right: "call", volume: 100, openInterest: 10 })]))
    assert.equal(applied.result, result)
    assert.equal(applied.decision?.effect, "no-flag")
    assert.equal(overlayBadge("no-flag"), null)
  })
})

describe("options overlay on the existing strategy books", () => {
  it("confirms or blocks a volume-sweep entry on the latest bar without rewriting risk", () => {
    const bars = [
      bar("2024-01-02", 10, 12, 11, 100),
      bar("2024-01-03", 10, 12, 11, 100),
      bar("2024-01-04", 9, 12, 11, 200),
    ]
    const result = generateSweepSignals(bars, sweepParams)
    assert.equal(result.trades.length, 1)
    assert.equal(result.trades[0].direction, "long")
    assert.equal(result.trades[0].entryIndex, 2)
    const stop = result.trades[0].stop
    const target = result.trades[0].target
    assert.ok(Math.abs(stop - (9 - sweepParams.stopOffset)) < 1e-9)

    const confirmed = stockBookWithOverlay(result, bullishReading())
    assert.equal(confirmed.result, result)
    assert.equal(confirmed.decision?.effect, "confirmed-long")
    assert.equal(result.trades[0].stop, stop)
    assert.equal(result.trades[0].target, target)

    const blocked = stockBookWithOverlay(result, bearishReading())
    assert.equal(blocked.decision?.effect, "vetoed-long")
    assert.equal(blocked.result.trades.length, 0)
    assert.equal(blocked.result.markers.length, 0)
    assert.equal(result.trades[0].stop, stop)
    assert.equal(result.trades[0].target, target)
  })

  it("confirms a sweep short and does not replace a blocked short with a long", () => {
    const bars = [
      bar("2024-01-02", 10, 12, 11, 100),
      bar("2024-01-03", 10, 12, 11, 100),
      bar("2024-01-04", 10, 13, 11, 200),
    ]
    const result = generateSweepSignals(bars, sweepParams)
    assert.equal(result.trades[0].direction, "short")
    const stop = result.trades[0].stop
    const target = result.trades[0].target

    const confirmed = stockBookWithOverlay(result, bearishReading())
    assert.equal(confirmed.decision?.effect, "confirmed-short")
    assert.equal(confirmed.result.trades[0].stop, stop)
    assert.equal(confirmed.result.trades[0].target, target)

    const blocked = stockBookWithOverlay(result, bullishReading())
    assert.equal(blocked.decision?.effect, "vetoed-short")
    assert.equal(blocked.result.trades.length, 0)
    assert.equal(result.trades[0].stop, stop)
  })

  it("leaves an open sweep from an earlier session alone", () => {
    const bars = [
      bar("2024-01-02", 10, 12, 11, 100),
      bar("2024-01-03", 10, 12, 11, 100),
      bar("2024-01-04", 9, 12, 11, 200),
      bar("2024-01-05", 10, 12, 11, 50),
      bar("2024-01-08", 10, 12, 11, 50),
    ]
    const result = generateSweepSignals(bars, sweepParams)
    assert.equal(result.trades.length, 1)
    assert.equal(result.trades[0].exitIndex, null)
    assert.ok(result.trades[0].entryIndex < bars.length - 1)
    const applied = stockBookWithOverlay(result, bearishReading())
    assert.equal(applied.result, result)
    assert.equal(applied.decision?.effect, "open-left-alone")
    assert.equal(applied.result.trades[0].stop, result.trades[0].stop)
    assert.equal(applied.result.trades[0].target, result.trades[0].target)
  })

  it("does not add trades to the EMA, sweep, Donchian, or RSI books, and a missing chain leaves them identical", async () => {
    const quote = await readCachedQuote("AAPL")
    assert.ok(quote)
    const runs: Array<(bars: Bar[]) => SignalResult> = [
      (bars) => generateSignals(bars, DEFAULT_PARAMS),
      (bars) => generateSweepSignals(bars, DEFAULT_SWEEP_PARAMS),
      (bars) => generateDonchianSignals(bars, DEFAULT_DONCHIAN_PARAMS),
      (bars) => generateRsiSignals(bars, DEFAULT_RSI_PARAMS),
    ]
    for (const run of runs) {
      const result = run(quote.bars)
      const missing = stockBookWithOverlay(result, null)
      assert.equal(missing.result, result)
      assert.equal(missing.decision, null)

      for (const reading of [bullishReading(), bearishReading()]) {
        const applied = stockBookWithOverlay(result, reading)
        assert.ok(applied.result.trades.length <= result.trades.length)
        for (const item of applied.result.trades) {
          assert.ok(result.trades.includes(item))
          assert.equal(item.stop, result.trades.find((original) => original.id === item.id)?.stop)
          assert.equal(item.target, result.trades.find((original) => original.id === item.id)?.target)
        }
        assert.equal(
          applied.result.trades.some((item) => !result.trades.some((original) => original.id === item.id)),
          false,
        )
      }
    }
  })
})

describe("options chain availability", () => {
  it("skips Hong Kong names and does not invent prints", async () => {
    for (const input of ["0700.HK", "700.hk", "9988.HK"]) {
      const access = optionsAccess(input)
      assert.equal(access.kind, "hk")
      if (access.kind !== "hk") continue
      assert.match(access.reason, /Hong Kong names are skipped/)
      assert.match(access.reason, /does not invent options prints/)
      assert.match(access.reason, new RegExp(access.symbol.replace(".", "\\.")))
      const response = await getOptionsChain(input)
      assert.equal(response.httpStatus, 200)
      assert.equal(response.body.status, "skipped")
      if (response.body.status !== "skipped") continue
      assert.equal(response.body.symbol, access.symbol)
      assert.equal("contracts" in response.body, false)
    }
    assert.equal(optionsAccess("0700.HK").kind, "hk")
    const hk = optionsAccess("0700.HK")
    assert.equal(hk.kind === "hk" && hk.symbol, "0700.HK")
  })

  it("accepts a US ticker and rejects a symbol the desk cannot plot", async () => {
    assert.deepEqual(optionsAccess("aapl"), { kind: "us", symbol: "AAPL" })
    assert.deepEqual(optionsAccess("BRK.B"), { kind: "us", symbol: "BRK.B" })
    const invalid = await getOptionsChain("AAPL;drop")
    assert.equal(invalid.httpStatus, 400)
    assert.equal(invalid.body.status, "unavailable")
    assert.equal(optionsAccess("").kind, "invalid")
  })

  it("labels the overlay as volume versus open interest", () => {
    assert.equal(OVERLAY_TITLE, "Volume vs open interest")
    assert.match(OVERLAY_SCOPE, /volume versus open interest/i)
    assert.match(OVERLAY_SCOPE, /not unusual flow/i)
    assert.match(OVERLAY_SCOPE, /not a separate trading book/i)
    assert.doesNotMatch(OVERLAY_SCOPE, /5×|5x|20-session/)
    const effects: OverlayEffect[] = [
      "confirmed-long",
      "confirmed-short",
      "vetoed-long",
      "vetoed-short",
      "volatility",
      "open-left-alone",
      "no-entry",
      "no-flag",
    ]
    const fresh = trade({ id: 1, entryIndex: 0, entryDate: "2024-01-02" })
    for (const effect of effects) {
      const applied = stockBookWithOverlay(book([fresh], 1), readingOf([]))
      assert.equal(applied.decision?.effect, "no-flag")
      assert.doesNotMatch(applied.decision?.note ?? "", /unusual/i)
      assert.equal(overlayBadge(effect) === "Unusual flow", false)
    }
  })
})

describe("parseYahooOptionsChain", () => {
  const epoch = 1794960000

  function payload(calls: unknown[], puts: unknown[] = []) {
    return {
      optionChain: {
        result: [
          {
            underlyingSymbol: "AAPL",
            expirationDates: [epoch],
            quote: {
              regularMarketTime: 1794949201,
              exchangeTimezoneName: "America/New_York",
              market: "us_market",
            },
            options: [{ expirationDate: epoch, calls, puts }],
          },
        ],
        error: null,
      },
    }
  }

  it("keeps strike, expiry, volume, open interest, and implied vol, and drops a missing print", () => {
    const parsed = parseYahooOptionsChain("aapl", payload(
      [
        {
          contractSymbol: "AAPL261118C00230000",
          strike: 230,
          expiration: epoch,
          volume: 1500,
          openInterest: 400,
          impliedVolatility: 0.25,
        },
        {
          contractSymbol: "AAPL261118C00240000",
          strike: 240,
          expiration: epoch,
          openInterest: 10,
          impliedVolatility: 0.3,
        },
      ],
      [
        {
          contractSymbol: "AAPL261118P00220000",
          strike: 220,
          expiration: epoch,
          volume: 800,
          openInterest: 100,
        },
      ],
    ))
    assert.equal(parsed.symbol, "AAPL")
    assert.equal(parsed.asOf, barDate(1794949201, "America/New_York"))
    assert.equal(parsed.contracts.length, 2)
    assert.equal(parsed.contracts[0].right, "call")
    assert.equal(parsed.contracts[0].expiry, "2026-11-18")
    assert.notEqual(parsed.contracts[0].expiry, barDate(epoch, "America/New_York"))
    assert.equal(expirationDate(epoch), "2026-11-18")
    assert.equal(parsed.contracts[0].volume, 1500)
    assert.equal(parsed.contracts[0].openInterest, 400)
    assert.equal(parsed.contracts[0].impliedVolatility, 0.25)
    assert.equal(parsed.contracts[1].right, "put")
    assert.equal(parsed.contracts[1].impliedVolatility, null)
    assert.equal(
      parsed.contracts.some((item) => item.strike === 240),
      false,
    )
  })

  it("does not invent contracts from an empty or failed chain", () => {
    const empty = parseYahooOptionsChain("AAPL", payload([]))
    assert.deepEqual(empty.contracts, [])
    assert.throws(() => parseYahooOptionsChain("AAPL", null), /Empty options response/)
    assert.throws(
      () => parseYahooOptionsChain("AAPL", { optionChain: { result: null, error: { description: "Chain unavailable" } } }),
      /Chain unavailable/,
    )
  })

  it("keeps the first copy when two expiry payloads repeat a contract", () => {
    const first = payload([
      {
        contractSymbol: "AAPL261118C00230000",
        strike: 230,
        expiration: epoch,
        volume: 1500,
        openInterest: 400,
        impliedVolatility: 0.2,
      },
    ])
    const second = payload(
      [
        {
          contractSymbol: "AAPL261118C00230000",
          strike: 230,
          expiration: epoch,
          volume: 9999,
          openInterest: 1,
        },
      ],
      [
        {
          contractSymbol: "AAPL261118P00200000",
          strike: 200,
          expiration: epoch,
          volume: 1100,
          openInterest: 100,
        },
      ],
    )
    const merged = mergeYahooOptionsPayloads("AAPL", [first, second])
    assert.equal(merged.contracts.length, 2)
    const call = merged.contracts.find((item) => item.right === "call")
    assert.equal(call?.volume, 1500)
    assert.equal(call?.openInterest, 400)
    const reading = readOptionsOverlay(merged.contracts)
    assert.equal(reading.callVolume, 1500)
    assert.equal(reading.putVolume, 1100)
    assert.equal(reading.tilt, "volatility")
  })
})
