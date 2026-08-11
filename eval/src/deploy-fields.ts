/**
 * The two decisions a deploy is judged on, as functions rather than as lines buried in
 * a launcher.
 *
 * Both were the cause of a real failure, and neither was reachable by a test while it
 * lived inline in `scripts/launch-deploy.ts`: one composed a field the tool demands,
 * the other decided whether a deploy counted as published. A rule that decides whether
 * an ad goes live, or whether we tell someone it did, should be checkable without
 * opening a sandbox.
 */

/** The tool's form values, keyed by the label the agent matches on the page. */
export type ToolFields = Record<string, string>

/**
 * Adstream's Primary text, composed from the approved copy.
 *
 * The tool has one body field. Our copy has five parts, and between approving a
 * revision and the box opening there is no screen where a person could reconcile them —
 * approval starts the sandbox. So the composition happens before the box, deterministic
 * and recorded in the hydration file, which means what the ad said stays auditable
 * rather than being a decision a model made inside a box that no longer exists.
 *
 * Headline, then subhead, then legal where a kit carries one.
 *
 * `eyebrow` is a design element on the plate — "2026 Predictions" above the headline
 * reads as a stray fragment when it is dropped into a paragraph. `cta` is a button
 * label, and Adstream takes that from its own dropdown, so copying it into the body
 * would print the words twice.
 *
 * Returns empty when there is nothing to say, which the caller treats as a blocker. An
 * ad published with a blank body is worse than a deploy that refused to start.
 */
export function primaryTextFrom(copy: Record<string, string | null>): string {
  return [copy.headline, copy.subhead, copy.legal]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
}

export interface OutcomeInput {
  /** `completed` when the box exited cleanly; anything else is how it died. */
  exitReason: string
  /** What the agent wrote to the deployment row, or null if it never got there. */
  reported: string | null
  /** A recording saved by *this* run. */
  hasRecording: boolean
  /** A url the agent read off the tool's own page after publishing. */
  hasVerifiedUrl: boolean
}

/**
 * What a deploy is recorded as.
 *
 * The agent's own verdict is a **ceiling**. This may confirm it or downgrade it, and
 * may never raise it.
 *
 * That asymmetry is the whole point. The launcher used to recompute the status from
 * evidence alone and write it over whatever the agent had said. Because the agent
 * catches its own errors the box always exits 0, so a deploy that stopped on a disabled
 * Publish button — having read one url off the page on its way past — came back
 * `published`, with the note explaining the blocker replaced by "recording saved and
 * url read back". The run printed "Partial deployment only" and the record said the
 * opposite.
 *
 * Evidence can only take a claim away. `published` still requires both a recording and
 * a url, because a confirmation page the agent believed is not the same as one it read.
 */
export function resolveDeployStatus(input: OutcomeInput): 'published' | 'unverified' | 'stopped' | 'failed' {
  if (input.exitReason !== 'completed') return 'failed'
  if (input.reported === 'stopped') return 'stopped'
  if (input.reported === 'published') {
    return input.hasRecording && input.hasVerifiedUrl ? 'published' : 'unverified'
  }
  // `running`, `planned`, or null: `record_outcome` never landed, whatever the box
  // printed on its way out. Nothing was claimed, so nothing is confirmed.
  return 'unverified'
}
