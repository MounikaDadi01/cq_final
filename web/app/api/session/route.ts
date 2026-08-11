import { cookies } from 'next/headers'
import { env, mintUserToken, SESSION_SECONDS, serviceFetch } from '@/lib/server'

/**
 * Sign in as a customer.
 *
 * DEV STAND-IN, and worth being blunt about: there is no password here. Real auth
 * would be Supabase Auth with `customer_id` read from the signed-in user's profile
 * and put into the token by an access-token hook.
 *
 * What is NOT a stand-in is the isolation. The token this route mints carries one
 * customer id, and every table and bucket policy is written against it — so the
 * weakness above is "anyone can pick a customer", never "a customer can see
 * another's work". Those are very different holes, and only the second one would
 * be a design failure.
 */
export async function GET() {
  const customers = await serviceFetch(
    '/rest/v1/brand_kits?select=customer_id,id,display_name,ingest_status&order=customer_id',
  )
  const store = await cookies()
  const current = store.get('cq_customer')?.value ?? null
  return Response.json({ customers, current })
}

export async function POST(request: Request) {
  const { customer_id } = (await request.json()) as { customer_id?: string }
  if (!customer_id) return Response.json({ error: 'customer_id is required' }, { status: 400 })

  // Only a customer that actually exists. Minting a token for a made-up id would
  // produce a session that silently sees nothing, which reads as a broken app.
  const kits = await serviceFetch(
    `/rest/v1/brand_kits?customer_id=eq.${encodeURIComponent(customer_id)}&select=id&limit=1`,
  )
  if (!Array.isArray(kits) || kits.length === 0) {
    return Response.json({ error: `no customer named ${customer_id}` }, { status: 404 })
  }

  const token = mintUserToken(customer_id)
  const store = await cookies()
  // httpOnly so no script can read it; the browser sends it back and the server
  // hands it to client code through the page, never through localStorage.
  store.set('cq_session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_SECONDS })
  store.set('cq_customer', customer_id, { sameSite: 'lax', path: '/', maxAge: SESSION_SECONDS })
  return Response.json({ ok: true, customer_id, expires_in: SESSION_SECONDS })
}

export async function DELETE() {
  const store = await cookies()
  store.delete('cq_session')
  store.delete('cq_customer')
  return Response.json({ ok: true })
}

export const dynamic = 'force-dynamic'
