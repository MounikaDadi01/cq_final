'use client'

/**
 * The browser's only way to reach data.
 *
 * Two headers, every time: the publishable `apikey` to get through the gateway, and
 * the `app_user` session token that decides what is visible. There is no privileged
 * path from here — if a query returns nothing, the database said no.
 */
export interface Session {
  customerId: string
  token: string
  supabaseUrl: string
  anonKey: string
}

export async function rest<T>(session: Session, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${session.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: session.anonKey,
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 240)}`)
  return (text ? JSON.parse(text) : null) as T
}

/**
 * A time-limited URL for one stored object.
 *
 * The bucket is private, so an `<img src>` cannot carry an Authorization header —
 * signing is the only way to display an artifact. The session token does the signing,
 * which means a customer can only ever sign a URL for an object its own policies
 * already let it read.
 */
export async function signedUrl(session: Session, storageKey: string, seconds = 1200): Promise<string> {
  const response = await fetch(`${session.supabaseUrl}/storage/v1/object/sign/work/${storageKey}`, {
    method: 'POST',
    headers: {
      apikey: session.anonKey,
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: seconds }),
  })
  if (!response.ok) throw new Error(`could not sign ${storageKey}: ${response.status}`)
  const { signedURL } = (await response.json()) as { signedURL: string }
  return `${session.supabaseUrl}/storage/v1${signedURL}`
}
