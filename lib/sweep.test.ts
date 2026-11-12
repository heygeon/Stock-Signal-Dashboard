import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readCachedQuote } from "./quotes.ts"
import { positionReturn, summarizeTrades } from "./strategy.ts"
import {
  DEFAULT_SWEEP_PARAMS,
  NO_VOLUME_MESSAGE,
  decideSweepTrades,
  generateSweepSignals,
  priorAverageVolume,
  priorSwingHigh,
  priorSwingLow,
  sweepParamsError,
} from "./sweep.ts"
import type { Bar, SweepParams, Trade } from "./types.ts"

function iso(index: number): string {
  return new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)
}

function makeBar(index: number, high: number, low: number, close: number, volume = 100): Bar {
  return { date: iso(index), open: close, high, low, close, volume }
}

const TIGHT: SweepParams = {
  swingLookback: 3,
  volumePeriod: 3,
  volumeMultiple: 1.5,
  takeProfitMultiple: 2,
  stopOffset: 0.01,
}

function quiet(count: number, volume = 100): Bar[] {
  return Array.from({ length: count }, (_, index) => makeBar(index, 10, 8, 9, volume))
}

function longRisk(close: number, low: number, offset: number, multiple: number) {
  const stop = low - offset
  const risk = close - stop
  return { stop, risk, target: close + multiple * risk }
}

function shortRisk(close: number, high: number, offset: number, multiple: number) {
  const stop = high + offset
  const risk = stop - close
  return { stop, risk, target: close - multiple * risk }
}

describe("swing and volume windows", () => {
  it("uses the prior 10 bars and leaves the current bar out of the swing", () => {
    const bars = quiet(21)
    // Index 9 is eleven sessions before index 20, so a 10-bar window does not see it.
    bars[9] = makeBar(9, 10, 5, 9, 100)
    bars[20] = makeBar(20, 10, 4, 9, 100)
    assert.equal(priorSwingLow(bars, 20, 10), 8)
    assert.equal(priorSwingLow(bars, 10, 10), 5)
    assert.equal(priorSwingHigh(bars, 20, 10), 10)
    assert.equal(priorSwingLow(bars, 9, 10), null)
  })

  it("averages the prior volumes and does not let the current spike dilute them", () => {
    const bars = quiet(4, 10)
    bars[3] = makeBar(3, 10, 8, 9, 1000)
    assert.equal(priorAverageVolume(bars, 3, 3), 10)
    assert.equal(priorAverageVolume(bars, 2, 3), null)
  })
})

