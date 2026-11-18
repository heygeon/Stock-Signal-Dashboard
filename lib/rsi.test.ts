import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readCachedQuote } from "./quotes.ts"
import {
  DEFAULT_RSI_PARAMS,
  classifyReclaim,
  decideRsiTrades,
  generateRsiSignals,
  rsiParamsError,
  rsiReclaimSide,
  wilderRsi,
  type RsiDecisionRow,
} from "./rsi.ts"
import type { Bar, RsiParams, Trade } from "./types.ts"

function iso(index: number): string {
  return new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)
}

function makeBar(index: number, high: number, low: number, close: number, volume = 100): Bar {
  return { date: iso(index), open: close, high, low, close, volume }
}

function row(
  index: number,
  close: number,
  side: RsiDecisionRow["side"],
  low = close - 0.5,
  high = close + 0.5,
): RsiDecisionRow {
  return { date: iso(index), high, low, close, side }
}

const RISK = { stopOffset: 0.01, takeProfitMultiple: 2 }

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

describe("wilder RSI", () => {
  it("seeds with the first window of up and down closes, then smooths Wilder's way", () => {
    const closes = [10, 11, 12, 11, 13]
    const values = wilderRsi(closes, 3)
    assert.deepEqual(values.slice(0, 3), [null, null, null])
    assert.ok(Math.abs((values[3] as number) - (100 - 100 / 3)) < 1e-12)
    assert.ok(Math.abs((values[4] as number) - (100 - 100 / 6)) < 1e-12)
  })

  it("returns 100 when the average loss is zero, including a flat window", () => {
    assert.equal(wilderRsi([5, 5, 5, 5], 3)[3], 100)
    assert.equal(wilderRsi([5, 6, 7, 8], 3)[3], 100)
  })

  it("has no reading until there are `period` changes", () => {
    const values = wilderRsi([1, 2, 3, 4, 5], 14)
    assert.ok(values.every((value) => value == null))
  })
})

describe("RSI reclaim side", () => {
  it("buys only when RSI closes back above the oversold line", () => {
    assert.equal(rsiReclaimSide(30, 30.01, 30, 70), "long")
    assert.equal(rsiReclaimSide(18, 42, 30, 70), "long")
    assert.equal(rsiReclaimSide(30, 30, 30, 70), null)
    assert.equal(rsiReclaimSide(29, 30, 30, 70), null)
    assert.equal(rsiReclaimSide(20, 20, 30, 70), null)
    assert.equal(rsiReclaimSide(31, 29, 30, 70), null)
    assert.equal(rsiReclaimSide(40, 55, 30, 70), null)
    assert.equal(rsiReclaimSide(null, 40, 30, 70), null)
  })

  it("shorts only when RSI closes back below the overbought line", () => {
    assert.equal(rsiReclaimSide(70, 69.99, 30, 70), "short")
    assert.equal(rsiReclaimSide(82, 61, 30, 70), "short")
    assert.equal(rsiReclaimSide(70, 70, 30, 70), null)
    assert.equal(rsiReclaimSide(71, 70, 30, 70), null)
    assert.equal(rsiReclaimSide(80, 85, 30, 70), null)
    assert.equal(rsiReclaimSide(69, 74, 30, 70), null)
    assert.equal(rsiReclaimSide(60, 50, 30, 70), null)
  })

  it("skips a bar that qualifies both sides", () => {
    assert.equal(classifyReclaim(true, true), "both")
    assert.equal(classifyReclaim(true, false), "long")
    assert.equal(classifyReclaim(false, true), "short")
    assert.equal(classifyReclaim(false, false), null)
  })
})

