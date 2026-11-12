import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fetchYahooQuote } from "../lib/yahoo"

const symbols = ["AAPL", "0700.HK"]

async function main() {
  const directory = path.join(process.cwd(), "data")
  await mkdir(directory, { recursive: true })

  for (const symbol of symbols) {
    const quote = await fetchYahooQuote(symbol)
    const cached = {
      symbol: quote.symbol,
      shortName: quote.shortName,
      currency: quote.currency,
      exchange: quote.exchange,
      timezone: quote.timezone,
      source: "cache" as const,
      fetchedAt: quote.fetchedAt,
      bars: quote.bars,
    }
    const withVolume = quote.bars.filter((bar) => Number.isFinite(bar.volume) && bar.volume > 0).length
    if (withVolume === 0) {
      throw new Error(`${symbol} came back without volume. Refusing to write a cache that would hide the sweep filter.`)
    }
    await writeFile(path.join(directory, `${symbol}.json`), `${JSON.stringify(cached, null, 2)}\n`)
    const last = quote.bars[quote.bars.length - 1]
    console.log(
      `${symbol} ${quote.bars.length} bars through ${last?.date} close ${last?.close} (${quote.shortName}), ${withVolume} sessions with volume`,
    )
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
