import {
  chooseLogo,
  groundSwitchPoint,
  IDENTIFICATION_RANK,
  type Brain,
  type BrandAsset,
  type LogoPreference,
} from './brain'
import { luminanceAt, type Raster } from './png'

/**
 * Chooses which logo to place and where, by measuring the plate.
 *
 * The order matters, and getting it backwards is what produced wrong logos on
 * both brands. The *ad's* ground decides which variant is correct — a navy ad
 * takes the reverse logo even if one corner happens to hold a bright product
 * screenshot. A corner only decides position, and only among corners that suit
 * the variant already chosen.
 *
 * The previous version let each corner nominate its own variant and then ranked
 * the nominations. A laptop screen measuring 0.939 in the corner of a plate
 * averaging 0.015 therefore won, and the dark logo went onto a navy ad. Local
 * brightness is evidence about a corner, never about the design.
 *
 * Nothing here knows a brand. The preference order and identification ranking are
 * policy data, the switch point comes from the kit's own manifest note, and the
 * grounds come from pixels.
 */

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface CornerReading {
  corner: Corner
  /** Mean luminance across the box the logo would occupy. */
  luminance: number
  /**
   * How many sampled cells disagree with the ad's ground.
   *
   * A logo half on a bright laptop screen and half on shadow has a plausible
   * mean and is still unplaceable, so the mean alone cannot answer this.
   */
  conflictingCells: number
  cells: number
  eligible: boolean
}

export interface LogoPlacement {
  asset: BrandAsset | null
  kind: string | null
  /** True when the corner was asked for rather than picked. */
  forced: boolean
  /**
   * Neutral note about the requested corner, or null.
   *
   * Information, not an objection: it says what the ground measured there so a person
   * can judge, and nothing about the request being wrong.
   */
  forcedNote: string | null
  corner: Corner
  /** The ad's ground, measured across the whole plate. */
  plateLuminance: number
  groundIsDark: boolean
  switchPoint: number
  switchPointSource: string
  /** True when no corner was uniform enough; the least bad was taken. */
  straddled: boolean
  considered: CornerReading[]
  reason: string
}

export interface PlacementOptions {
  canvasWidth: number
  canvasHeight: number
  /** The box the logo will occupy, so the sample matches what sits there. */
  logoWidth: number
  logoHeight: number
  margin: number
  preference?: LogoPreference
  /** Corners to consider. Fewer when a layout reserves space elsewhere. */
  corners?: Corner[]
  /**
   * Where the logo goes, when someone says.
   *
   * Set it and that is where the logo goes — no ranking, no veto, no warning phrased
   * as an objection. Corner choice is a layout preference, and a person looking at the
   * finished ad knows more about it than a luminance sample does.
   *
   * Worth being precise about what the measurement here is and is not for, because I
   * previously claimed too much for it. The wrong-logo problem was a *variant*
   * problem — a dark wordmark chosen for a navy ad — and that is fixed by picking the
   * variant from the ad's overall ground, above. Corner selection only decides which
   * free corner to drop it in when nobody has expressed a preference. It is a
   * convenience, not a guarantee, and it should never argue with a request.
   */
  forceCorner?: Corner
  /** Sampling grid across the logo box. Coarse is enough to catch a straddle. */
  gridX?: number
  gridY?: number
}