describe("decideRsiTrades", () => {
  it("buys the reclaim and parks the stop just beyond the signal low", () => {
    const trades = decideRsiTrades([row(0, 8, "long", 7.4, 8.3)], RISK)
    const expected = longRisk(8, 7.4, 0.01, 2)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].entryPrice, 8)
    assert.equal(trades[0].wickLevel, 7.4)
    assert.ok(Math.abs(trades[0].stop - expected.stop) < 1e-9)
    assert.ok(Math.abs(trades[0].target - expected.target) < 1e-9)
    assert.equal(trades[0].exitReason, null)
  })

  it("shorts the reclaim and parks the stop just beyond the signal high", () => {
    const trades = decideRsiTrades([row(0, 12, "short", 11.4, 12.6)], RISK)
    const expected = shortRisk(12, 12.6, 0.01, 2)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "short")
    assert.equal(trades[0].entryPrice, 12)
    assert.equal(trades[0].wickLevel, 12.6)
    assert.ok(Math.abs(trades[0].stop - expected.stop) < 1e-9)
    assert.ok(Math.abs(trades[0].target - expected.target) < 1e-9)
    assert.ok(trades[0].stop > trades[0].entryPrice)
    assert.ok(trades[0].target < trades[0].entryPrice)
  })

  it("leaves the book flat when the bar qualifies both sides", () => {
    const trades = decideRsiTrades(
      [row(0, 10, "both", 9, 11), row(1, 10.4, "long", 9.8, 10.6)],
      RISK,
    )
    assert.equal(trades.length, 1)
    assert.equal(trades[0].entryIndex, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].entryPrice, 10.4)
  })

  it("does not enter a long whose close sits on the wick when the offset is zero", () => {
    const trades = decideRsiTrades([row(0, 9, "long", 9, 9.4)], { ...RISK, stopOffset: 0 })
    assert.equal(trades.length, 0)
  })

  it("places the stop on the wick when the offset is zero, and just beyond it when the offset is wider", () => {
    const onWick = decideRsiTrades([row(0, 8.5, "long", 7, 9)], { ...RISK, stopOffset: 0 })
    const wider = decideRsiTrades([row(0, 8.5, "long", 7, 9)], { ...RISK, stopOffset: 0.05 })
    assert.equal(onWick[0].stop, 7)
    assert.ok(Math.abs(wider[0].stop - 6.95) < 1e-9)
    assert.ok(wider[0].target > onWick[0].target)
  })

  it("does not stop a long out on a wick when the close holds above the stop", () => {
    const entry = row(0, 8.5, "long", 7, 9)
    const expected = longRisk(8.5, 7, 0.01, 2)
    const trades = decideRsiTrades([entry, row(1, 8.2, null, expected.stop - 1, 8.6)], RISK)
    assert.ok(trades[0].stop > expected.stop - 1)
    assert.equal(trades[0].exitReason, null)
  })

  it("stops a long when the close trades at or below the stop", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const trades = decideRsiTrades(
      [row(0, 8.5, "long", 7, 9), row(1, expected.stop, null, expected.stop - 0.2, 8)],
      RISK,
    )
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitPrice, expected.stop)
    assert.equal(trades[0].exitDate, iso(1))
  })

  it("takes profit on a long when the close reaches the target and ignores a wick through it", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const wick = decideRsiTrades(
      [row(0, 8.5, "long", 7, 9), row(1, expected.target - 0.2, null, 8, expected.target + 1)],
      RISK,
    )
    assert.equal(wick[0].exitReason, null)
    const hit = decideRsiTrades(
      [row(0, 8.5, "long", 7, 9), row(1, expected.target, null, 8, expected.target + 0.2)],
      RISK,
    )
    assert.equal(hit[0].exitReason, "take_profit")
    assert.equal(hit[0].exitPrice, expected.target)
  })

  it("does not stop a short out on a wick when the close holds below the stop", () => {
    const expected = shortRisk(9.2, 11, 0.01, 2)
    const trades = decideRsiTrades(
      [row(0, 9.2, "short", 8.6, 11), row(1, expected.stop - 0.3, null, 9, expected.stop + 1)],
      RISK,
    )
    assert.equal(trades[0].direction, "short")
    assert.equal(trades[0].exitReason, null)
  })

  it("stops a short when the close trades at or above the stop", () => {
    const expected = shortRisk(9.2, 11, 0.01, 2)
    const trades = decideRsiTrades(
      [row(0, 9.2, "short", 8.6, 11), row(1, expected.stop, null, 9, expected.stop + 0.2)],
      RISK,
    )
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitPrice, expected.stop)
  })

  it("covers a short at the target when the close reaches it", () => {
    const expected = shortRisk(9.2, 11, 0.01, 2)
    const wick = decideRsiTrades(
      [row(0, 9.2, "short", 8.6, 11), row(1, expected.target + 0.1, null, expected.target - 1, 10)],
      RISK,
    )
    assert.equal(wick[0].exitReason, null)
    const hit = decideRsiTrades(
      [row(0, 9.2, "short", 8.6, 11), row(1, expected.target, null, expected.target - 0.2, 9.4)],
      RISK,
    )
    assert.equal(hit[0].exitReason, "take_profit")
    assert.equal(hit[0].exitIndex, 1)
  })

  it("honors a different take-profit multiple", () => {
    const trades = decideRsiTrades([row(0, 8.5, "long", 7, 9)], { stopOffset: 0.01, takeProfitMultiple: 3 })
    const expected = longRisk(8.5, 7, 0.01, 3)
    assert.ok(Math.abs(trades[0].target - expected.target) < 1e-9)
  })

  it("ignores a same-direction reclaim while the trade is open", () => {
    const trades = decideRsiTrades(
      [row(0, 8.5, "long", 7, 9), row(1, 8.2, "long", 7.6, 8.4)],
      RISK,
    )
    assert.equal(trades.length, 1)
    assert.equal(trades[0].wickLevel, 7)
    assert.ok(Math.abs(trades[0].stop - longRisk(8.5, 7, 0.01, 2).stop) < 1e-9)
    assert.equal(trades[0].exitReason, null)
  })

  it("does not reverse an open long when a short reclaim prints", () => {
    const trades = decideRsiTrades(
      [row(0, 8.5, "long", 7, 9), row(1, 8.8, "short", 8.4, 9.2)],
      RISK,
    )
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "long")
    assert.equal(trades[0].exitReason, null)
    assert.ok(trades[0].stop < 8.8)
  })

  it("does not reverse an open short when a long reclaim prints", () => {
    const trades = decideRsiTrades(
      [row(0, 9.2, "short", 8.6, 11), row(1, 9, "long", 8.4, 9.3)],
      RISK,
    )
    assert.equal(trades.length, 1)
    assert.equal(trades[0].direction, "short")
    assert.equal(trades[0].exitReason, null)
  })

  it("stays flat on the exit bar even when that bar is itself a fresh long reclaim", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const trades = decideRsiTrades(
      [
        row(0, 8.5, "long", 7, 9),
        row(1, expected.stop, "long", expected.stop - 0.4, expected.stop + 0.2),
      ],
      RISK,
    )
    assert.equal(trades.length, 1)
    assert.equal(trades[0].exitIndex, 1)
    assert.equal(trades[0].exitReason, "stop")
  })

  it("stays flat after a stop until a later fresh reclaim", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const trades = decideRsiTrades(
      [
        row(0, 8.5, "long", 7, 9),
        row(1, expected.stop, "long", 6.4, 7),
        row(2, 7.2, null, 6.8, 7.4),
        row(3, 7.6, "long", 7.1, 7.8),
      ],
      RISK,
    )
    assert.equal(trades.length, 2)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].exitIndex, 1)
    assert.equal(trades[1].entryIndex, 3)
    assert.equal(trades[1].direction, "long")
    assert.equal(trades[1].entryPrice, 7.6)
    assert.equal(trades[1].wickLevel, 7.1)
    assert.equal(trades[1].exitReason, null)
  })

  it("stays flat after a take-profit until the next fresh reclaim", () => {
    const expected = longRisk(8.5, 7, 0.01, 2)
    const trades = decideRsiTrades(
      [
        row(0, 8.5, "long", 7, 9),
        row(1, expected.target, "short", expected.target - 0.4, expected.target + 0.6),
        row(2, expected.target - 0.2, null, expected.target - 0.5, expected.target),
        row(3, 12, "short", 11.4, 12.8),
      ],
      RISK,
    )
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[0].exitIndex, 1)
    assert.equal(trades.length, 2)
    assert.equal(trades[1].entryIndex, 3)
    assert.equal(trades[1].direction, "short")
    assert.ok(trades[1].entryIndex > trades[0].exitIndex)
  })
})

