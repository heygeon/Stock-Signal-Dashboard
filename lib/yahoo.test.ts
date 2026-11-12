import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { barDate, parseYahooChart } from "./yahoo.ts"

describe("parseYahooChart", () => {
  it("dates bars in the exchange timezone and drops empty prints", () => {
    const epoch = Date.parse("2024-11-12T14:30:00Z") / 1000
    const quote = parseYahooChart("aapl", {
      chart: {
        result: [
          {
            meta: {
              symbol: "AAPL",
              longName: "Apple Inc.",
              currency: "USD",
              fullExchangeName: "NasdaqGS",
              exchangeTimezoneName: "America/New_York",
            },
            timestamp: [epoch, epoch + 86400, epoch + 172800],
            indicators: {
              quote: [
                {
                  open: [100, null, 102],
                  high: [101, 101, 103],
                  low: [99, 99, 101],
                  close: [100.123456, null, 102.5],
                  volume: [10, 10, 12.4],
                },
              ],
            },
          },
        ],
        error: null,
      },
    })
    assert.equal(quote.symbol, "AAPL")
    assert.equal(quote.shortName, "Apple Inc.")
    assert.equal(quote.exchange, "NasdaqGS")
    assert.deepEqual(
      quote.bars.map((bar) => bar.date),
      ["2024-11-12", "2024-11-14"],
    )
    assert.equal(quote.bars[0].close, 100.1235)
    assert.equal(quote.bars[1].volume, 12)
    assert.equal(barDate(epoch, "America/New_York"), "2024-11-12")
  })

  it("pads a short Hong Kong code when Yahoo echoes it", () => {
    const epoch = Date.parse("2024-11-12T01:30:00Z") / 1000
    const quote = parseYahooChart("700.HK", {
      chart: {
        result: [
          {
            meta: {
              symbol: "0700.HK",
              shortName: "TENCENT",
              currency: "HKD",
              exchangeTimezoneName: "Asia/Hong_Kong",
            },
            timestamp: Array.from({ length: 10 }, (_, index) => epoch + index * 86400),
            indicators: {
              quote: [
                {
                  open: Array(10).fill(400),
                  high: Array(10).fill(405),
                  low: Array(10).fill(395),
                  close: Array(10).fill(401),
                  volume: Array(10).fill(1000),
                },
              ],
            },
          },
        ],
      },
    })
    assert.equal(quote.symbol, "0700.HK")
    assert.equal(quote.currency, "HKD")
    assert.equal(quote.bars[0].date, "2024-11-12")
    assert.equal(quote.bars.length, 10)
  })
})
