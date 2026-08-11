import { describe, expect, it } from 'vitest'
import { availableFamilies, declaredFamilies, normaliseHex, resolveFamily } from '../src/brain'
import { brains, foreignAssetOf, missingAssetOf } from './fixtures'

const all = brains()

describe('brain loading is generic', () => {
  it('discovers every brain in the packet without naming one', () => {
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it.each(all)('$slug loads a kit id, a palette and a type scale', (brain) => {
    expect(brain.kitId).toMatch(/\S/)
    expect(Object.keys(brain.palette).length).toBeGreaterThanOrEqual(4)
    expect(Object.keys(brain.typeScale).length).toBeGreaterThanOrEqual(3)
    for (const hex of Object.values(brain.palette)) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it.each(all)('$slug ships font files that parse into families and weights', (brain) => {
    expect(brain.fonts.length).toBeGreaterThan(0)
    for (const font of brain.fonts) {
      expect(font.familySlug).toMatch(/^[a-z0-9_]+$/)
      expect(font.weight).toBeGreaterThanOrEqual(100)
    }
  })

  it.each(all)('$slug declares at least one type family', (brain) => {
    expect(declaredFamilies(brain).length).toBeGreaterThan(0)
  })
})

describe('hex normalisation', () => {
  it('expands short form and uppercases', () => {
    expect(normaliseHex('#abc')).toBe('#AABBCC')
    expect(normaliseHex('#0c3b5d')).toBe('#0C3B5D')
  })

  it('reads rgb(), because a print vendor makes a brand write colours that way', () => {
    // This assertion used to say rgb() returned null. It was changed deliberately: a
    // real kit wrote its whole palette as rgb(), and refusing it made the palette
    // unreadable for a formatting reason rather than a substantive one.
    expect(normaliseHex('rgb(30, 41, 59)')).toBe('#1E293B')
    expect(normaliseHex('rgb(1,2,3)')).toBe('#010203')
    expect(normaliseHex('rgba(255, 255, 255, 0.5)')).toBe('#FFFFFF')
  })

  it('refuses a colour with no correct conversion', () => {
    // Pantone and friends stay unreadable on purpose. There is no right answer, and
    // guessing one puts a wrong colour on a customer's ad with nothing to say so.
    for (const value of ['PANTONE 2925 C', 'Paper White', 'transparent', 'currentColor', '#12345', 'rgb(300,0,0)']) {
      expect(normaliseHex(value)).toBeNull()
    }
  })
})

describe('font resolution policy is generic', () => {
  it.each(all)('$slug resolves each declared family to a shipped file or a substitute', (brain) => {
    for (const family of declaredFamilies(brain)) {
      const resolution = resolveFamily(brain, family)
      // Either it resolves, or the policy explains why it cannot — never a
      // silent browser fallback.
      if (resolution.resolvedFamilySlug === null) {
        expect(resolution.reason).toMatch(/browser fallback is not the brand/)
      } else {
        expect(availableFamilies(brain)).toContain(resolution.resolvedFamilySlug)
        expect(resolution.weight).toBeGreaterThan(0)
      }
    }
  })

  it('substitutes a modifier variant with the base family at its heaviest weight', () => {
    // Synthetic brain: no customer is named, and the rule is exercised on
    // invented families to prove it is not a rule about one packet.
    const synthetic = {
      fonts: [
        { file: 'zeta_400_normal.ttf', path: '', familySlug: 'zeta', weight: 400, style: 'normal' },
        { file: 'zeta_700_normal.ttf', path: '', familySlug: 'zeta', weight: 700, style: 'normal' },
      ],
    } as never

    const resolution = resolveFamily(synthetic, 'Zeta Condensed')
    expect(resolution.substituted).toBe(true)
    expect(resolution.resolvedFamilySlug).toBe('zeta')
    expect(resolution.weight).toBe(700)
  })

  it('refuses a family with no relation to anything shipped', () => {
    const synthetic = {
      fonts: [
        { file: 'zeta_400_normal.ttf', path: '', familySlug: 'zeta', weight: 400, style: 'normal' },
      ],
    } as never

    const resolution = resolveFamily(synthetic, 'Omega Text')
    expect(resolution.resolvedFamilySlug).toBeNull()
    expect(resolution.substituted).toBe(false)
  })

  it('at least one brain in the packet needs a substitution', () => {
    // Proves the substitution path is exercised by real data, not only by the
    // synthetic cases above.
    const needing = all.filter((brain) =>
      declaredFamilies(brain).some((f) => resolveFamily(brain, f).substituted),
    )
    expect(needing.length).toBeGreaterThan(0)
  })
})

describe('the packet contains the hazards the checks exist for', () => {
  it('some brain lists an asset with no file behind it', () => {
    const offenders = all.filter((b) => missingAssetOf(b) !== undefined)
    expect(offenders.length).toBeGreaterThan(0)
  })

  it('some brain holds an asset tagged to a different kit', () => {
    // This is the cross-tenant leak, already planted in the packet. If this test
    // ever goes quiet, the fixture is gone and the leak test below proves nothing.
    const offenders = all.filter((b) => foreignAssetOf(b) !== undefined)
    expect(offenders.length).toBeGreaterThan(0)
  })
})