export function placeLogo(brain: Brain, plate: Raster, options: PlacementOptions): LogoPlacement {
  const { canvasWidth, canvasHeight, logoWidth, logoHeight, margin } = options
  const corners =
    options.corners ?? (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as Corner[])
  const gridX = options.gridX ?? 4
  const gridY = options.gridY ?? 2

  // The ad's ground. Measured across the entire plate because that is what the
  // brand's own rule talks about — "any ground darker than #6B7A88" describes the
  // design, not a 100px square in one corner.
  const plateLuminance = luminanceAt(plate, {
    x: 0,
    y: 0,
    width: plate.width,
    height: plate.height,
  })
  const switchPoint = groundSwitchPoint(brain)
  const groundIsDark = plateLuminance < switchPoint.value

  // One variant for the whole ad, chosen once, from the ad's ground.
  const choice = chooseLogo(brain, plateLuminance, options.preference)

  const boxFor = (corner: Corner) => ({
    x: corner.endsWith('left') ? margin : canvasWidth - margin - logoWidth,
    y: corner.startsWith('top') ? margin : canvasHeight - margin - logoHeight,
    width: logoWidth,
    height: logoHeight,
  })

  const readCorner = (corner: Corner): CornerReading => {
    const box = boxFor(corner)
    const cw = Math.max(1, Math.floor(box.width / gridX))
    const ch = Math.max(1, Math.floor(box.height / gridY))
    let conflicting = 0
    let cells = 0
    for (let gy = 0; gy < gridY; gy++) {
      for (let gx = 0; gx < gridX; gx++) {
        const cell = {
          x: Math.round(box.x + gx * cw),
          y: Math.round(box.y + gy * ch),
          width: cw,
          height: ch,
        }
        if (cell.x < 0 || cell.y < 0 || cell.x + cell.width > plate.width) continue
        if (cell.y + cell.height > plate.height) continue
        cells++
        if ((luminanceAt(plate, cell) < switchPoint.value) !== groundIsDark) conflicting++
      }
    }
    return {
      corner,
      luminance: Number(luminanceAt(plate, box).toFixed(3)),
      conflictingCells: conflicting,
      cells,
      eligible: cells > 0 && conflicting === 0,
    }
  }

  const considered: CornerReading[] = corners.map((corner) => {
    const box = boxFor(corner)
    const cw = Math.max(1, Math.floor(box.width / gridX))
    const ch = Math.max(1, Math.floor(box.height / gridY))
    let conflicting = 0
    let cells = 0
    for (let gy = 0; gy < gridY; gy++) {
      for (let gx = 0; gx < gridX; gx++) {
        const cell = {
          x: Math.round(box.x + gx * cw),
          y: Math.round(box.y + gy * ch),
          width: cw,
          height: ch,
        }
        if (cell.x < 0 || cell.y < 0 || cell.x + cell.width > plate.width) continue
        if (cell.y + cell.height > plate.height) continue
        cells++
        const cellIsDark = luminanceAt(plate, cell) < switchPoint.value
        if (cellIsDark !== groundIsDark) conflicting++
      }
    }
    return {
      corner,
      luminance: Number(luminanceAt(plate, box).toFixed(3)),
      conflictingCells: conflicting,
      cells,
      eligible: cells > 0 && conflicting === 0,
    }
  })

  // Prefer a corner where every cell agrees with the ad's ground; among those,
  // the most decisive. A tie between equally clean corners is broken by nothing
  // meaningful, so the declared order wins and stays stable across runs.
  const ranked = [...considered].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1
    if (a.conflictingCells !== b.conflictingCells) return a.conflictingCells - b.conflictingCells
    return (
      Math.abs(b.luminance - switchPoint.value) - Math.abs(a.luminance - switchPoint.value)
    )
  })

  const measured = ranked[0]

  /**
   * A requested corner is used, full stop.
   *
   * Not ranked against the measurement, not overridden when the measurement disagrees.
   * If the corner was not among those sampled — because the layout reserves it for
   * copy — it is sampled now rather than refused, since "the logo cannot go there"
   * would be this code inventing a rule nobody asked for.
   */
  const requested = options.forceCorner
    ? (considered.find((c) => c.corner === options.forceCorner) ?? readCorner(options.forceCorner))
    : null
  const best = requested ?? measured
  const straddled = !best.eligible

  const forcedNote =
    requested && requested.corner !== measured.corner
      ? `placed at ${requested.corner} as asked; the ground there measures ` +
        `${requested.luminance} with ${requested.conflictingCells}/${requested.cells} cells ` +
        `differing from the ad's ground`
      : null

  const identification = choice.kind ? (IDENTIFICATION_RANK[choice.kind] ?? 9) : 99

  return {
    asset: choice.asset,
    kind: choice.kind,
    forced: Boolean(requested),
    forcedNote,
    corner: best.corner,
    plateLuminance: Number(plateLuminance.toFixed(3)),
    groundIsDark,
    switchPoint: Number(switchPoint.value.toFixed(3)),
    switchPointSource: switchPoint.source,
    straddled,
    considered,
    reason:
      choice.kind === null
        ? `plate mean ${plateLuminance.toFixed(3)} is ${groundIsDark ? 'dark' : 'light'}; ` +
          choice.reason
        : `plate mean ${plateLuminance.toFixed(3)} is ${groundIsDark ? 'dark' : 'light'} ` +
          `against ${switchPoint.value.toFixed(3)} (${switchPoint.source}), so "${choice.kind}" ` +
          `(identification rank ${identification}) is the variant; ` +
          (requested
            ? `placed at ${best.corner} as asked`
            : `${best.corner} placed it with ${best.conflictingCells}/${best.cells} cells disagreeing` +
              (straddled ? ' — no corner was uniform, this was the least conflicted' : '')),
  }
}
