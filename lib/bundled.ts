import aapl from "@/data/AAPL.json"
import hk from "@/data/0700.HK.json"
import type { Quote } from "@/lib/types"

export const BUNDLED_QUOTES: Record<string, Quote> = {
  AAPL: aapl as Quote,
  "0700.HK": hk as Quote,
}
