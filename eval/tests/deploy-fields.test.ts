import { describe, expect, it } from 'vitest'
import { primaryTextFrom, resolveDeployStatus } from '../src/deploy-fields'

/**
 * Both halves of a deploy that lied.
 *
 * A run stopped on a disabled Publish button, reported "Partial deployment only —
 * outcome: unverified", and was recorded as `published` with a verified url. A second
 * run stopped before publishing anything because the tool wanted one body field and
 * nothing supplied it. These are the two rules that had to change, so these are the
 * two rules with tests.
 */

describe('primary text composition', () => {
  const copy = {
    eyebrow: '2026 Predictions',
    headline: 'Shoppable video becomes the default discovery surface',
    subhead: 'TikTok Shop now hosts 500,000+ US sellers. Your feed is a storefront.',
    cta: 'Get the predictions',
    cta_href: 'https://emplifi.example/predictions-2026',
    legal: null,
  }

  it('composes the headline and subhead into one body field', () => {
    expect(primaryTextFrom(copy)).toBe(
      'Shoppable video becomes the default discovery surface\n\n' +
        'TikTok Shop now hosts 500,000+ US sellers. Your feed is a storefront.',
    )
  })

  it('leaves out the eyebrow, which is a plate element and not a sentence', () => {
    expect(primaryTextFrom(copy)).not.toContain('2026 Predictions')
  })

  /**
   * The tool takes its call to action from its own dropdown. Copying the copy's `cta`
   * into the body would print the same words twice in one ad.
   */
  it('leaves out the call to action and its href', () => {
    const text = primaryTextFrom(copy)
    expect(text).not.toContain('Get the predictions')
    expect(text).not.toContain('emplifi.example')
  })

  it('includes legal text when a kit carries some', () => {
    expect(primaryTextFrom({ ...copy, legal: 'Terms apply.' })).toMatch(/Terms apply\.$/)
  })

  it('skips absent parts rather than leaving blank lines behind', () => {
    expect(primaryTextFrom({ headline: 'Only a headline', subhead: null, legal: null })).toBe(
      'Only a headline',
    )
  })

  /**
   * Empty is a blocker for the caller, and deliberately not a fallback to some other
   * field. An ad with a blank body is worse than a deploy that refused to start.
   */
  it('returns empty when there is nothing to say', () => {
    expect(primaryTextFrom({ eyebrow: 'BENCHMARK REPORT', headline: null, subhead: '   ' })).toBe('')
  })

  it('is deterministic, so two runs of one revision publish identical copy', () => {
    expect(primaryTextFrom(copy)).toBe(primaryTextFrom({ ...copy }))
  })
})

describe('deploy status resolution', () => {
  const evidenced = { exitReason: 'completed', hasRecording: true, hasVerifiedUrl: true }

  /**
   * The regression itself. The agent stopped on a disabled Publish button, having read
   * a url off the page on its way past, and the launcher recomputed `published` from
   * that url alone.
   */
  it('keeps a stopped deploy stopped even with a recording and a url', () => {
    expect(resolveDeployStatus({ ...evidenced, reported: 'stopped' })).toBe('stopped')
  })

  it('confirms published when the agent claimed it and both proofs exist', () => {
    expect(resolveDeployStatus({ ...evidenced, reported: 'published' })).toBe('published')
  })

  it('downgrades a published claim with no recording', () => {
    expect(
      resolveDeployStatus({ ...evidenced, reported: 'published', hasRecording: false }),
    ).toBe('unverified')
  })

  it('downgrades a published claim with no url read back', () => {
    expect(
      resolveDeployStatus({ ...evidenced, reported: 'published', hasVerifiedUrl: false }),
    ).toBe('unverified')
  })

  /**
   * Evidence can take a claim away and never grant one. A row still saying `running`
   * means `record_outcome` never landed, however cheerfully the box printed on its way
   * out — and the agent catches its own errors, so it exits 0 either way.
   */
  it('never raises an unreported outcome to published on evidence alone', () => {
    expect(resolveDeployStatus({ ...evidenced, reported: 'running' })).toBe('unverified')
    expect(resolveDeployStatus({ ...evidenced, reported: null })).toBe('unverified')
  })

  it('keeps the agent\'s own unverified rather than promoting it', () => {
    expect(resolveDeployStatus({ ...evidenced, reported: 'unverified' })).toBe('unverified')
  })

  it('reports a box that died as failed, whatever the row says', () => {
    expect(
      resolveDeployStatus({ ...evidenced, reported: 'published', exitReason: 'agent exited 1' }),
    ).toBe('failed')
  })
})