describe("decideSweepTrades", () => {
  it("buys a volume-confirmed reclaim of the prior swing low", () => {
    const bars = quiet(3)
    bars.push(makeBar(3, 9.5, 7, 8.5, 150))
    const trades = decideSweepTrades(bars, TIGHT)
    const expected = longRisk(8.5, 7, 0.01, 2)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].entryPrice, 8.5)
    assert.equal(trades[0].entryDate, iso(3))
    assert.equal(trades[0].sweptLevel, 8)
    assert.ok(Math.abs(trades[0].stop - expected.stop) < 1e-9)
    assert.ok(Math.abs(trades[0].target - expected.target) < 1e-9)
    assert.equal(trades[0].exitReason, null)
  })

  it("sells a volume-confirmed reclaim of the prior swing high", () => {
    const bars = quiet(3)
    bars.push(makeBar(3, 11, 8.5, 9.2, 150))
    const trades = decideSweepTrades(bars, TIGHT)
    const expected = shortRisk(9.2, 11, 0.01, 2)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "short")
    assert.equal(trades[0].entryPrice, 9.2)
    assert.equal(trades[0].sweptLevel, 10)
    assert.ok(Math.abs(trades[0].stop - expected.stop) < 1e-9)
    assert.ok(Math.abs(trades[0].target - expected.target) < 1e-9)
    assert.ok(trades[0].stop > trades[0].entryPrice)
    assert.ok(trades[0].target < trades[0].entryPrice)
  })

  it("requires the volume multiple against the prior average, not an average that includes the spike", () => {
    const bars = quiet(3, 100)
    const passing = decideSweepTrades([...bars, makeBar(3, 9.5, 7, 8.5, 150)], TIGHT)
    const failing = decideSweepTrades([...bars, makeBar(3, 9.5, 7, 8.5, 149)], TIGHT)
    assert.equal(passing.length, 1)
    assert.equal(failing.length, 0)
    // Including the 150 print would make the average 112.5 and 1.5× that is 168.75.
    assert.equal(priorAverageVolume([...bars, makeBar(3, 9.5, 7, 8.5, 150)], 3, 3), 100)
  })

  it("ignores a low-volume sweep", () => {
    const bars = [...quiet(3), makeBar(3, 9.5, 7, 8.5, 100)]
    assert.equal(decideSweepTrades(bars, TIGHT).length, 0)
  })

  it("ignores a poke through the swing low that does not close back above it", () => {
    const bars = [...quiet(3), makeBar(3, 9, 7, 7.9, 500)]
    assert.equal(decideSweepTrades(bars, TIGHT).length, 0)
  })

  it("ignores a poke through the swing high that does not close back below it", () => {
    const bars = [...quiet(3), makeBar(3, 11, 8.5, 10.1, 500)]
    assert.equal(decideSweepTrades(bars, TIGHT).length, 0)
  })

  it("does not treat a touch of the prior low as a sweep", () => {
    const bars = [...quiet(3), makeBar(3, 9.5, 8, 8.5, 500)]
    assert.equal(decideSweepTrades(bars, TIGHT).length, 0)
  })

  it("does not treat a close equal to the swept low as a reclaim", () => {
    const bars = [...quiet(3), makeBar(3, 9.5, 7, 8, 500)]
    assert.equal(decideSweepTrades(bars, TIGHT).length, 0)
  })

  it("does not enter when price sweeps but volume is only the average", () => {
    const bars = [...quiet(20), makeBar(20, 9.5, 7, 8.4, 100)]
    assert.equal(priorSwingLow(bars, 20, 10), 8)
    assert.equal(decideSweepTrades(bars, DEFAULT_SWEEP_PARAMS).length, 0)
  })

  it("uses the default 10-bar swing and 20-bar volume window", () => {
    const bars = quiet(20)
    bars[9] = makeBar(9, 10, 4, 9, 100)
    // Prior 10 lows are 8, so 7.5 takes them out. Bar 9's low of 4 is outside that window.
    bars.push(makeBar(20, 9.5, 7.5, 8.4, 150))
    const trades = decideSweepTrades(bars, DEFAULT_SWEEP_PARAMS)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].sweptLevel, 8)
    assert.equal(priorSwingLow(bars, 20, 10), 8)
    assert.equal(priorAverageVolume(bars, 20, 20), 100)
  })

  it("does not let a low older than the lookback block a sweep", () => {
    const bars = quiet(12)
    bars[0] = makeBar(0, 10, 1, 9, 100)
    bars[11] = makeBar(11, 9.5, 7, 8.4, 200)
    const trades = decideSweepTrades(bars, { ...TIGHT, swingLookback: 10, volumePeriod: 10 })
    assert.equal(trades.length, 1)
    assert.equal(trades[0].sweptLevel, 8)
  })

  it("stays flat when the same bar reclaims both the prior low and the prior high", () => {
    const bars = [...quiet(3), makeBar(3, 10.5, 7, 9, 500)]
    assert.equal(decideSweepTrades(bars, TIGHT).length, 0)
  })

  it("does not stop a long out on a wick when the close holds above the stop", () => {
    const bars = [...quiet(3), makeBar(3, 9.5, 7, 8.5, 200), makeBar(4, 9, 6, 8.2, 100)]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades.length, 1)
    assert.ok(bars[4].low < trades[0].stop)
    assert.ok(bars[4].close > trades[0].stop)
    assert.equal(trades[0].exitReason, null)
  })

  it("stops a long when the close trades at or below the stop", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const bars = [...quiet(3), makeBar(3, 9.5, 7, 8.5, 200), makeBar(4, 8, expected.stop, expected.stop, 100)]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitPrice, expected.stop)
    assert.equal(trades[0].exitDate, iso(4))
  })

  it("takes profit on a long when the close reaches the target", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const bars = [
      ...quiet(3),
      makeBar(3, 9.5, 7, 8.5, 200),
      makeBar(4, expected.target + 1, 8, expected.target - 0.01, 100),
      makeBar(5, expected.target + 0.2, 8, expected.target, 100),
    ]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[0].exitIndex, 5)
    assert.equal(trades[0].exitPrice, expected.target)
  })

  it("does not stop a short out on a wick when the close holds below the stop", () => {
    const bars = [...quiet(3), makeBar(3, 11, 8.5, 9.2, 200), makeBar(4, 12, 9, 10, 100)]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.ok(bars[4].high > trades[0].stop)
    assert.ok(bars[4].close < trades[0].stop)
    assert.equal(trades[0].exitReason, null)
    assert.equal(trades[0].direction, "short")
  })

  it("stops a short when the close trades at or above the stop", () => {
    const expected = shortRisk(9.2, 11, 0.01, 2)
    const bars = [...quiet(3), makeBar(3, 11, 8.5, 9.2, 200), makeBar(4, expected.stop + 0.2, 9, expected.stop, 80)]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitPrice, expected.stop)
  })

  it("covers a short at the target when the close reaches it", () => {
    const expected = shortRisk(9.2, 11, 0.01, 2)
    const bars = [
      ...quiet(3),
      makeBar(3, 11, 8.5, 9.2, 200),
      makeBar(4, 10, expected.target - 1, expected.target + 0.05, 80),
      makeBar(5, 9, expected.target - 0.2, expected.target, 80),
    ]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[0].exitIndex, 5)
    assert.ok(bars[4].low < trades[0].target)
    assert.ok(bars[4].close > trades[0].target)
  })

  it("places the stop on the wick when the offset is zero, and just beyond it when the offset is wider", () => {
    const entry = makeBar(3, 9.5, 7, 8.5, 200)
    const onWick = decideSweepTrades([...quiet(3), entry], { ...TIGHT, stopOffset: 0 })
    const wider = decideSweepTrades([...quiet(3), entry], { ...TIGHT, stopOffset: 0.05 })
    assert.equal(onWick[0].stop, 7)
    assert.ok(Math.abs(wider[0].stop - 6.95) < 1e-9)
    assert.ok(wider[0].target > onWick[0].target)

    const pierced = [...quiet(3), entry, makeBar(4, 8, 6, 7, 50)]
    const hold = decideSweepTrades(pierced, { ...TIGHT, stopOffset: 0.05 })
    const stopped = decideSweepTrades(pierced, { ...TIGHT, stopOffset: 0 })
    assert.equal(hold[0].exitReason, null)
    assert.equal(stopped[0].exitReason, "stop")
  })

  it("honors a different take-profit multiple", () => {
    const trades = decideSweepTrades([...quiet(3), makeBar(3, 9.5, 7, 8.5, 200)], {
      ...TIGHT,
      takeProfitMultiple: 3,
    })
    const expected = longRisk(8.5, 7, 0.01, 3)
    assert.ok(Math.abs(trades[0].target - expected.target) < 1e-9)
  })

  it("ignores a same-direction sweep while the trade is open and keeps the original stop", () => {
    const bars = [...quiet(3), makeBar(3, 9.5, 7, 8.5, 200), makeBar(4, 8.5, 6.8, 8, 400)]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.ok(Math.abs(trades[0].stop - longRisk(8.5, 7, 0.01, 2).stop) < 1e-9)
    assert.equal(trades[0].exitReason, null)
    assert.equal(trades[0].sweptLevel, 8)
  })

  it("does not reverse an open long when a short sweep prints", () => {
    const bars = [...quiet(3), makeBar(3, 9.5, 7, 8.5, 200), makeBar(4, 10.5, 9, 9.5, 400)]
    const open = decideSweepTrades(bars, TIGHT)
    assert.equal(open.length, 1)
    assert.equal(open[0].direction, "long")
    assert.equal(open[0].exitReason, null)

    const stopped = decideSweepTrades([...bars, makeBar(5, 7, 6.4, 6.5, 40)], TIGHT)
    assert.equal(stopped.length, 1)
    assert.equal(stopped[0].direction, "long")
    assert.equal(stopped[0].exitReason, "stop")
    assert.equal(stopped[0].exitIndex, 5)
  })

  it("does not reverse an open short when a long sweep prints", () => {
    const bars = [...quiet(3), makeBar(3, 11, 8.5, 9.2, 200), makeBar(4, 9, 7.5, 8.2, 400)]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "short")
    assert.equal(trades[0].exitReason, null)
    assert.equal(trades[0].sweptLevel, 10)
  })

  it("stays flat on the exit bar even when that bar is itself a fresh long sweep", () => {
    const bars = [
      ...quiet(3),
      makeBar(3, 9.5, 7, 8.5, 200),
      makeBar(4, 7.5, 6.4, 7.2, 100),
      makeBar(5, 7.5, 6.4, 7.2, 100),
      makeBar(6, 7.5, 6.4, 7.2, 100),
      makeBar(7, 6.8, 6.0, 6.5, 200),
    ]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].exitIndex, 7)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(priorSwingLow(bars, 7, 3), 6.4)
    assert.ok(bars[7].low < 6.4 && bars[7].close > 6.4)
    assert.ok(bars[7].close <= trades[0].stop)
  })

  it("stays flat after a stop until a later fresh sweep", () => {
    const bars = [
      ...quiet(3),
      makeBar(3, 9.5, 7, 8.5, 200),
      makeBar(4, 7.5, 6.4, 7.2, 100),
      makeBar(5, 7.5, 6.4, 7.2, 100),
      makeBar(6, 7.5, 6.4, 7.2, 100),
      makeBar(7, 6.8, 6.0, 6.5, 200),
      makeBar(8, 6.4, 6.2, 6.3, 50),
      makeBar(9, 6.4, 5.5, 6.2, 200),
    ]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades.length, 2)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitIndex, 7)
    assert.equal(trades[1].entryIndex, 9)
    assert.equal(trades[1].direction, "long")
    assert.equal(trades[1].entryPrice, 6.2)
    assert.equal(trades[1].sweptLevel, 6)
    assert.equal(trades[1].exitReason, null)
  })

  it("stays flat after a take-profit until the next fresh sweep", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const bars = [
      ...quiet(3),
      makeBar(3, 9.5, 7, 8.5, 200),
      makeBar(4, 12, 11, expected.target, 100),
      makeBar(5, 12, 10, 11, 100),
      makeBar(6, 12, 10, 11, 100),
      makeBar(7, 12, 10, 11, 100),
      makeBar(8, 11, 9, 10.5, 400),
    ]
    const trades = decideSweepTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[0].exitIndex, 4)
    assert.equal(trades.length, 2)
    assert.equal(trades[1].entryIndex, 8)
    assert.equal(trades[1].direction, "long")
    assert.equal(trades[1].sweptLevel, 10)
    assert.ok(trades[1].entryIndex > trades[0].exitIndex)
  })

  it("does not enter before both windows are available", () => {
    const bars = [...quiet(2), makeBar(2, 9.5, 7, 8.5, 500)]
    assert.equal(decideSweepTrades(bars, TIGHT).length, 0)
  })

  it("does not confirm a sweep against a zero-volume baseline", () => {
    const bars = [...quiet(3, 0), makeBar(3, 9.5, 7, 8.5, 0)]
    assert.equal(decideSweepTrades(bars, TIGHT).length, 0)
  })
})

