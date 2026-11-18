import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readCachedQuote } from "./quotes.ts"
import { wilderAtr } from "./strategy.ts"
import {
  DEFAULT_DONCHIAN_PARAMS,
  NO_DONCHIAN_VOLUME_MESSAGE,
  decideDonchianTrades,
  donchianParamsError,
  generateDonchianSignals,
  priorAverageVolume,
  priorChannelHigh,
  priorChannelLow,
} from "./donchian.ts"
import type { Bar, DonchianParams, Trade } from "./types.ts"

function iso(index: number): string {
  return new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)
}

function makeBar(index: number, high: number, low: number, close: number, volume = 100): Bar {
  return { date: iso(index), open: close, high, low, close, volume }
}

const TIGHT: DonchianParams = {
  channelLookback: 3,
  volumePeriod: 3,
  volumeMultiple: 1.5,
  atrPeriod: 2,
  stopMultiplier: 2,
  takeProfitMultiplier: 3,
}

function quiet(count: number, volume = 100): Bar[] {
  return Array.from({ length: count }, (_, index) => makeBar(index, 10, 8, 9, volume))
}

describe("Donchian channel and volume windows", () => {
  it("uses the prior bars only and leaves the current bar out of the channel", () => {
    const bars = quiet(6)
    bars[0] = makeBar(0, 30, 1, 9, 100)
    bars[5] = makeBar(5, 18, 4, 12, 100)
    assert.equal(priorChannelHigh(bars, 5, 3), 10)
    assert.equal(priorChannelLow(bars, 5, 3), 8)
    assert.equal(priorChannelHigh(bars, 2, 3), null)
    assert.equal(priorChannelLow(bars, 2, 3), null)
    assert.equal(priorAverageVolume(bars, 5, 3), 100)
    assert.equal(priorAverageVolume(bars, 2, 3), null)
  })

  it("does not let the current volume spike dilute the average", () => {
    const bars = quiet(4, 10)
    bars[3] = makeBar(3, 10, 8, 9, 1000)
    assert.equal(priorAverageVolume(bars, 3, 3), 10)
  })
})

