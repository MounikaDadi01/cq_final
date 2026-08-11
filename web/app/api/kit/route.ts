import { cookies } from 'next/headers'
import { env, serviceFetch, verifyUserToken } from '@/lib/server'

/**
 * Upload files into a brand kit.
 *
 * Forwarded with the *session* token, never `service_role`, so the storage policy is
 * what decides: a write is allowed only under a kit id belonging to this customer.
 * That means the tenancy check is not code in this handler that could be got wrong —
 * it is the same rule that governs every other read and write in the system.
 *
 * Path traversal is refused rather than sanitised. A filename is a filename; anything
 * containing a separator or `..` is not one, and quietly rewriting it would hide a
 * caller doing something odd.
 */
const ALLOWED = /\.(md|json|svg|png|jpg|jpeg|ttf|woff2)$/i
const MAX_BYTES = 8 * 1024 * 1024

export async function POST(request: Request) {
  const store = await cookies()
  const token = store.get('cq_session')?.value
  if (!token || !verifyUserToken(token)) {
    return Response.json({ error: 'not signed in' }, { status: 401 })
  }

  const form = await request.formData()
  const kitId = String(form.get('kit_id') ?? '')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kitId)) {
    return Response.json({ error: 'kit_id is not a valid id' }, { status: 400 })
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) return Response.json({ error: 'no files' }, { status: 400 })

  /**
   * Uploading an inspiration rather than a brand file.
   *
   * An inspiration has to be named for the brand that owns it. The bucket prefix already
   * isolates it, so the naming rule is not what keeps customers apart — it is what keeps a
   * file's name and its location honest, so "belongs to" is checkable by looking rather
   * than by trusting where someone put it.
   *
   * Slugs are derived from the kit's own row, so a new brand needs no code change.
   */
  const asInspiration = String(form.get('target') ?? '') === 'inspirations'
  let brandSlugs: string[] = []
  if (asInspiration) {
    const rows = await serviceFetch(
      `/rest/v1/brand_kits?id=eq.${encodeURIComponent(kitId)}&select=id,customer_id,display_name`,
    )
    const kit = Array.isArray(rows) ? rows[0] : null
    if (!kit) return Response.json({ error: `no kit ${kitId}` }, { status: 404 })
    const clean = (value: string) =>
      String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    brandSlugs = [
      ...new Set([
        clean(kit.customer_id),
        clean(kit.display_name),
        clean(kitId).replace(/^bk-/, '').replace(/-\d{4}$/, ''),
      ].filter(Boolean)),
    ]
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env()
  const stored: string[] = []

  for (const file of files) {
    const name = file.name
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      return Response.json({ error: `refusing a path, not a filename: ${name}` }, { status: 400 })
    }
    if (!ALLOWED.test(name)) {
      return Response.json({ error: `${name} is not a brand file type we accept` }, { status: 400 })
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: `${name} is larger than 8 MB` }, { status: 400 })
    }

    if (asInspiration) {
      if (!/\.(png|jpe?g|webp)$/i.test(name)) {
        return Response.json({ error: `an inspiration must be an image: ${name}` }, { status: 400 })
      }
      const lower = name.toLowerCase()
      if (!brandSlugs.some((slug) => lower.startsWith(`${slug}-`) || lower.startsWith(`${slug}_`))) {
        return Response.json(
          {
            error:
              `"${name}" must start with this brand's name. Try ` +
              `${brandSlugs[0]}-${name.replace(/^[^a-z0-9]*/i, '')}`,
            expected: brandSlugs,
          },
          { status: 400 },
        )
      }
    }

    // Documents at the kit root, everything else where ingest expects to find it, so an
    // upload lands where the next ingest will look.
    const folder = asInspiration
      ? 'inspirations'
      : /\.(ttf|woff2)$/i.test(name)
        ? 'fonts'
        : /\.(md)$/i.test(name)
          ? ''
          : 'brand'
    const key = folder ? `${kitId}/${folder}/${name}` : `${kitId}/${name}`

    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/brains/${key}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: new Uint8Array(await file.arrayBuffer()),
    })
    if (!response.ok) {
      const body = await response.text()
      return Response.json(
        { error: `could not store ${name}: ${response.status} ${body.slice(0, 160)}`, stored },
        { status: 400 },
      )
    }
    stored.push(key)
  }

  return Response.json({ ok: true, stored })
}

export const dynamic = 'force-dynamic'
