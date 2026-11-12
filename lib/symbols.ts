const US_TICKER = /^[A-Z][A-Z0-9.-]{0,14}$/

export function normalizeSymbol(input: string): string | null {
  const raw = input.trim().toUpperCase().replace(/\s+/g, "")
  if (!raw || raw.includes("..") || raw.includes("/") || raw.includes("\\")) return null

  const hk = raw.match(/^(\d{1,5})\.HK$/) ?? raw.match(/^(\d{1,5})HK$/)
  if (hk) {
    const digits = hk[1].length < 4 ? hk[1].padStart(4, "0") : hk[1]
    return `${digits}.HK`
  }

  if (!US_TICKER.test(raw)) return null
  return raw
}