describe("generateSweepSignals", () => {
  it("sorts bars, drops a bad print, and labels the long exit", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const bars: Bar[] = [
      makeBar(3, 9.5, 7, 8.5, 200),
      { date: "bad", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      makeBar(1, 10, 8, 9, 100),
      { date: iso(2), open: Number.NaN, high: 1, low: 1, close: 1, volume: 1 },
      makeBar(0, 10, 8, 9, 100),
      makeBar(2, 10, 8, 9, 100),
      makeBar(4, 8, expected.stop, expected.stop, 40),
    ]
    const result = generateSweepSignals(bars, TIGHT)
    assert.equal(result.error, null)
    assert.deepEqual(
      result.bars.map((bar) => bar.date),
      [iso(0), iso(1), iso(2), iso(3), iso(4)],
    )
    assert.equal(result.trades.length, 1)
    assert.equal(result.trades[0].direction, "long")
    assert.equal(result.trades[0].exitReason, "stop")
    assert.deepEqual(
      result.markers.map((marker) => marker.label),
      ["Buy", "Stop"],
    )
    assert.equal(result.levelsTrade, result.trades[0])
  })

  it("labels a short entry as Sell and the exit as Cover", () => {
    const expected = shortRisk(9.2, 11, 0.01, 2)
    const bars = [...quiet(3), makeBar(3, 11, 8.5, 9.2, 200), makeBar(4, 10, expected.target, expected.target, 50)]
    const result = generateSweepSignals(bars, TIGHT)
    assert.equal(result.trades[0].direction, "short")
    assert.equal(result.trades[0].exitReason, "take_profit")
    assert.deepEqual(
      result.markers.map((marker) => ({ label: marker.label, direction: marker.direction, reason: marker.reason })),
      [
        { label: "Sell", direction: "short", reason: null },
        { label: "Cover", direction: "short", reason: "take_profit" },
      ],
    )
  })

  it("refuses a history with no positive volume instead of skipping the filter", () => {
    const bars = [...quiet(3, 0), makeBar(3, 9.5, 7, 8.5, 0)]
    const missing = generateSweepSignals(bars, TIGHT)
    assert.equal(missing.trades.length, 0)
    assert.equal(missing.error, NO_VOLUME_MESSAGE)
    assert.equal(missing.bars.length, 4)

    const blanked = bars.map((bar) => ({ ...bar, volume: Number.NaN }))
    const coerced = generateSweepSignals(blanked, TIGHT)
    assert.equal(coerced.error, NO_VOLUME_MESSAGE)
    assert.equal(coerced.trades.length, 0)
  })

  it("keeps running when only some sessions printed zero volume", () => {
    const bars = [...quiet(3, 0), makeBar(3, 10, 8, 9, 100), makeBar(4, 10, 8, 9, 100), makeBar(5, 10, 8, 9, 100)]
    const result = generateSweepSignals(bars, TIGHT)
    assert.equal(result.error, null)
    assert.equal(result.trades.length, 0)
  })

  it("returns no trades when the parameters are not usable", () => {
    const bars = [...quiet(3), makeBar(3, 9.5, 7, 8.5, 200)]
    assert.equal(sweepParamsError({ ...TIGHT, swingLookback: 1 }), "Swing lookback must be a whole number of at least 2.")
    assert.equal(
      sweepParamsError({ ...TIGHT, volumePeriod: 1.5 }),
      "Volume average period must be a whole number of at least 2.",
    )
    assert.equal(sweepParamsError({ ...TIGHT, volumeMultiple: 0 }), "Volume multiple must be greater than 0.")
    assert.equal(sweepParamsError({ ...TIGHT, takeProfitMultiple: 0 }), "Take-profit multiple must be greater than 0.")
    assert.equal(sweepParamsError({ ...TIGHT, stopOffset: -0.01 }), "Stop offset must be zero or greater.")
    const result = generateSweepSignals(bars, { ...TIGHT, stopOffset: -1 })
    assert.equal(result.trades.length, 0)
    assert.equal(result.error, "Stop offset must be zero or greater.")
  })
})

