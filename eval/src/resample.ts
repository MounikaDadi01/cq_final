import type { Raster } from './png'

/**
 * Area-average resample to exact target dimensions.
 *
 * Downscaling is the only direction we use in anger: a plate is always generated
 * at or above target and reduced. Averaging every source pixel that falls inside
 * a destination pixel's footprint is the correct filter for that — it discards
 * detail evenly instead of point-sampling and aliasing.
 *
 * Deliberately dependency-free. A production build would reach for Lanczos via a
 * native library; this exists so the *dimension* contract can be tested without
 * one, and the quality is already appropriate for a reduction.
 */
export function resampleTo(src: Raster, width: number, height: number): Raster {
  if (width < 1 || height < 1) throw new Error(`invalid target ${width}x${height}`)
  if (src.width === width && src.height === height) {
    return { width, height, data: Buffer.from(src.data) }
  }

  const out = Buffer.alloc(width * height * 4)
  const xRatio = src.width / width
  const yRatio = src.height / height

  for (let y = 0; y < height; y++) {
    const sy0 = y * yRatio
    const sy1 = Math.min((y + 1) * yRatio, src.height)
    const yStart = Math.floor(sy0)
    const yEnd = Math.max(yStart + 1, Math.ceil(sy1))

    for (let x = 0; x < width; x++) {
      const sx0 = x * xRatio
      const sx1 = Math.min((x + 1) * xRatio, src.width)
      const xStart = Math.floor(sx0)
      const xEnd = Math.max(xStart + 1, Math.ceil(sx1))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0

      for (let sy = yStart; sy < yEnd && sy < src.height; sy++) {
        for (let sx = xStart; sx < xEnd && sx < src.width; sx++) {
          const i = (sy * src.width + sx) * 4
          r += src.data[i]
          g += src.data[i + 1]
          b += src.data[i + 2]
          a += src.data[i + 3]
          n++
        }
      }

      const o = (y * width + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }

  return { width, height, data: out }
}

/** True when every pixel is fully opaque, which every plate must be. */
export function isFullyOpaque(raster: Raster): boolean {
  for (let i = 3; i < raster.data.length; i += 4) {
    if (raster.data[i] !== 255) return false
  }
  return true
}
