import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readCachedQuote } from "./quotes.ts"
import { DEFAULT_PARAMS, generateSignals } from "./strategy.ts"
import type { SignalResult, StrategyParams } from "./types.ts"

function assertObeysRules(result: SignalResult, params: StrategyParams) {
  const { bars, trades, markers } = result
  let previousExit = -1
  for (const trade of trades) {
    assert.ok(trade.entryIndex > previousExit)
    const entryBar = bars[trade.entryIndex]
    const previous = bars[trade.entryIndex - 1]
    assert.ok(previous)
    assert.equal(trade.entryPrice, entryBar.close)
    assert.equal(trade.atrAtEntry, entryBar.atr)
    assert.ok((previous.emaFast as number) <= (previous.emaSlow as number))
    assert.ok((entryBar.emaFast as number) > (entryBar.emaSlow as number))
    assert.ok(Math.abs(trade.stop - (trade.entryPrice - params.stopMultiplier * trade.atrAtEntry)) < 1e-8)
    assert.ok(
      Math.abs(trade.target - (trade.entryPrice + params.takeProfitMultiplier * trade.atrAtEntry)) < 1e-8,
    )
    assert.ok(trade.target > trade.stop)

    if (trade.exitIndex == null) {
      assert.equal(trade, trades[trades.length - 1])
      assert.equal(trade.exitReason, null)
      previousExit = Number.POSITIVE_INFINITY
      continue
    }

    assert.ok(trade.exitIndex > trade.entryIndex)
    for (let index = trade.entryIndex + 1; index < trade.exitIndex; index += 1) {
      const bar = bars[index]
      const prior = bars[index - 1]
      assert.equal(crossedDown(prior.emaFast, prior.emaSlow, bar.emaFast, bar.emaSlow), false)
      assert.ok(bar.close > trade.stop)
      assert.ok(bar.close < trade.target)
    }

    const exitBar = bars[trade.exitIndex]
    const exitPrior = bars[trade.exitIndex - 1]
    const exitCross = crossedDown(exitPrior.emaFast, exitPrior.emaSlow, exitBar.emaFast, exitBar.emaSlow)
    assert.equal(trade.exitPrice, exitBar.close)
    if (trade.exitReason === "ema_cross") {
      assert.equal(exitCross, true)
    } else if (trade.exitReason === "stop") {
      assert.equal(exitCross, false)
      assert.ok(exitBar.close <= trade.stop + 1e-8)
    } else if (trade.exitReason === "take_profit") {
      assert.equal(exitCross, false)
      assert.ok(exitBar.close >= trade.target - 1e-8)
      assert.ok(exitBar.close > trade.stop)
    } else {
      assert.fail(`unexpected exit reason ${trade.exitReason}`)
    }
    previousExit = trade.exitIndex
  }

  const expectedMarkers = trades.length + trades.filter((trade) => trade.exitDate).length
  assert.equal(markers.length, expectedMarkers)
  assert.deepEqual(
    result.levelsTrade,
    trades.length > 0 ? trades[trades.length - 1] : null,
  )
}

function crossedDown(
  previousFast: number | null,
  previousSlow: number | null,
  fast: number | null,
  slow: number | null,
): boolean {
  if (previousFast == null || previousSlow == null || fast == null || slow == null) return false
  return previousFast >= previousSlow && fast < slow
}

describe("cached demo histories", () => {
  for (const symbol of ["AAPL", "0700.HK"]) {
    it(`${symbol} follows the crossover, stop, and target rules`, async () => {
      const quote = await readCachedQuote(symbol)
      assert.ok(quote, `missing cache for ${symbol}`)
      assert.ok(quote.bars.length > 400, `${symbol} bars ${quote.bars.length}`)
      const span =
        Date.parse(`${quote.bars[quote.bars.length - 1].date}T00:00:00Z`) -
        Date.parse(`${quote.bars[0].date}T00:00:00Z`)
      assert.ok(span > 600 * 86_400_000)

      const result = generateSignals(quote.bars, DEFAULT_PARAMS)
      assertObeysRules(result, DEFAULT_PARAMS)
      assert.ok(result.trades.length >= 1, `${symbol} produced no entries`)
      assert.ok(
        result.markers.some((marker) => marker.side === "entry"),
        `${symbol} has no buy marker`,
      )
      assert.ok(result.levelsTrade, `${symbol} has no level trade`)
      console.log(
        [
          `${symbol} ${quote.bars.length} bars ${quote.bars[0].date} → ${quote.bars[quote.bars.length - 1].date}`,
          ...result.trades.map(
            (trade) =>
              `#${trade.id} ${trade.entryDate} @ ${trade.entryPrice} stop ${trade.stop.toFixed(2)} target ${trade.target.toFixed(2)} → ${trade.exitDate ?? "open"} ${trade.exitReason ?? "open"}`,
          ),
        ].join("\n"),
      )
    })
  }
})
