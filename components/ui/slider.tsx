"use client"

import * as SliderPrimitive from "@radix-ui/react-slider"
import * as React from "react"
import { cn } from "@/lib/utils"

function Slider({
  className,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      aria-label={ariaLabel}
      className={cn("relative flex w-full touch-none items-center select-none", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-white/10">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        className="block size-3.5 rounded-full border border-primary/70 bg-foreground shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
