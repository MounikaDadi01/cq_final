'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  customers: { customerId: string; kits: { id: string; status: string }[] }[]
}

export default function SignIn({ customers }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function choose(customerId: string) {
    setBusy(customerId)
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: customerId }),
    })
    if (!response.ok) {
      setBusy(null)
      return
    }
    router.push('/review')
  }

  return (
    <div className="center">
      <div className="signin">
        <div>
          <div className="h">Choose a customer</div>
          <div className="s">
            Everything you can see afterwards is decided by the database, not by this
            app — a session carries one customer id and nothing else.
          </div>
        </div>

        <div className="list">
          {customers.map((c) => (
            <button key={c.customerId} className="opt" onClick={() => choose(c.customerId)} disabled={busy !== null}>
              <div>
                <div className="t">{c.customerId}</div>
                <div className="d mono">
                  {c.kits.map((k) => k.id).join(', ')}
                </div>
              </div>
              <span className="right">
                {busy === c.customerId ? (
                  <span className="chip neutral">signing in…</span>
                ) : (
                  <span className={`chip ${c.kits.every((k) => k.status === 'ready') ? 'ok' : 'warn'}`}>
                    {c.kits.every((k) => k.status === 'ready') ? 'ready' : 'ingest pending'}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        {/* Onboarding belongs here as well as inside the app: the moment you notice a
            brand is missing is the moment you are looking at the list of brands. Links
            to the same screen the app uses, so there is one add-a-customer form and one
            ingest behind it. */}
        <a className="btn dark wide" href="/customers">+ Add a new customer</a>

        <div className="banner info">
          No password, on purpose — this is a local trial. Real sign-in would be
          Supabase Auth with the customer id put into the token by an access-token
          hook. The isolation does not depend on the login: it is enforced per row and
          per object in the database.
        </div>
      </div>
    </div>
  )
}
