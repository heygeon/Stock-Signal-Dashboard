const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-")
  const label = MONTHS[Number(month) - 1]
  if (!label || !year || !day) return iso
  return `${label} ${Number(day)}, ${year}`
}

export function formatNumber(value: number, digits = 2): string {
  const sign = value < 0 ? "-" : ""
  const [whole, fraction = ""] = Math.abs(value).toFixed(digits).split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`
}

export function formatPrice(value: number, currency = "USD"): string {
  const digits = Math.abs(value) >= 1 ? 2 : 4
  const body = formatNumber(value, digits)
  if (currency === "USD") return `$${body}`
  if (currency === "HKD") return `HK$${body}`
  return `${body} ${currency}`
}

export function formatChange(value: number, currency = "USD"): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : ""
  return `${sign}${formatPrice(Math.abs(value), currency)}`
}

export function formatPct(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : ""
  return `${sign}${Math.abs(value * 100).toFixed(digits)}%`
}

export function barsHeld(entryIndex: number, exitIndex: number | null, lastIndex: number): number {
  return (exitIndex ?? lastIndex) - entryIndex
}
