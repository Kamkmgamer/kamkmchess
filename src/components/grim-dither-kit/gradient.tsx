"use client"

import { useEffect, useRef } from "react"
import { cn } from "./lib"
import { type PixelBloom, type PixelColor, pixelBloomStyle } from "./pixel"
import { paintGradient, type GradientDirection } from "./gradient-paint"

export type { GradientDirection } from "./gradient-paint"

export type DitherGradientProps = {
  /** The starting colour: a palette name, hue, or project-specific RGB fill. */
  from: PixelColor
  /** What it dissolves into: another colour for a two-tone dither blend, or
   * "transparent" (default) so the background shows through. */
  to?: PixelColor | "transparent"
  /** Where `to` ends up — "up" reads as a glow rising from the bottom edge. */
  direction?: GradientDirection
  /** CSS px per dither cell — bigger is chunkier. */
  cell?: number
  /** Overall opacity multiplier. */
  opacity?: number
  /** Glow on the dither fill. */
  bloom?: PixelBloom
  className?: string
}

/**
 * Dithered gradient wash — the charts' ordered-dither texture as a background.
 * Fills its nearest positioned ancestor (footer glows, section fades, card
 * backdrops). Dissolves to transparent by default, or dither-blends between
 * two colours when `to` is set.
 */
export function DitherGradient({
  from,
  to = "transparent",
  direction = "up",
  cell = 3,
  opacity = 1,
  bloom = "off",
  className,
}: DitherGradientProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bloomRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const paint = () => {
      const box = wrap.getBoundingClientRect()
      paintGradient(canvas, bloomRef.current, box.width, box.height, {
        from,
        to,
        direction,
        cell,
        opacity,
      })
    }
    paint()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(paint)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [from, to, direction, cell, opacity, bloom])

  const bloomStyle = pixelBloomStyle(bloom)

  return (
    <div
      ref={wrapRef}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className
      )}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ imageRendering: "pixelated" }}
      />
      {bloomStyle && (
        <canvas
          ref={bloomRef}
          className="absolute inset-0 h-full w-full"
          style={bloomStyle}
        />
      )}
    </div>
  )
}
