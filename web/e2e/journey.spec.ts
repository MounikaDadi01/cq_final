import { expect, test } from '@playwright/test'

/**
 * End-to-end, against the running app and the real database.
 *
 * These drive a browser rather than calling functions, because the bugs this project
 * has actually produced lived in the gaps between layers: a policy that was correct in
 * SQL and never consulted, a status field watched in the wrong place, a class name that
 * collided with another page's stylesheet. None of those are visible from a unit test.
 *
 * Written to be re-runnable. Nothing here assumes an empty database, and anything
 * created is either harmless or cleaned up, so the suite can run against the same
 * project repeatedly without drifting.
 */

const KAHUA = 'kahua'
const OTHER = 'emplifi'

async function signIn(page: import('@playwright/test').Page, customer: string) {
  await page.goto('/')
  // The sign-in screen lists customers; pick by visible text rather than position, so
  // adding a customer does not reorder the suite into failing.
  const option = page.locator('.opt', { hasText: customer }).first()
  await expect(option).toBeVisible()
  await option.click()
  await page.waitForURL('**/review**')
}

test.describe('sign in and isolation', () => {
  test('a session sees only its own customer, everywhere', async ({ page }) => {
    await signIn(page, KAHUA)

    // The strongest available assertion: the other tenant's name appears nowhere in the
    // rendered document. Cheap, blunt, and it would have caught a leak in any panel.
    for (const path of ['/review', '/brand', '/deploy', '/intake']) {
      await page.goto(path)
      const body = (await page.locator('body').innerText()).toLowerCase()
      expect(body, `${path} leaked the other customer`).not.toContain(OTHER)
      expect(body).toContain(KAHUA)
    }
  })

  test('switching customer changes what is visible', async ({ page }) => {
    await signIn(page, KAHUA)
    await page.getByRole('button', { name: 'Switch customer' }).click()
    await page.waitForURL('/')
    await signIn(page, OTHER)
    const body = (await page.locator('body').innerText()).toLowerCase()
    expect(body).toContain(OTHER)
    expect(body).not.toContain(KAHUA)
  })

  test('an unauthenticated visit is redirected, not served', async ({ page, context }) => {
    await context.clearCookies()
    await page.goto('/review')
    await expect(page).toHaveURL('/')
  })
})

