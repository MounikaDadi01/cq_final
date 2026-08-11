import { session } from '@/lib/read'
import { serviceFetch } from '@/lib/server'
import CustomersClient from './customers-client'

/**
 * Add a customer, and see what ingest made of every kit.
 *
 * Listing all customers uses the privileged key on purpose: this is an operator screen
 * in a local deployment, and its whole job is to show kits that do not belong to the
 * signed-in customer yet. Nothing here can read a kit's *work* — only its ingest
 * outcome, which is the same information the person who uploaded it needs.
 *
 * Reachable with no session, because the switch-customer screen links here and that
 * screen exists precisely when nobody is signed in. It was already showing every
 * tenant's ingest outcome to whoever was signed in, so requiring *a* session was not
 * what kept anything separate — see the note in `api/customer`.
 */
export default async function CustomersPage() {
  const current = await session()

  const kits = (await serviceFetch(
    '/rest/v1/brand_kits?select=id,customer_id,display_name,ingest_status&order=customer_id',
  )) as { id: string; customer_id: string; display_name: string; ingest_status: string }[]

  const findings = (await serviceFetch(
    '/rest/v1/findings?revision_id=is.null&select=kit_id,code,severity,detail',
  )) as { kit_id: string | null; code: string; severity: string; detail: string }[]

  const assets = (await serviceFetch(
    '/rest/v1/brand_assets?select=kit_id,available',
  )) as { kit_id: string; available: boolean }[]

  const fonts = (await serviceFetch('/rest/v1/brand_fonts?select=kit_id')) as { kit_id: string }[]

  return (
    <CustomersClient
      currentCustomer={current?.customerId ?? null}
      kits={kits.map((k) => ({
        ...k,
        usable: assets.filter((a) => a.kit_id === k.id && a.available).length,
        fonts: fonts.filter((f) => f.kit_id === k.id).length,
        findings: findings.filter((f) => f.kit_id === k.id).length,
        blockers: findings.filter((f) => f.kit_id === k.id && f.severity === 'blocker'),
      }))}
    />
  )
}

export const dynamic = 'force-dynamic'
