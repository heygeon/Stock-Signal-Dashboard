import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Bar, DecisionRow } from "./types.ts"
import {
  DEFAULT_PARAMS,
  decideTrades,
  ema,
  generateSignals,
  paramsError,
  summarizeTrades,
  wilderAtr,
} from "./strategy.ts"

function row(
  date: string,
  close: number,
  fast: number | null,
  slow: number | null,
  atr: number | null,
): DecisionRow {
  return { date, close, emaFast: fast, emaSlow: slow, atr }
}

function ohlc(date: string, close: number, low = close - 0.4, high = close + 0.4): Bar {
  return { date, open: close, high, low, close, volume: 1 }
}

describe("ema", () => {
  it("seeds with an SMA and then applies the standard multiplier", () => {
    const values = ema([1, 2, 3, 4, 5, 6], 3)
    assert.deepEqual(values.slice(0, 2), [null, null])
    assert.equal(values[2], 2)
    assert.equal(values[3], 3)
    assert.equal(values[4], 4)
    assert.equal(values[5], 5)
  })
})

describe("wilder ATR", () => {
  it("averages the first window and then smooths with Wilder's formula", () => {
    const bars = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 12, low: 8, close: 11 },
      { high: 13, low: 10, close: 12 },
      { high: 11, low: 9, close: 10 },
    ]
    const values = wilderAtr(bars, 3)
    assert.deepEqual(values.slice(0, 2), [null, null])
    assert.ok(Math.abs((values[2] as number) - 8 / 3) < 1e-12)
    assert.ok(Math.abs((values[3] as number) - 25 / 9) < 1e-12)
    assert.ok(Math.abs((values[4] as number) - 77 / 27) < 1e-12)
  })
})

describe("decideTrades", () => {
  const params = { stopMultiplier: 2, takeProfitMultiplier: 3 }

  it("buys a fresh cross and exits on a cross back down", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 2),
        row("2024-01-02", 101, 11, 10, 2),
        row("2024-01-03", 102, 12, 10, 2),
        row("2024-01-04", 100, 9, 10, 2),
      ],
      params,
    )
    assert.equal(trades.length, 1)
    assert.equal(trades[0].entryPrice, 101)
    assert.equal(trades[0].atrAtEntry, 2)
    assert.equal(trades[0].stop, 97)
    assert.equal(trades[0].target, 107)
    assert.equal(trades[0].exitReason, "ema_cross")
    assert.equal(trades[0].exitPrice, 100)
  })

  it("treats an equal fast EMA as still below the cross, then buys the next push above", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 10, 10, 1),
        row("2024-01-02", 100, 11, 10, 1),
      ],
      params,
    )
    assert.equal(trades.length, 1)
    assert.equal(trades[0].entryDate, "2024-01-02")
  })

  it("does not enter just because the fast EMA is already above the slow EMA", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 12, 10, 1),
        row("2024-01-02", 101, 13, 10, 1),
      ],
      params,
    )
    assert.equal(trades.length, 0)
  })

  it("exits at the stop when the close touches entry minus the entry ATR band", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 2),
        row("2024-01-02", 100, 12, 10, 2),
        row("2024-01-03", 97.01, 12, 10, 9),
        row("2024-01-04", 96, 12, 10, 9),
      ],
      params,
    )
    assert.equal(trades.length, 1)
    assert.equal(trades[0].stop, 96)
    assert.equal(trades[0].exitDate, "2024-01-04")
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[0].atrAtEntry, 2)
  })

  it("takes profit when the close reaches entry plus the entry ATR band", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 2),
        row("2024-01-02", 100, 12, 10, 2),
        row("2024-01-03", 107, 13, 10, 1),
      ],
      params,
    )
    assert.equal(trades[0].target, 106)
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[0].exitPrice, 107)
  })

  it("prefers the EMA cross when the close also hits the stop on that bar", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 2),
        row("2024-01-02", 100, 12, 10, 2),
        row("2024-01-03", 90, 9, 10, 2),
      ],
      params,
    )
    assert.equal(trades[0].exitReason, "ema_cross")
  })

  it("stays flat after a stop until the next fresh cross", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 2),
        row("2024-01-02", 100, 12, 10, 2),
        row("2024-01-03", 96, 13, 10, 2),
        row("2024-01-04", 101, 14, 10, 2),
        row("2024-01-05", 101, 10, 10, 2),
        row("2024-01-06", 103, 12, 10, 2),
      ],
      params,
    )
    assert.equal(trades.length, 2)
    assert.equal(trades[0].exitReason, "stop")
    assert.equal(trades[1].entryDate, "2024-01-06")
    assert.equal(trades[1].exitReason, null)
  })

  it("stays flat after a take-profit until the next fresh cross", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 2),
        row("2024-01-02", 100, 12, 10, 2),
        row("2024-01-03", 110, 13, 10, 2),
        row("2024-01-04", 111, 14, 10, 2),
        row("2024-01-05", 100, 9, 10, 2),
        row("2024-01-06", 112, 12, 10, 2),
      ],
      params,
    )
    assert.equal(trades[0].exitReason, "take_profit")
    assert.equal(trades[1].entryDate, "2024-01-06")
  })

  it("holds through an equal EMA and exits on the following cross down", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 1),
        row("2024-01-02", 100, 12, 10, 1),
        row("2024-01-03", 100, 10, 10, 1),
        row("2024-01-04", 100, 9, 10, 1),
      ],
      params,
    )
    assert.equal(trades[0].exitDate, "2024-01-04")
    assert.equal(trades[0].exitReason, "ema_cross")
  })

  it("does not enter when ATR is missing on the cross bar", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 1),
        row("2024-01-02", 100, 12, 10, null),
      ],
      params,
    )
    assert.equal(trades.length, 0)
  })

  it("honors a tighter stop multiplier", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 2),
        row("2024-01-02", 100, 12, 10, 2),
        row("2024-01-03", 99, 12, 10, 2),
      ],
      { stopMultiplier: 0.5, takeProfitMultiplier: 3 },
    )
    assert.equal(trades[0].stop, 99)
    assert.equal(trades[0].exitReason, "stop")
  })

  it("can re-enter on the bar after an EMA-cross exit", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 1),
        row("2024-01-02", 100, 12, 10, 1),
        row("2024-01-03", 100, 9, 10, 1),
        row("2024-01-04", 100, 12, 10, 1),
      ],
      params,
    )
    assert.equal(trades.length, 2)
    assert.equal(trades[0].exitReason, "ema_cross")
    assert.equal(trades[1].entryDate, "2024-01-04")
  })
})

