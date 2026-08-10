import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Raster {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel. */
  data: Buffer
}

export function readPng(path: string): Raster {
  const png = PNG.sync.read(readFileSync(path))
  return { width: png.width, height: png.height, data: png.data }
}

export interface SyntheticRect extends Box {
  color: string
}

/**
 * Builds a PNG in memory. Used to make fixtures for the checks' own tests, so
 * every check can be shown catching a planted violation without needing a
 * browser or an image model.
 */
export function makePng(
  width: number,
  height: number,
  background: string,
  rects: SyntheticRect[] = [],
): Raster {
  const png = new PNG({ width, height })
  const bg = hexToRgb(background)
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = bg.r
    png.data[i + 1] = bg.g
    png.data[i + 2] = bg.b
    png.data[i + 3] = 255
  }
  for (const rect of rects) {
    const c = hexToRgb(rect.color)
    for (let y = rect.y; y < Math.min(rect.y + rect.height, height); y++) {
      for (let x = rect.x; x < Math.min(rect.x + rect.width, width); x++) {
        if (x < 0 || y < 0) continue
        const i = (y * width + x) * 4
        png.data[i] = c.r
        png.data[i + 1] = c.g
        png.data[i + 2] = c.b
        png.data[i + 3] = 255
      }
    }
  }
  return { width, height, data: png.data }
}

export function writePng(raster: Raster, path: string): void {
  const png = new PNG({ width: raster.width, height: raster.height })
  raster.data.copy(png.data)
  writeFileSync(path, PNG.sync.write(png))
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`)
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * WCAG contrast ratio, 1 to 21.
 *
 * Computed and reported, never enforced. The ratio has an exact answer so
 * software owns it; whether a given ratio is acceptable for a brand is a
 * judgement, and software that decides an ad is off-brand will reject work a
 * person would ship.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const light = Math.max(la, lb)
  const dark = Math.min(la, lb)
  return (light + 0.05) / (dark + 0.05)
}

/** Euclidean distance in RGB. Crude, and adequate for "is this that colour". */
export function colourDistance(a: string, b: string): number {
  const p = hexToRgb(a)
  const q = hexToRgb(b)
  return Math.sqrt((p.r - q.r) ** 2 + (p.g - q.g) ** 2 + (p.b - q.b) ** 2)
}

function clampBox(raster: Raster, box: Box): Box {
  const x = Math.max(0, Math.min(Math.round(box.x), raster.width - 1))
  const y = Math.max(0, Math.min(Math.round(box.y), raster.height - 1))
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(box.width), raster.width - x)),
    height: Math.max(1, Math.min(Math.round(box.height), raster.height - y)),
  }
}

/**
 * What fraction of a region sits within `tolerance` of `hex`.
 *
 * This is the check that catches HTML-to-PNG drift: the overlay declares a
 * colour at a position, and this asks whether the pixels a customer will
 * actually see carry it.
 */
export function colourCoverage(
  raster: Raster,
  box: Box,
  hex: string,
  tolerance = 24,
): number {
  const b = clampBox(raster, box)
  const target = hexToRgb(hex)
  let hits = 0
  let total = 0
  for (let y = b.y; y < b.y + b.height; y++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      const i = (y * raster.width + x) * 4
      const d = Math.sqrt(
        (raster.data[i] - target.r) ** 2 +
          (raster.data[i + 1] - target.g) ** 2 +
          (raster.data[i + 2] - target.b) ** 2,
      )
      if (d <= tolerance) hits++
      total++
    }
  }
  return total === 0 ? 0 : hits / total
}

/** The most common colour in a region, quantised to reduce noise. */
export function dominantColour(raster: Raster, box: Box, bucket = 8): string {
  const b = clampBox(raster, box)
  const counts = new Map<string, number>()
  for (let y = b.y; y < b.y + b.height; y++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      const i = (y * raster.width + x) * 4
      const key = [
        Math.round(raster.data[i] / bucket) * bucket,
        Math.round(raster.data[i + 1] / bucket) * bucket,
        Math.round(raster.data[i + 2] / bucket) * bucket,
      ].join(',')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let bestKey = '0,0,0'
  let bestCount = -1
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count
      bestKey = key
    }
  }
  const [r, g, bl] = bestKey.split(',').map(Number)
  return rgbToHex(Math.min(r, 255), Math.min(g, 255), Math.min(bl, 255))
}