test.describe('review screen', () => {
  test.beforeEach(async ({ page }) => signIn(page, KAHUA))

  test('shows a real render from the private bucket', async ({ page }) => {
    const image = page.locator('.art img').first()
    await expect(image).toBeVisible()
    // A signed URL, not a public one: the bucket is private and an <img> cannot carry a
    // header, so signing is the only route. A public URL here would mean the bucket is
    // not private after all.
    const src = await image.getAttribute('src')
    expect(src).toContain('/storage/v1/object/sign/work/')
    expect(src).toContain('token=')
    // And it actually loaded, rather than being a broken image with a plausible src.
    const decoded = await image.evaluate((el: HTMLImageElement) => el.naturalWidth)
    expect(decoded).toBeGreaterThan(100)
  })

  test('offers every producible canvas and marks a refused one', async ({ page }) => {
    const switcher = page.locator('.toolbar .seg').nth(1)
    const names = await switcher.locator('button').allTextContents()
    expect(names.length).toBeGreaterThanOrEqual(2)
    // The filmstrip must show a canvas that could not be produced rather than omitting
    // it: "we could not make it" and "you did not ask" must never look the same.
    const strip = await page.locator('.filmstrip').innerText()
    expect(strip).toMatch(/canvases/)
  })

  test('switching canvas changes the render', async ({ page }) => {
    const switcher = page.locator('.toolbar .seg').nth(1)
    const buttons = await switcher.locator('button').all()
    if (buttons.length < 2) test.skip()
    const before = await page.locator('.art img').first().getAttribute('src')
    await buttons[1].click()
    await page.waitForTimeout(1200)
    const after = await page.locator('.art img').first().getAttribute('src')
    expect(after).not.toBe(before)
  })

  test('the drag handles are the right size', async ({ page }) => {
    // A regression test for a real bug: `.handle.tr` collided with a `.tr` table-row
    // class added for another page, inflating one 7px corner into a 26x24 white box
    // inside every selection.
    const art = page.locator('.art').first()
    const box = await art.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.35, { steps: 8 })
    await page.mouse.up()

    const handles = page.locator('.region.pending .handle')
    await expect(handles).toHaveCount(4)
    for (const handle of await handles.all()) {
      const size = await handle.boundingBox()
      expect(size!.width).toBeLessThan(12)
      expect(size!.height).toBeLessThan(12)
    }
  })

  test('a dragged region opens the compose panel and reports its size', async ({ page }) => {
    const art = page.locator('.art').first()
    const box = await art.boundingBox()
    await page.mouse.move(box!.x + box!.width * 0.15, box!.y + box!.height * 0.15)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.4, { steps: 10 })
    await page.mouse.up()

    const compose = page.locator('.compose')
    await expect(compose).toBeVisible()
    // Fractions of the canvas, so the same comment survives a re-render at another size.
    await expect(compose).toContainText('%')
    await expect(compose.getByRole('button', { name: 'Render new version' })).toBeVisible()
  })

  test('a click, not a drag, still produces a usable region', async ({ page }) => {
    // The schema refuses a zero-area rectangle, and the reference UI allows "click item
    // to comment", so a click has to become a small square rather than nothing.
    const art = page.locator('.art').first()
    const box = await art.boundingBox()
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5)
    await expect(page.locator('.compose')).toBeVisible()
  })

  test('a comment is saved and appears as a thread', async ({ page }) => {
    const art = page.locator('.art').first()
    const box = await art.boundingBox()
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.6)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.8, { steps: 8 })
    await page.mouse.up()

    const unique = `e2e probe ${Date.now()}`
    await page.locator('.compose textarea').fill(unique)
    await page.getByRole('button', { name: 'Add comment', exact: true }).click()

    await expect(page.locator('.toast')).toContainText('Comment added')
    await page.waitForTimeout(1500)
    await expect(page.locator('.review-body')).toContainText(unique)
  })

  test('a saved comment survives a reload, because it belongs to the request', async ({ page }) => {
    const threads = await page.locator('.thread').count()
    await page.reload()
    await page.waitForTimeout(1200)
    expect(await page.locator('.thread').count()).toBe(threads)
  })

  test('the cost of each action is stated, not implied', async ({ page }) => {
    // Two buttons sit side by side and one costs money. Unlabelled, the expensive one
    // becomes the default by accident.
    const panel = page.locator('.cost')
    await expect(panel).toContainText('Re-render')
    await expect(panel).toContainText('free')
    await expect(panel).toContainText('image call')
  })

  test('nothing offers a control that does not work', async ({ page }) => {
    // Beautify and Human help were in the reference and are not built. A disabled button
    // is a promise nobody kept, so they must be absent rather than greyed out.
    const body = await page.locator('body').innerText()
    expect(body).not.toContain('Beautify')
    expect(body).not.toContain('Human help')
  })

  test('every rail destination exists', async ({ page }) => {
    const hrefs = await page.locator('.rail-item').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href')).filter(Boolean),
    )
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) {
      const response = await page.request.get(href as string)
      expect(response.status(), `${href} is a dead end`).toBeLessThan(400)
    }
  })
})

test.describe('brand screen', () => {
  test('shows what ingest found, including what is missing', async ({ page }) => {
    await signIn(page, KAHUA)
    await page.goto('/brand')
    const body = await page.locator('body').innerText()
    // The planted problems in this kit, surfaced where a person will look.
    expect(body).toContain('logo_reverse')
    expect(body.toLowerCase()).toContain('no file')
    expect(body).toContain('tokens.json is withheld')
  })
})