describe("decideDonchianTrades", () => {
  it("buys a close strictly above the prior channel high when volume confirms", () => {
    const bars = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 150)]
    const trades = decideDonchianTrades(bars, TIGHT)
    const atr = wilderAtr(bars, TIGHT.atrPeriod)[3] as number
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].entryPrice, 11)
    assert.equal(trades[0].entryDate, iso(3))
    assert.equal(trades[0].channelLevel, 10)
    assert.equal(trades[0].atrAtEntry, atr)
    assert.ok(Math.abs(trades[0].stop - (11 - 2 * atr)) < 1e-9)
    assert.ok(Math.abs(trades[0].target - (11 + 3 * atr)) < 1e-9)
    assert.ok(trades[0].stop < trades[0].entryPrice)
    assert.ok(trades[0].target > trades[0].entryPrice)
    assert.equal(trades[0].exitReason, null)
  })

  it("shorts a close strictly below the prior channel low when volume confirms", () => {
    const bars = [...quiet(3), makeBar(3, 9, 7, 7.5, 150)]
    const trades = decideDonchianTrades(bars, TIGHT)
    const atr = wilderAtr(bars, TIGHT.atrPeriod)[3] as number
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "short")
    assert.equal(trades[0].entryPrice, 7.5)
    assert.equal(trades[0].channelLevel, 8)
    assert.equal(trades[0].atrAtEntry, atr)
    assert.ok(Math.abs(trades[0].stop - (7.5 + 2 * atr)) < 1e-9)
    assert.ok(Math.abs(trades[0].target - (7.5 - 3 * atr)) < 1e-9)
    assert.ok(trades[0].stop > trades[0].entryPrice)
    assert.ok(trades[0].target < trades[0].entryPrice)
  })

  it("requires the volume multiple against the prior average, not an average that includes the spike", () => {
    const base = quiet(3, 100)
    const passing = decideDonchianTrades([...base, makeBar(3, 11.5, 10.5, 11, 150)], TIGHT)
    const failing = decideDonchianTrades([...base, makeBar(3, 11.5, 10.5, 11, 149)], TIGHT)
    assert.equal(passing.length, 1)
    assert.equal(failing.length, 0)
    assert.equal(priorAverageVolume([...base, makeBar(3, 11.5, 10.5, 11, 150)], 3, 3), 100)
  })

  it("ignores a breakout that only matches the average volume", () => {
    const bars = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 100)]
    assert.equal(decideDonchianTrades(bars, TIGHT).length, 0)
  })

  it("does not treat a touch of the prior high or low as a breakout", () => {
    const touchHigh = [...quiet(3), makeBar(3, 12, 9, 10, 500)]
    const touchLow = [...quiet(3), makeBar(3, 9, 7, 8, 500)]
    assert.equal(priorChannelHigh(touchHigh, 3, 3), 10)
    assert.equal(priorChannelLow(touchLow, 3, 3), 8)
    assert.equal(decideDonchianTrades(touchHigh, TIGHT).length, 0)
    assert.equal(decideDonchianTrades(touchLow, TIGHT).length, 0)
  })

  it("does not enter on a wick through the channel when the close holds inside it", () => {
    const bars = [...quiet(3), makeBar(3, 12, 7, 9.2, 500)]
    assert.ok(bars[3].high > 10)
    assert.ok(bars[3].low < 8)
    assert.equal(decideDonchianTrades(bars, TIGHT).length, 0)
  })

  it("keeps an older high outside the lookback from blocking a breakout, and ignores the current high", () => {
    const bars = quiet(4)
    bars[0] = makeBar(0, 40, 8, 9, 10000)
    bars.push(makeBar(4, 14, 10.2, 11, 500))
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(priorChannelHigh(bars, 4, 3), 10)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].channelLevel, 10)
    assert.equal(trades[0].direction, "long")
  })

  it("uses the default 20-session channel and 20-session volume window", () => {
    const bars = quiet(21)
    bars[0] = makeBar(0, 40, 1, 9, 10000)
    bars.push(makeBar(21, 12, 9.4, 11, 150))
    const trades = decideDonchianTrades(bars, DEFAULT_DONCHIAN_PARAMS)
    assert.equal(priorChannelHigh(bars, 21, 20), 10)
    assert.equal(priorAverageVolume(bars, 21, 20), 100)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].channelLevel, 10)
    assert.equal(trades[0].entryPrice, 11)
    const atr = wilderAtr(bars, 14)[21] as number
    assert.equal(trades[0].atrAtEntry, atr)
    assert.ok(Math.abs(trades[0].stop - (11 - 2 * atr)) < 1e-8)
    assert.ok(Math.abs(trades[0].target - (11 + 3 * atr)) < 1e-8)
  })

  it("does not enter before the channel, volume, and ATR windows are all ready", () => {
    const early = [...quiet(2), makeBar(2, 12, 10, 11, 500)]
    assert.equal(decideDonchianTrades(early, TIGHT).length, 0)
    const waitingOnAtr = [...quiet(5), makeBar(5, 12, 10, 11, 500)]
    assert.equal(decideDonchianTrades(waitingOnAtr, { ...TIGHT, atrPeriod: 14 }).length, 0)
    assert.equal(decideDonchianTrades(waitingOnAtr, TIGHT).length, 1)
  })

  it("stores the entry bar's ATR and ignores a later bar's range", () => {
    const bars = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200), makeBar(4, 30, 2, 12, 50)]
    const trades = decideDonchianTrades(bars, TIGHT)
    const atr = wilderAtr(bars, TIGHT.atrPeriod)
    assert.equal(trades[0].atrAtEntry, atr[3])
    assert.notEqual(trades[0].atrAtEntry, atr[4])
    assert.ok(Math.abs(trades[0].stop - (11 - 2 * (atr[3] as number))) < 1e-9)
  })

  it("does not stop a long out on a wick when the close holds above the stop", () => {
    const entered = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const stop = 11 - 2 * atr
    const bars = [...entered, makeBar(4, 12, stop - 2, stop + 0.4, 80)]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.ok(bars[4].low < trades[0].stop)
    assert.ok(bars[4].close > trades[0].stop)
    assert.equal(trades[0].exitReason, null)
  })

  it("stops a long when the close trades at or below the stop", () => {
    const entered = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const stop = 11 - 2 * atr
    const bars = [...entered, makeBar(4, stop + 0.2, stop - 1, stop, 80)]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitPrice, stop)
    assert.equal(trades[0].exitDate, iso(4))
  })

  it("does not take a long profit on a wick when the close holds below the target", () => {
    const entered = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const target = 11 + 3 * atr
    const bars = [...entered, makeBar(4, target + 2, 10, target - 0.5, 80)]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.ok(bars[4].high > trades[0].target)
    assert.ok(bars[4].close < trades[0].target)
    assert.equal(trades[0].exitReason, null)
  })

  it("takes profit on a long when the close reaches the target", () => {
    const entered = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const target = 11 + 3 * atr
    const bars = [...entered, makeBar(4, target + 0.4, target - 1, target, 80)]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[0].exitPrice, target)
  })

  it("does not stop a short out on a wick when the close holds below the stop", () => {
    const entered = [...quiet(3), makeBar(3, 9, 7, 7.5, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const stop = 7.5 + 2 * atr
    const bars = [...entered, makeBar(4, stop + 2, 7, stop - 0.4, 80)]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(trades[0].direction, "short")
    assert.ok(bars[4].high > trades[0].stop)
    assert.ok(bars[4].close < trades[0].stop)
    assert.equal(trades[0].exitReason, null)
  })

  it("stops a short when the close trades at or above the stop", () => {
    const entered = [...quiet(3), makeBar(3, 9, 7, 7.5, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const stop = 7.5 + 2 * atr
    const bars = [...entered, makeBar(4, stop + 0.4, stop - 1, stop, 80)]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitPrice, stop)
  })

  it("covers a short at the target when the close reaches it, and ignores a wick through it", () => {
    const entered = [...quiet(3), makeBar(3, 9, 7, 7.5, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const target = 7.5 - 3 * atr
    const wick = [...entered, makeBar(4, 8, target - 1, target + 0.4, 40)]
    const held = decideDonchianTrades(wick, TIGHT)
    assert.ok(wick[4].low < held[0].target)
    assert.equal(held[0].exitReason, null)
    const hit = [...entered, makeBar(4, target + 0.5, target - 0.2, target, 40)]
    const trades = decideDonchianTrades(hit, TIGHT)
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[0].exitPrice, target)
  })

  it("honors a tighter stop multiplier and a different target multiple", () => {
    const bars = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    const trades = decideDonchianTrades(bars, { ...TIGHT, stopMultiplier: 1, takeProfitMultiplier: 4 })
    const atr = trades[0].atrAtEntry
    assert.ok(Math.abs(trades[0].stop - (11 - atr)) < 1e-9)
    assert.ok(Math.abs(trades[0].target - (11 + 4 * atr)) < 1e-9)
  })

  it("ignores a later breakout while the trade is open and keeps the original stop", () => {
    const bars = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200), makeBar(4, 13, 11.2, 12.4, 400)]
    const trades = decideDonchianTrades(bars, TIGHT)
    const atr = wilderAtr(bars, TIGHT.atrPeriod)[3] as number
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].exitReason, null)
    assert.ok(Math.abs(trades[0].stop - (11 - 2 * atr)) < 1e-9)
    assert.ok(bars[4].close > (priorChannelHigh(bars, 4, 3) as number))
  })

  it("does not reverse an open long when a short breakout prints above the stop", () => {
    const bars = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200), makeBar(4, 9, 7.2, 7.5, 400)]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(priorChannelLow(bars, 4, 3), 8)
    assert.ok(bars[4].close < 8)
    assert.ok(bars[4].close > trades[0].stop)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].exitReason, null)
  })

  it("does not reverse an open short when a long breakout prints below the stop", () => {
    const bars = [...quiet(3), makeBar(3, 9, 7, 7.5, 200), makeBar(4, 11, 9.2, 10.5, 400)]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(priorChannelHigh(bars, 4, 3), 10)
    assert.ok(bars[4].close > 10)
    assert.ok(bars[4].close < trades[0].stop)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "short")
    assert.equal(trades[0].exitReason, null)
  })

  it("stays flat on the exit bar even when that bar is itself a fresh short breakout", () => {
    const entered = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    const crash = makeBar(4, 6, 1, 1, 500)
    const bars = [...entered, crash]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].exitIndex, 4)
    assert.equal(trades[0].exitReason, "stop")
    assert.ok(crash.close <= trades[0].stop)
    assert.ok(crash.close < (priorChannelLow(bars, 4, 3) as number))
    const average = priorAverageVolume(bars, 4, 3) as number
    assert.ok(crash.volume >= 1.5 * average)
  })

  it("stays flat after a stop until a later bar breaks out on its own", () => {
    const bars = [
      ...quiet(3),
      makeBar(3, 11.5, 10.5, 11, 200),
      makeBar(4, 6, 1, 1, 500),
      makeBar(5, 4, 2, 3, 100),
      makeBar(6, 4, 2, 3, 100),
      makeBar(7, 4, 2, 3, 100),
      makeBar(8, 6, 3.5, 5, 400),
    ]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(trades.length, 2)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitIndex, 4)
    assert.ok(trades[1].entryIndex > trades[0].exitIndex)
    assert.equal(trades[1].direction, "long")
    assert.equal(trades[1].entryPrice, 5)
    assert.equal(trades[1].channelLevel, priorChannelHigh(bars, trades[1].entryIndex, 3))
    assert.equal(trades[1].exitReason, null)
  })

  it("stays flat after a take-profit until the next fresh breakout", () => {
    const entered = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const target = 11 + 3 * atr
    const bars = [
      ...entered,
      makeBar(4, target + 1, target - 2, target, 100),
      makeBar(5, target, target - 1, target - 0.5, 100),
      makeBar(6, target, target - 1, target - 0.5, 100),
      makeBar(7, target, target - 1, target - 0.5, 100),
      makeBar(8, target + 2, target - 0.4, target + 1, 400),
    ]
    const trades = decideDonchianTrades(bars, TIGHT)
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[0].exitIndex, 4)
    assert.equal(trades.length, 2)
    assert.ok(trades[1].entryIndex > 4)
    assert.equal(trades[1].direction, "long")
  })

  it("does not confirm a breakout against a zero-volume baseline", () => {
    const bars = [...quiet(3, 0), makeBar(3, 11.5, 10.5, 11, 0)]
    assert.equal(decideDonchianTrades(bars, TIGHT).length, 0)
  })
})