describe("short results in the summary", () => {
  it("counts a short win when the exit close is below the entry", () => {
    const closed: Trade = {
      id: 1,
      entryIndex: 1,
      entryDate: iso(1),
      entryPrice: 10,
      atrAtEntry: 0,
      stop: 11,
      target: 8,
      exitIndex: 3,
      exitDate: iso(3),
      exitPrice: 8,
      exitReason: "take_profit",
      direction: "short",
      sweptLevel: 12,
    }
    const summary = summarizeTrades([closed], 8)
    assert.equal(summary.wins, 1)
    assert.equal(summary.winRate, 1)
    assert.ok(Math.abs((summary.avgReturn as number) - 0.2) < 1e-12)
    assert.ok(positionReturn(closed, 8) > 0)
    assert.ok(positionReturn({ ...closed, direction: "long" }, 8) < 0)
  })
})

describe("cached demo histories", () => {
  for (const symbol of ["AAPL", "0700.HK"]) {
    it(`${symbol} has real volume and every sweep trade matches the rules`, async () => {
      const quote = await readCachedQuote(symbol)
      assert.ok(quote, `missing cache for ${symbol}`)
      const positive = quote.bars.filter((bar) => bar.volume > 0).length
      assert.ok(positive > quote.bars.length * 0.9, `${symbol} positive volume ${positive}`)

      const result = generateSweepSignals(quote.bars, DEFAULT_SWEEP_PARAMS)
      assert.equal(result.error, null)
      assertSweepObeysRules(result.bars, result.trades, DEFAULT_SWEEP_PARAMS)
      const entries = result.trades.filter((trade) => trade.direction === "long").length
      const shorts = result.trades.filter((trade) => trade.direction === "short").length
      assert.equal(result.markers.length, result.trades.length + result.trades.filter((trade) => trade.exitDate).length)
      console.log(`${symbol} sweep ${result.trades.length} trades (${entries} long, ${shorts} short)`)
    })
  }
})

