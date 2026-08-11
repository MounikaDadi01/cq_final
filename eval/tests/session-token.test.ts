import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { mintUserToken, verifyUserToken, projectRef } from '../../web/lib/server'

/**
 * The session token, verified rather than decoded.
 *
 * These exist because of a real bypass: the run route decoded the cookie and trusted
 * `customer_id` without checking the signature, and that route is the only one holding
 * `service_role`. A hand-crafted token would have passed the ownership check.
 *
 * Every case below is a forgery that must fail. The one positive case is there so a
 * verifier that rejects everything cannot pass the suite.
 */

const b64 = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** Builds a token with an arbitrary header and payload, signed or not. */
function craft(header: object, payload: object, secret?: string) {
  const h = b64(header)
  const p = b64(payload)
  const signature = secret
    ? createHmac('sha256', secret).update(`${h}.${p}`).digest().toString('base64url')
    : 'bm90LWEtc2lnbmF0dXJl'
  return `${h}.${p}.${signature}`
}

const valid = () => ({
  iss: 'supabase',
  ref: projectRef(),
  role: 'app_user',
  customer_id: 'kahua',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
})

describe('session token verification', () => {
  it('accepts a token this server minted', () => {
    const claims = verifyUserToken(mintUserToken('kahua'))
    expect(claims?.customer_id).toBe('kahua')
    expect(claims?.role).toBe('app_user')
  })

  it('rejects an unsigned token carrying a real customer id', () => {
    // The original bypass, exactly.
    expect(verifyUserToken(craft({ alg: 'HS256', typ: 'JWT' }, valid()))).toBeNull()
  })

  it('rejects alg:none', () => {
    expect(verifyUserToken(craft({ alg: 'none', typ: 'JWT' }, valid()))).toBeNull()
  })

  it('rejects a token signed with the wrong secret', () => {
    expect(verifyUserToken(craft({ alg: 'HS256', typ: 'JWT' }, valid(), 'not-the-secret'))).toBeNull()
  })

  it('rejects a tampered payload on a genuine signature', () => {
    // Swap the body of a real token for one naming another customer, keeping the
    // original signature. This is the attack a length-only check would miss.
    const real = mintUserToken('kahua')
    const [header, , signature] = real.split('.')
    const forged = `${header}.${b64({ ...valid(), customer_id: 'emplifi' })}.${signature}`
    expect(verifyUserToken(forged)).toBeNull()
  })

  it('rejects an expired token', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = craft(
      { alg: 'HS256', typ: 'JWT' },
      { ...valid(), iat: now - 7200, exp: now - 3600 },
    )
    expect(verifyUserToken(token)).toBeNull()
  })

  it('rejects a token for another project', () => {
    expect(verifyUserToken(craft({ alg: 'HS256', typ: 'JWT' }, { ...valid(), ref: 'someoneelse' }))).toBeNull()
  })

  it('rejects a sandbox role presented as a session', () => {
    // A run token is signed with the same secret, so the signature is genuine. It
    // still must not open a UI session.
    expect(verifyUserToken(craft({ alg: 'HS256', typ: 'JWT' }, { ...valid(), role: 'sandbox_run' }))).toBeNull()
  })

  it('rejects a token with no customer', () => {
    const { customer_id: _drop, ...rest } = valid()
    expect(verifyUserToken(craft({ alg: 'HS256', typ: 'JWT' }, rest))).toBeNull()
  })

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'x', 'a.b', 'a.b.c.d', '...', 'not-a-token']) {
      expect(verifyUserToken(bad)).toBeNull()
    }
  })
})