describe("generateDonchianSignals", () => {
  it("sorts bars, drops a bad print, and labels the long exit", () => {
    const seed = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    const atr = wilderAtr(seed, TIGHT.atrPeriod)[3] as number
    const stop = 11 - 2 * atr
    const bars: Bar[] = [
      makeBar(3, 11.5, 10.5, 11, 200),
      { date: "bad", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      makeBar(1, 10, 8, 9, 100),
      { date: iso(2), open: Number.NaN, high: 1, low: 1, close: 1, volume: 1 },
      makeBar(0, 10, 8, 9, 100),
      makeBar(2, 10, 8, 9, 100),
      makeBar(4, stop + 0.2, stop - 1, stop, 40),
    ]
    const result = generateDonchianSignals(bars, TIGHT)
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
    assert.equal(result.bars[3].channelHigh, 10)
  })

  it("labels a short entry as Sell and the exit as Cover", () => {
    const entered = [...quiet(3), makeBar(3, 9, 7, 7.5, 200)]
    const atr = wilderAtr(entered, TIGHT.atrPeriod)[3] as number
    const target = 7.5 - 3 * atr
    const bars = [...entered, makeBar(4, target + 0.4, target - 0.2, target, 40)]
    const result = generateDonchianSignals(bars, TIGHT)
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
    const bars = [...quiet(4, 0)]
    bars[3] = makeBar(3, 11.5, 10.5, 11, 0)
    const missing = generateDonchianSignals(bars, TIGHT)
    assert.equal(missing.trades.length, 0)
    assert.equal(missing.markers.length, 0)
    assert.equal(missing.error, NO_DONCHIAN_VOLUME_MESSAGE)
    assert.equal(missing.bars.length, 4)

    const blanked = bars.map((bar) => ({ ...bar, volume: Number.NaN }))
    const coerced = generateDonchianSignals(blanked, TIGHT)
    assert.equal(coerced.error, NO_DONCHIAN_VOLUME_MESSAGE)
    assert.equal(coerced.trades.length, 0)
  })

  it("keeps running when only some sessions printed zero volume", () => {
    const bars = [...quiet(3, 0), makeBar(3, 10, 8, 9, 100), makeBar(4, 10, 8, 9, 100), makeBar(5, 10, 8, 9, 100)]
    const result = generateDonchianSignals(bars, TIGHT)
    assert.equal(result.error, null)
    assert.equal(result.trades.length, 0)
  })

  it("returns no trades when the parameters are not usable", () => {
    const bars = [...quiet(3), makeBar(3, 11.5, 10.5, 11, 200)]
    assert.equal(
      donchianParamsError({ ...TIGHT, channelLookback: 1 }),
      "Channel lookback must be a whole number of at least 2.",
    )
    assert.equal(
      donchianParamsError({ ...TIGHT, volumePeriod: 1.5 }),
      "Volume average period must be a whole number of at least 2.",
    )
    assert.equal(donchianParamsError({ ...TIGHT, volumeMultiple: 0 }), "Volume multiple must be greater than 0.")
    assert.equal(
      donchianParamsError({ ...TIGHT, atrPeriod: 1 }),
      "ATR period must be a whole number of at least 2.",
    )
    assert.equal(donchianParamsError({ ...TIGHT, stopMultiplier: 0 }), "Stop multiplier must be greater than 0.")
    assert.equal(
      donchianParamsError({ ...TIGHT, takeProfitMultiplier: 0 }),
      "Take-profit multiplier must be greater than 0.",
    )
    const result = generateDonchianSignals(bars, { ...TIGHT, channelLookback: 0 })
    assert.equal(result.trades.length, 0)
    assert.equal(result.error, "Channel lookback must be a whole number of at least 2.")
  })
})

describe("cached demo histories", () => {
  for (const symbol of ["AAPL", "0700.HK"]) {
    it(`${symbol} has real volume and every Donchian trade matches the rules`, async () => {
      const quote = await readCachedQuote(symbol)
      assert.ok(quote, `missing cache for ${symbol}`)
      const positive = quote.bars.filter((bar) => bar.volume > 0).length
      assert.ok(positive > quote.bars.length * 0.9, `${symbol} positive volume ${positive}`)

      const result = generateDonchianSignals(quote.bars, DEFAULT_DONCHIAN_PARAMS)
      assert.equal(result.error, null)
      assertDonchianObeysRules(result.bars, result.trades, DEFAULT_DONCHIAN_PARAMS)
      const longs = result.trades.filter((trade) => trade.direction === "long").length
      const shorts = result.trades.filter((trade) => trade.direction === "short").length
      assert.equal(result.markers.length, result.trades.length + result.trades.filter((trade) => trade.exitDate).length)
      console.log(`${symbol} donchian ${result.trades.length} trades (${longs} long, ${shorts} short)`)
    })
  }
})

function assertDonchianObeysRules(bars: Bar[], trades: Trade[], params: DonchianParams) {
  const atr = wilderAtr(bars, params.atrPeriod)
  let previousExit = -1

  for (const trade of trades) {
    assert.ok(trade.entryIndex > previousExit)
    const side = expectedSetup(bars, trade.entryIndex, atr[trade.entryIndex], params)
    assert.equal(side, trade.direction)
    assert.equal(trade.entryPrice, bars[trade.entryIndex].close)
    assert.equal(trade.atrAtEntry, atr[trade.entryIndex])
    const level =
      side === "long"
        ? priorChannelHigh(bars, trade.entryIndex, params.channelLookback)
        : priorChannelLow(bars, trade.entryIndex, params.channelLookback)
    assert.equal(trade.channelLevel, level)
    const signed = side === "long" ? 1 : -1
    assert.ok(Math.abs(trade.stop - (trade.entryPrice - signed * params.stopMultiplier * trade.atrAtEntry)) < 1e-6)
    assert.ok(Math.abs(trade.target - (trade.entryPrice + signed * params.takeProfitMultiplier * trade.atrAtEntry)) < 1e-6)

    if (trade.exitIndex == null) {
      assert.equal(trade, trades[trades.length - 1])
      for (let cursor = trade.entryIndex + 1; cursor < bars.length; cursor += 1) {
        assert.equal(closeWouldExit(trade, bars[cursor].close), null)
      }
      previousExit = Number.POSITIVE_INFINITY
      continue
    }

    assert.ok(trade.exitIndex > trade.entryIndex)
    for (let cursor = trade.entryIndex + 1; cursor < trade.exitIndex; cursor += 1) {
      assert.equal(closeWouldExit(trade, bars[cursor].close), null)
    }
    const exitBar = bars[trade.exitIndex]
    assert.equal(trade.exitPrice, exitBar.close)
    assert.equal(trade.exitReason, closeWouldExit(trade, exitBar.close))
    previousExit = trade.exitIndex
  }

  let flatThrough = -1
  for (let index = 0; index < bars.length; index += 1) {
    if (index <= flatThrough) continue
    const trade = trades.find((item) => item.entryIndex === index)
    const side = expectedSetup(bars, index, atr[index], params)
    if (trade) {
      assert.equal(side, trade.direction)
      flatThrough = trade.exitIndex ?? Number.POSITIVE_INFINITY
      continue
    }
    assert.equal(side, null, `${bars[index]?.date} qualified ${side} with no trade`)
  }
}

function closeWouldExit(trade: Trade, close: number): "stop" | "take_profit" | null {
  if (trade.direction === "short") {
    if (close >= trade.stop) return "stop"
    if (close <= trade.target) return "take_profit"
    return null
  }
  if (close <= trade.stop) return "stop"
  if (close >= trade.target) return "take_profit"
  return null
}

function expectedSetup(
  bars: Bar[],
  index: number,
  atr: number | null,
  params: DonchianParams,
): "long" | "short" | null {
  if (atr == null || !(atr > 0)) return null
  const channelHigh = priorChannelHigh(bars, index, params.channelLookback)
  const channelLow = priorChannelLow(bars, index, params.channelLookback)
  const average = priorAverageVolume(bars, index, params.volumePeriod)
  if (channelHigh == null || channelLow == null || average == null || !(average > 0)) return null
  const bar = bars[index]
  if (!(bar.volume >= params.volumeMultiple * average - 1e-9)) return null
  const longBreak = bar.close > channelHigh
  const shortBreak = bar.close < channelLow
  if (longBreak === shortBreak) return null
  return longBreak ? "long" : "short"
}
