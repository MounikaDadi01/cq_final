import { redirect } from 'next/navigation'
import { session } from '@/lib/read'
import { serviceFetch } from '@/lib/server'
import SignIn from './sign-in'

/**
 * The door. Signed in goes straight to review; otherwise pick a customer.
 *
 * Listing customers is the one read that happens before a session exists, so it is
 * the one read that uses the privileged key. Everything after this point uses the
 * session token.
 */
export default async function Home() {
  const current = await session()
  if (current) redirect('/review')

  const kits = (await serviceFetch(
    '/rest/v1/brand_kits?select=id,customer_id,display_name,ingest_status&order=customer_id',
  )) as { id: string; customer_id: string; display_name: string; ingest_status: string }[]

  // One entry per customer, with the kits they own.
  const byCustomer = new Map<string, typeof kits>()
  for (const kit of kits) {
    const list = byCustomer.get(kit.customer_id) ?? []
    list.push(kit)
    byCustomer.set(kit.customer_id, list)
  }

  return (
    <SignIn
      customers={[...byCustomer.entries()].map(([customerId, own]) => ({
        customerId,
        kits: own.map((k) => ({ id: k.id, status: k.ingest_status })),
      }))}
    />
  )
}

export const dynamic = 'force-dynamic'
