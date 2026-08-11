/**
 * The option sets Adstream's own form offers.
 *
 * Mirrored from the tool's `app.js`, where they are module constants:
 *
 *   const CAMPAIGNS  = [...]
 *   const OBJECTIVES = [...]
 *   const AUDIENCES  = [...]
 *   const PLACEMENTS = [...]
 *   const CTAS       = [...]
 *
 * Why mirror them rather than let someone type: every value here has to match an option
 * in a `<select>` the agent will meet on the other side. A typed campaign that does not
 * exist stops the deploy at the first step — which is correct behaviour, and a waste of
 * a sandbox and two minutes. Offering the real four means the choice cannot be wrong.
 *
 * This is a copy of someone else's data, so it can drift. That is survivable, and the
 * failure is loud rather than silent: the agent reads the live page and reports
 * `CAMPAIGN_NOT_FOUND` if a value is gone, instead of inventing a near-match. Refresh
 * this file by re-reading `app.js` if the tool changes.
 *
 * Deliberately not fetched at render time. A form that cannot open because a third
 * party is slow is worse than one showing a stale list, and the agent already verifies
 * against the live page at the only moment it matters.
 */

export const ADSTREAM = {
  campaigns: ['Q3 ABM Enterprise', 'Q3 ABM Mid Market', 'Always On Brand', 'Autumn Product Launch'],
  objectives: ['Awareness', 'Traffic', 'Conversions'],
  audiences: ['Lookalike 1%', 'Retargeting 30d', 'Broad US'],
  /** Checkboxes on the tool's form, so several may be chosen. */
  placements: ['Feed', 'Stories', 'Right column'],
  ctas: ['Learn More', 'Sign Up', 'Get Offer'],
  /** The tool's own upload ceiling. A larger creative is rejected on its side. */
  maxUploadBytes: 10 * 1024 * 1024,
} as const