describe("generateRsiSignals", () => {
  const params: RsiParams = { ...DEFAULT_RSI_PARAMS, period: 2 }

  it("buys when a computed RSI closes back above 30, and not while it is still oversold", () => {
    const bars = [
      makeBar(0, 10.2, 9.8, 10),
      makeBar(1, 9.2, 8.8, 9),
      makeBar(2, 8.2, 7.8, 8),
      makeBar(3, 7.2, 6.8, 7),
      makeBar(4, 8.3, 7.4, 8),
    ]
    const result = generateRsiSignals(bars, params)
    const rsi = result.bars.map((bar) => bar.rsi)
    assert.equal(rsi[2], 0)
    assert.equal(rsi[3], 0)
    assert.equal(rsi[4], 50)
    assert.equal(result.error, null)
    assert.equal(result.trades.length, 1)
    assert.equal(result.trades[0].entryIndex, 4)
    assert.equal(result.trades[0].direction, "long")
    assert.equal(result.trades[0].entryPrice, 8)
    assert.equal(result.trades[0].wickLevel, 7.4)
    const expected = longRisk(8, 7.4, 0.01, 2)
    assert.ok(Math.abs(result.trades[0].stop - expected.stop) < 1e-9)
    assert.ok(Math.abs(result.trades[0].target - expected.target) < 1e-9)
    assert.deepEqual(
      result.markers.map((marker) => marker.label),
      ["Buy"],
    )
  })

  it("shorts when a computed RSI closes back below 70", () => {
    const bars = [
      makeBar(0, 10.2, 9.8, 10),
      makeBar(1, 11.2, 10.8, 11),
      makeBar(2, 12.2, 11.8, 12),
      makeBar(3, 13.2, 12.8, 13),
      makeBar(4, 12.6, 11.5, 12),
    ]
    const result = generateRsiSignals(bars, params)
    assert.equal(result.bars[2].rsi, 100)
    assert.equal(result.bars[3].rsi, 100)
    assert.equal(result.bars[4].rsi, 50)
    assert.equal(result.trades.length, 1)
    assert.equal(result.trades[0].direction, "short")
    assert.equal(result.trades[0].entryIndex, 4)
    assert.equal(result.trades[0].entryPrice, 12)
    assert.equal(result.trades[0].wickLevel, 12.6)
    const expected = shortRisk(12, 12.6, 0.01, 2)
    assert.ok(Math.abs(result.trades[0].stop - expected.stop) < 1e-9)
    assert.ok(Math.abs(result.trades[0].target - expected.target) < 1e-9)
    assert.deepEqual(
      result.markers.map((marker) => marker.label),
      ["Sell"],
    )
  })

  it("stops the computed long on the close and does not re-enter on that bar", () => {
    const bars = [
      makeBar(0, 10.2, 9.8, 10),
      makeBar(1, 9.2, 8.8, 9),
      makeBar(2, 8.2, 7.8, 8),
      makeBar(3, 7.2, 6.8, 7),
      makeBar(4, 8.3, 7.4, 8),
    ]
    const probe = generateRsiSignals(bars, params)
    const stop = probe.trades[0].stop
    bars.push(makeBar(5, stop + 0.2, stop - 0.4, stop, 0))
    const result = generateRsiSignals(bars, params)
    assert.equal(result.trades.length, 1)
    assert.equal(result.trades[0].exitReason, "stop")
    assert.equal(result.trades[0].exitIndex, 5)
    assert.deepEqual(
      result.markers.map((marker) => marker.label),
      ["Buy", "Stop"],
    )
  })

  it("still trades a reclaim when the history has no volume", () => {
    const bars = [
      makeBar(0, 10.2, 9.8, 10, 0),
      makeBar(1, 9.2, 8.8, 9, 0),
      makeBar(2, 8.2, 7.8, 8, 0),
      makeBar(3, 7.2, 6.8, 7, 0),
      makeBar(4, 8.3, 7.4, 8, 0),
    ]
    const result = generateRsiSignals(bars, params)
    assert.equal(result.error, null)
    assert.equal(result.trades.length, 1)
    assert.equal(result.trades[0].direction, "long")
  })

  it("labels a short cover and sorts out a bad print", () => {
    const bars: Bar[] = [
      makeBar(4, 12.6, 11.5, 12),
      { date: "bad", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      makeBar(1, 11.2, 10.8, 11),
      makeBar(0, 10.2, 9.8, 10),
      makeBar(3, 13.2, 12.8, 13),
      makeBar(2, 12.2, 11.8, 12),
    ]
    const entered = generateRsiSignals(bars, params)
    const target = entered.trades[0].target
    bars.push(makeBar(5, target + 0.3, target - 0.2, target))
    const result = generateRsiSignals(bars, params)
    assert.equal(result.trades[0].direction, "short")
    assert.equal(result.trades[0].exitReason, "take_profit")
    assert.deepEqual(
      result.markers.map((marker) => ({ label: marker.label, direction: marker.direction })),
      [
        { label: "Sell", direction: "short" },
        { label: "Cover", direction: "short" },
      ],
    )
    assert.deepEqual(
      result.bars.map((bar) => bar.date),
      [iso(0), iso(1), iso(2), iso(3), iso(4), iso(5)],
    )
  })

  it("returns no trades when the parameters are not usable", () => {
    const bars = [makeBar(0, 10, 9, 10), makeBar(1, 11, 10, 11), makeBar(2, 12, 11, 12)]
    assert.equal(rsiParamsError({ ...params, period: 1 }), "RSI period must be a whole number of at least 2.")
    assert.equal(rsiParamsError({ ...params, oversold: 0 }), "Oversold level must be between 0 and 100.")
    assert.equal(rsiParamsError({ ...params, overbought: 100 }), "Overbought level must be between 0 and 100.")
    assert.equal(
      rsiParamsError({ ...params, oversold: 70, overbought: 30 }),
      "Oversold level must be below the overbought level.",
    )
    assert.equal(rsiParamsError({ ...params, takeProfitMultiple: 0 }), "Take-profit multiple must be greater than 0.")
    assert.equal(rsiParamsError({ ...params, stopOffset: -0.01 }), "Stop offset must be zero or greater.")
    const result = generateRsiSignals(bars, { ...params, stopOffset: -1 })
    assert.equal(result.trades.length, 0)
    assert.equal(result.error, "Stop offset must be zero or greater.")
  })
})

describe("cached demo histories", () => {
  for (const symbol of ["AAPL", "0700.HK"]) {
    it(`${symbol} RSI reclaims match the rules`, async () => {
      const quote = await readCachedQuote(symbol)
      assert.ok(quote, `missing cache for ${symbol}`)
      const result = generateRsiSignals(quote.bars, DEFAULT_RSI_PARAMS)
      assert.equal(result.error, null)
      assertRsiObeysRules(result.bars, result.trades, DEFAULT_RSI_PARAMS)
      const longs = result.trades.filter((trade) => trade.direction === "long").length
      const shorts = result.trades.filter((trade) => trade.direction === "short").length
      assert.equal(result.markers.length, result.trades.length + result.trades.filter((trade) => trade.exitDate).length)
      console.log(`${symbol} rsi ${result.trades.length} trades (${longs} long, ${shorts} short)`)
    })
  }
})

function assertRsiObeysRules(
  bars: Array<Bar & { rsi?: number | null }>,
  trades: Trade[],
  params: RsiParams,
) {
  let previousExit = -1
  for (const trade of trades) {
    assert.ok(trade.entryIndex > previousExit)
    const previous = trade.entryIndex > 0 ? (bars[trade.entryIndex - 1].rsi ?? null) : null
    const side = expectedSide(previous, bars[trade.entryIndex].rsi ?? null, params)
    const risk = side === "long" || side === "short" ? expectedRisk(bars[trade.entryIndex], side, params) : null
    assert.equal(side, trade.direction)
    assert.ok(risk)
    assert.equal(trade.entryPrice, bars[trade.entryIndex].close)
    assert.equal(trade.wickLevel, trade.direction === "long" ? bars[trade.entryIndex].low : bars[trade.entryIndex].high)
    assert.ok(Math.abs(trade.stop - risk.stop) < 1e-6)
    assert.ok(Math.abs(trade.target - risk.target) < 1e-6)

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
    assert.equal(trade.exitPrice, bars[trade.exitIndex].close)
    assert.equal(trade.exitReason, closeWouldExit(trade, bars[trade.exitIndex].close))
    previousExit = trade.exitIndex
  }

  let flatThrough = -1
  for (let index = 0; index < bars.length; index += 1) {
    if (index <= flatThrough) continue
    const previous = index > 0 ? (bars[index - 1].rsi ?? null) : null
    const side = expectedSide(previous, bars[index].rsi ?? null, params)
    const tradable = side === "long" || side === "short" ? expectedRisk(bars[index], side, params) : null
    const trade = trades.find((item) => item.entryIndex === index)
    if (trade) {
      assert.ok(tradable)
      assert.equal(trade.direction, side)
      flatThrough = trade.exitIndex ?? Number.POSITIVE_INFINITY
      continue
    }
    assert.equal(tradable, null, `${bars[index]?.date} qualified ${side} with no trade`)
  }
}

function expectedSide(previous: number | null, current: number | null, params: RsiParams): "long" | "short" | "both" | null {
  if (previous == null || current == null) return null
  const long = previous <= params.oversold && current > params.oversold
  const short = previous >= params.overbought && current < params.overbought
  if (long && short) return "both"
  if (long) return "long"
  if (short) return "short"
  return null
}

function expectedRisk(bar: Bar, side: "long" | "short", params: RsiParams) {
  if (side === "long") {
    const stop = bar.low - params.stopOffset
    const risk = bar.close - stop
    if (!(risk > 0)) return null
    return { stop, target: bar.close + params.takeProfitMultiple * risk }
  }
  const stop = bar.high + params.stopOffset
  const risk = stop - bar.close
  if (!(risk > 0)) return null
  return { stop, target: bar.close - params.takeProfitMultiple * risk }
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
