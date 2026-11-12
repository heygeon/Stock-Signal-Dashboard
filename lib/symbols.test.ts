import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeSymbol } from "./symbols.ts"

describe("normalizeSymbol", () => {
  it("canonicalizes US and Hong Kong tickers", () => {
    assert.equal(normalizeSymbol(" aapl "), "AAPL")
    assert.equal(normalizeSymbol("700.hk"), "0700.HK")
    assert.equal(normalizeSymbol("0700.HK"), "0700.HK")
    assert.equal(normalizeSymbol("9988.hk"), "9988.HK")
    assert.equal(normalizeSymbol("700 HK"), "0700.HK")
    assert.equal(normalizeSymbol("BRK.B"), "BRK.B")
    assert.equal(normalizeSymbol(""), null)
    assert.equal(normalizeSymbol("AAPL;drop"), null)
    assert.equal(normalizeSymbol("../AAPL"), null)
    assert.equal(normalizeSymbol("0700"), null)
  })
})
