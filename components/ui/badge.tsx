import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        outline: "border-border text-muted-foreground",
        long: "border-ema-fast/40 bg-ema-fast/10 text-ema-fast",
        flat: "border-border bg-white/5 text-muted-foreground",
        stop: "border-stop/40 bg-stop/10 text-stop",
        target: "border-target/40 bg-target/10 text-target",
        cross: "border-ema-slow/40 bg-ema-slow/10 text-ema-slow",
        buy: "border-ema-fast/40 bg-ema-fast/10 text-ema-fast",
      },
    },
    defaultVariants: {
      variant: "outline",
    },
  },
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />
}

export { Badge, badgeVariants }