function assertSweepObeysRules(bars: Bar[], trades: Trade[], params: SweepParams) {
  let previousExit = -1
  const entered = new Set<number>()

  for (const trade of trades) {
    assert.ok(trade.entryIndex > previousExit)
    entered.add(trade.entryIndex)
    const bar = bars[trade.entryIndex]
    const expectedSide = expectedSetup(bars, trade.entryIndex, params)
    assert.equal(expectedSide, trade.direction)
    assert.equal(trade.entryPrice, bar.close)

    if (trade.direction === "long") {
      const expected = longRisk(bar.close, bar.low, params.stopOffset, params.takeProfitMultiple)
      assert.equal(trade.sweptLevel, priorSwingLow(bars, trade.entryIndex, params.swingLookback))
      assert.ok(Math.abs(trade.stop - expected.stop) < 1e-6)
      assert.ok(Math.abs(trade.target - expected.target) < 1e-6)
    } else {
      const expected = shortRisk(bar.close, bar.high, params.stopOffset, params.takeProfitMultiple)
      assert.equal(trade.sweptLevel, priorSwingHigh(bars, trade.entryIndex, params.swingLookback))
      assert.ok(Math.abs(trade.stop - expected.stop) < 1e-6)
      assert.ok(Math.abs(trade.target - expected.target) < 1e-6)
    }

    if (trade.exitIndex == null) {
      assert.equal(trade, trades[trades.length - 1])
      for (let index = trade.entryIndex + 1; index < bars.length; index += 1) {
        assert.equal(closeWouldExit(trade, bars[index].close), false)
      }
      previousExit = Number.POSITIVE_INFINITY
      continue
    }

    assert.ok(trade.exitIndex > trade.entryIndex)
    for (let index = trade.entryIndex + 1; index < trade.exitIndex; index += 1) {
      assert.equal(closeWouldExit(trade, bars[index].close), false)
    }
    const exitBar = bars[trade.exitIndex]
    assert.equal(trade.exitPrice, exitBar.close)
    assert.equal(closeWouldExit(trade, exitBar.close), true)
    if (trade.exitReason === "stop") {
      if (trade.direction === "short") assert.ok(exitBar.close >= trade.stop - 1e-8)
      else assert.ok(exitBar.close <= trade.stop + 1e-8)
    } else if (trade.exitReason === "take_profit") {
      if (trade.direction === "short") assert.ok(exitBar.close <= trade.target + 1e-8)
      else assert.ok(exitBar.close >= trade.target - 1e-8)
    } else {
      assert.fail(`unexpected exit ${trade.exitReason}`)
    }
    previousExit = trade.exitIndex
  }

  let flatThrough = -1
  for (let index = 0; index < bars.length; index += 1) {
    if (index <= flatThrough) continue
    const trade = trades.find((item) => item.entryIndex === index)
    const side = expectedSetup(bars, index, params)
    if (trade) {
      assert.equal(side, trade.direction)
      flatThrough = trade.exitIndex ?? Number.POSITIVE_INFINITY
      continue
    }
    assert.equal(side, null, `${bars[index]?.date} qualified ${side} with no trade`)
  }
  assert.equal(entered.size, trades.length)
}

function closeWouldExit(trade: Trade, close: number): boolean {
  if (trade.direction === "short") return close >= trade.stop || close <= trade.target
  return close <= trade.stop || close >= trade.target
}

function expectedSetup(bars: Bar[], index: number, params: SweepParams): "long" | "short" | null {
  const swingLow = priorSwingLow(bars, index, params.swingLookback)
  const swingHigh = priorSwingHigh(bars, index, params.swingLookback)
  const average = priorAverageVolume(bars, index, params.volumePeriod)
  if (swingLow == null || swingHigh == null || average == null || !(average > 0)) return null
  const bar = bars[index]
  if (!(bar.volume >= params.volumeMultiple * average - 1e-9)) return null
  const longSweep = bar.low < swingLow && bar.close > swingLow
  const shortSweep = bar.high > swingHigh && bar.close < swingHigh
  if (longSweep === shortSweep) return null
  const stop = longSweep ? bar.low - params.stopOffset : bar.high + params.stopOffset
  const risk = longSweep ? bar.close - stop : stop - bar.close
  if (!(risk > 0)) return null
  return longSweep ? "long" : "short"
}
