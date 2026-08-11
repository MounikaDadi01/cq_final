import { cookies } from 'next/headers'
import { env, verifyUserToken } from '@/lib/server'

/**
 * Comment writes, proxied so the session cookie can stay httpOnly.
 *
 * The token is never handed to scripts, so client code cannot post directly to
 * Supabase. This route forwards using the *session* token — not `service_role` — so
 * every insert is still filtered by the same policies a direct call would hit. The
 * proxy buys cookie safety, not extra permission.
 */
async function forward(path: string, init: RequestInit) {
  const store = await cookies()
  const token = store.get('cq_session')?.value
  if (!token) return Response.json({ error: 'not signed in' }, { status: 401 })
  // Verified here too. Supabase would reject a forged token anyway, but a route that
  // checks and a route that does not is exactly the inconsistency that produced the
  // bypass in the run route.
  if (!verifyUserToken(token)) return Response.json({ error: 'not signed in' }, { status: 401 })
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env()
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  })
  const text = await response.text()
  return new Response(text || '[]', {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    request_id: string
    revision_id: string
    canvas_name: string
    region?: { x: number; y: number; w: number; h: number } | null
    body: string
    instruction?: string | null
  }

  const thread = await forward('comment_threads', {
    method: 'POST',
    body: JSON.stringify({
      request_id: body.request_id,
      opened_on_revision: body.revision_id,
      canvas_name: body.canvas_name,
      // Fractions, so the same comment means the same thing on any canvas and
      // survives a re-render at a different size.
      region_x: body.region?.x ?? null,
      region_y: body.region?.y ?? null,
      region_w: body.region?.w ?? null,
      region_h: body.region?.h ?? null,
    }),
  })
  if (!thread.ok) return thread
  const [created] = (await thread.json()) as { id: string }[]

  return forward('comment_messages', {
    method: 'POST',
    body: JSON.stringify({
      thread_id: created.id,
      author: 'user',
      body: body.body,
      // What the agent receives. Falls back to the visible text when the person did
      // not phrase it separately.
      instruction: body.instruction ?? body.body,
    }),
  })
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    thread_id?: string
    status?: string
    revision_id?: string
    revision_status?: string
    approve?: boolean
  }

  if (body.revision_id && body.approve) {
    return forward(`revisions?id=eq.${body.revision_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ approved_at: new Date().toISOString(), approved_by: 'ui' }),
    })
  }

  // Approving or deleting a revision, and resolving a thread, are both "a person
  // changed the state of their own work" — so both go through the session token and
  // both are refused by policy if the row belongs to someone else.
  if (body.revision_id && body.revision_status) {
    return forward(`revisions?id=eq.${body.revision_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: body.revision_status }),
    })
  }

  if (body.thread_id && body.status) {
    return forward(`comment_threads?id=eq.${body.thread_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: body.status }),
    })
  }

  return Response.json({ error: 'nothing to update' }, { status: 400 })
}

export const dynamic = 'force-dynamic'