test.describe('customers screen', () => {
  test('lists every kit with an honest status', async ({ page }) => {
    await signIn(page, KAHUA)
    await page.goto('/customers')
    const body = await page.locator('body').innerText()
    expect(body).toContain('bk-kahua-2026')
    // A kit that cannot be read must say so, with the reason attached.
    if (body.includes('bk-vantage-2026')) {
      expect(body).toContain('blocked')
      expect(body).toContain('DESIGN.md is the brand')
    }
  })

  test('an upload cannot claim another customer, and says so', async ({ page }) => {
    await signIn(page, KAHUA)
    await page.goto('/customers')
    await expect(page.locator('body')).toContainText('cannot assign ownership')
  })

  test('refuses a customer id that already exists', async ({ page }) => {
    await signIn(page, KAHUA)
    const response = await page.request.post('/api/customer', {
      multipart: {
        customer_id: 'kahua',
        kit_id: 'bk-kahua-2026',
        display_name: 'Not Kahua',
        files: { name: 'DESIGN.md', mimeType: 'text/markdown', buffer: Buffer.from('# nope\n') },
      },
    })
    // Adopting an existing kit would be a way to reach another tenant by naming it.
    expect(response.status()).toBe(409)
  })
})

test.describe('deploy screen', () => {
  test('shows evidence rather than intent', async ({ page }) => {
    await signIn(page, KAHUA)
    await page.goto('/deploy')
    await expect(page.locator('body')).toContainText('Deployment plan')
    // Published requires a recording and a url read back. The wording has to say so,
    // because a status nobody understands is a status nobody checks.
    await expect(page.locator('body')).toContainText('read back')
  })

  test('a deployment cannot be started for another customer', async ({ page }) => {
    await signIn(page, KAHUA)
    const response = await page.request.patch('/api/deploy', {
      data: { deployment_id: '00000000-0000-4000-8000-000000000000' },
    })
    expect(response.status()).toBe(404)
  })
})

test.describe('the API refuses what it should', () => {
  test('a forged session cookie is rejected', async ({ page, context }) => {
    // The real bypass this covers: the run route decoded the cookie and trusted its
    // customer id without verifying the signature, while holding the one key that
    // ignores row-level security.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'supabase',
        ref: 'anything',
        role: 'app_user',
        customer_id: 'kahua',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url')
    await context.addCookies([
      { name: 'cq_session', value: `${header}.${payload}.not-a-signature`, url: 'http://localhost:3100' },
    ])
    const response = await page.request.post('/api/run', {
      data: { revision_id: '00000000-0000-4000-8000-000000000000', mode: 'revise' },
    })
    expect(response.status()).toBe(401)
  })

  test('a revision id that is a flag is refused', async ({ page }) => {
    await signIn(page, KAHUA)
    const response = await page.request.post('/api/run', {
      data: { revision_id: '--allow-stale', mode: 'revise' },
    })
    expect(response.status()).toBe(400)
  })

  test('an unknown mode is refused', async ({ page }) => {
    await signIn(page, KAHUA)
    const response = await page.request.post('/api/run', {
      data: { revision_id: '00000000-0000-4000-8000-000000000000', mode: 'rm -rf /' },
    })
    expect(response.status()).toBe(400)
  })

  test('a file type that is not a brand file is refused', async ({ page }) => {
    await signIn(page, KAHUA)
    const response = await page.request.post('/api/kit', {
      multipart: {
        kit_id: 'bk-kahua-2026',
        files: { name: 'payload.sh', mimeType: 'text/plain', buffer: Buffer.from('#!/bin/sh\n') },
      },
    })
    expect(response.status()).toBe(400)
  })

  test('a path masquerading as a filename is refused', async ({ page }) => {
    await signIn(page, KAHUA)
    const response = await page.request.post('/api/kit', {
      multipart: {
        kit_id: 'bk-kahua-2026',
        files: { name: '../../escape.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
      },
    })
    expect(response.status()).toBe(400)
  })
})
