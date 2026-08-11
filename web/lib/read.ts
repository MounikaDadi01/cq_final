import { cookies } from 'next/headers'
import { env } from './server'

/**
 * Server-side reads, using the browser's own session token.
 *
 * Not `service_role`. This is the point worth being careful about: it would be
 * easier to read everything privileged on the server and filter in JSX, and that is
 * precisely how a tenant boundary becomes a rendering bug. Using the session token
 * means the database applies the same policies it would for a direct call, so a
 * mistake here returns an empty list rather than someone else's work.
 */
export async function session(): Promise<{ token: string; customerId: string } | null> {
  const store = await cookies()
  const token = store.get('cq_session')?.value
  const customerId = store.get('cq_customer')?.value
  if (!token || !customerId) return null
  return { token, customerId }
}

export async function read<T>(token: string, path: string): Promise<T> {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env()
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : null) as T
}

/**
 * A display URL for a private object.
 *
 * The bucket is private and an `<img>` cannot send an Authorization header, so a
 * signed URL is the only way to show an artifact. Signed with the session token, so
 * a customer can only produce a URL for something it was already allowed to read —
 * the signature is not a way around the policy, it is downstream of it.
 */
export async function sign(token: string, storageKey: string, seconds = 1200): Promise<string | null> {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env()
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/work/${storageKey}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: seconds }),
    cache: 'no-store',
  })
  if (!response.ok) return null
  const { signedURL } = (await response.json()) as { signedURL: string }
  return `${SUPABASE_URL}/storage/v1${signedURL}`
}

/**
 * Objects under a prefix, listed with the session token.
 *
 * Needed because inspirations are files rather than rows: they live in storage under
 * `brains/<kit>/inspirations/` and there is no table to select them from. Listing with
 * the customer's own token means storage policy answers the question, exactly as it
 * does for a signed URL — the browser is never trusted to filter a listing.
 *
 * Returns bare filenames. Callers want "which inspirations exist for this kit", not a
 * set of storage paths, and handing back the full key invites it being used as one.
 */
export async function listObjects(
  token: string,
  bucket: string,
  prefix: string,
): Promise<{ name: string; bytes: number | null }[]> {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env()
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix, limit: 200, sortBy: { column: 'name', order: 'asc' } }),
    cache: 'no-store',
  })
  if (!response.ok) return []
  const rows = (await response.json()) as { name: string; id: string | null; metadata?: { size?: number } }[]
  // A null id marks a folder rather than an object. Recursing is not wanted here: the
  // prefix is already the exact folder being asked about.
  return rows
    .filter((r) => r.id !== null)
    .map((r) => ({ name: r.name, bytes: r.metadata?.size ?? null }))
}

export interface Artifact {
  id: string
  relative_path: string
  storage_key: string
  role: string
  canvas_name: string | null
  bytes: number | null
}
export interface Revision {
  id: string
  n: number
  status: string
  request_id: string
  created_at: string
  approved_at: string | null
}
export interface RequestRow {
  id: string
  kit_id: string
  campaign_name: string
  kind: string
  copy: Record<string, string | null>
  created_at: string
}
export interface Canvas {
  name: string
  width: number
  height: number
  producible: boolean
  refusal: string | null
}
export interface Thread {
  id: string
  canvas_name: string | null
  region_x: number | null
  region_y: number | null
  region_w: number | null
  region_h: number | null
  status: string
  opened_on_revision: string | null
  created_at: string
}
export interface Message {
  id: string
  thread_id: string
  author: string
  body: string
  instruction: string | null
  created_at: string
}
export interface Finding {
  code: string
  severity: string
  detail: string
  revision_id: string | null
}