describe("generateSignals", () => {
  it("sorts bars, drops bad prints, and refuses an inverted EMA pair", () => {
    const bars: Bar[] = [
      ohlc("2024-01-03", 3),
      { date: "2024-01-04", open: Number.NaN, high: 1, low: 1, close: 1, volume: 1 },
      ohlc("2024-01-01", 1),
      { date: "bad", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ohlc("2024-01-02", 2),
    ]
    const result = generateSignals(bars, {
      ...DEFAULT_PARAMS,
      fastPeriod: 2,
      slowPeriod: 3,
      atrPeriod: 2,
    })
    assert.deepEqual(
      result.bars.map((bar) => bar.date),
      ["2024-01-01", "2024-01-02", "2024-01-03"],
    )
    assert.equal(paramsError({ ...DEFAULT_PARAMS, fastPeriod: 50, slowPeriod: 20 }), "Fast EMA must be shorter than the slow EMA.")
    const empty = generateSignals(bars, { ...DEFAULT_PARAMS, fastPeriod: 60, slowPeriod: 20 })
    assert.equal(empty.trades.length, 0)
  })

  it("wires EMA and ATR into a cross up and a later cross down", () => {
    const bars: Bar[] = []
    let price = 50
    for (let index = 0; index < 80; index += 1) bars.push(ohlc(iso(index), price))
    for (let index = 80; index < 130; index += 1) {
      price += 1
      bars.push(ohlc(iso(index), price))
    }
    for (let index = 130; index < 200; index += 1) {
      price -= 1.4
      bars.push(ohlc(iso(index), price))
    }
    const result = generateSignals(bars, DEFAULT_PARAMS)
    assert.ok(result.trades.length >= 1)
    const entry = result.trades[0]
    const entryBar = result.bars[entry.entryIndex]
    const previous = result.bars[entry.entryIndex - 1]
    assert.ok((previous.emaFast as number) <= (previous.emaSlow as number))
    assert.ok((entryBar.emaFast as number) > (entryBar.emaSlow as number))
    assert.equal(entry.atrAtEntry, entryBar.atr)
    assert.ok(Math.abs(entry.stop - (entry.entryPrice - 2 * entry.atrAtEntry)) < 1e-8)
    assert.ok(result.markers.some((marker) => marker.label === "Buy"))
    assert.ok(result.levelsTrade)
  })

  it("does not stop out on a wick when the close holds above the stop", () => {
    const bars: Bar[] = []
    let price = 40
    for (let index = 0; index < 70; index += 1) bars.push(ohlc(iso(index), price))
    for (let index = 70; index < 120; index += 1) {
      price += 0.8
      bars.push(ohlc(iso(index), price))
    }
    const probe = generateSignals(bars, DEFAULT_PARAMS)
    const entry = probe.trades.find((trade) => trade.exitIndex == null) ?? probe.trades[0]
    assert.ok(entry, "expected a crossover entry")
    const previousClose = bars[bars.length - 1].close
    assert.ok(previousClose > entry.stop)
    const next = iso(bars.length)
    bars.push({
      date: next,
      open: previousClose,
      high: previousClose + 0.3,
      low: entry.stop - 8,
      close: previousClose,
      volume: 1,
    })
    const result = generateSignals(bars, DEFAULT_PARAMS)
    const trade = result.trades.find((item) => item.entryDate === entry.entryDate)
    assert.ok(trade)
    assert.ok(bars[bars.length - 1].low < trade.stop)
    assert.ok(bars[bars.length - 1].close > trade.stop)
    assert.notEqual(trade.exitDate, next)
  })
})

describe("summarizeTrades", () => {
  it("counts a win only when the exit close is above the entry", () => {
    const trades = decideTrades(
      [
        row("2024-01-01", 100, 9, 10, 2),
        row("2024-01-02", 100, 12, 10, 2),
        row("2024-01-03", 110, 13, 10, 2),
        row("2024-01-04", 100, 9, 10, 2),
        row("2024-01-05", 100, 12, 10, 2),
        row("2024-01-06", 96, 13, 10, 2),
      ],
      { stopMultiplier: 2, takeProfitMultiplier: 3 },
    )
    const summary = summarizeTrades(trades, 96)
    assert.equal(summary.entries, 2)
    assert.equal(summary.exits, 2)
    assert.equal(summary.wins, 1)
    assert.equal(summary.winRate, 0.5)
    assert.equal(summary.open, null)
  })
})

function iso(index: number): string {
  const date = new Date(Date.UTC(2024, 0, 1 + index))
  return date.toISOString().slice(0, 10)
}
