import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { WebInterface } from '../../src/web/server.js'
import {
  csrfToken,
  createSession,
  isAllowedHost,
  isAllowedOrigin,
  safeEqual,
  securityHeaders,
  REFERRER_POLICY,
} from '../../src/web/security.js'

/**
 * Attacks the running interface rather than inspecting the code.
 *
 * The threat model is not the internet: the server binds to loopback, so nobody
 * reaches it from outside. What matters is other programs on the same machine,
 * and what a foreign web page can talk the user's browser into doing.
 */

let web: WebInterface
let url: URL
let token: string
let signIns: Array<{ user: string; pass: string; store: string }> = []
let signOuts = 0
let connected = false

beforeEach(async () => {
  signIns = []
  signOuts = 0
  connected = false
  web = new WebInterface({
    // A random free port: with the fixed default these tests would fight each
    // other over it, and a passing security test must not depend on timing.
    port: 0,
    onSignIn: async (credentials, store) => {
      signIns.push({ ...credentials, store })
      connected = true
      return undefined
    },
    onSignOut: async () => {
      signOuts++
      connected = false
    },
    getStatus: async () => ({ connected, bridgeHost: '127.0.0.1', bridgeImapPort: 1143 }),
    // Rejections are logged; in tests that would only be noise.
    notify: () => undefined,
  })
  const started = await web.start()
  url = new URL(started)
  token = url.searchParams.get('token') ?? ''
})

afterEach(async () => {
  await web.stop()
})

interface Response {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** Sends a raw request, so headers can be set that a browser would not allow. */
function send(options: {
  method?: string
  path: string
  host?: string
  origin?: string
  body?: string
  contentType?: string
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (options.host !== undefined) headers.Host = options.host
    if (options.origin !== undefined) headers.Origin = options.origin
    if (options.body !== undefined) {
      headers['Content-Type'] = options.contentType ?? 'application/x-www-form-urlencoded'
      headers['Content-Length'] = String(Buffer.byteLength(options.body))
    }

    const req = httpRequest(
      { hostname: '127.0.0.1', port: web.port, path: options.path, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

describe('access token', () => {
  it('serves the page with the right token', async () => {
    const res = await send({ path: `/?token=${token}` })
    expect(res.status).toBe(200)
    expect(res.body).toContain('Connect to Proton Mail Bridge')
  })

  it('refuses a request without a token', async () => {
    // Any local program can reach 127.0.0.1. Without a secret it could drive
    // this interface.
    const res = await send({ path: '/' })
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('Connect to Proton Mail Bridge')
  })

  it('refuses a wrong token', async () => {
    const res = await send({ path: '/?token=wrong' })
    expect(res.status).toBe(404)
  })

  it('refuses a token that is only a prefix of the real one', async () => {
    const res = await send({ path: `/?token=${token.slice(0, -1)}` })
    expect(res.status).toBe(404)
  })

  it('refuses a token with something appended', async () => {
    const res = await send({ path: `/?token=${token}x` })
    expect(res.status).toBe(404)
  })

  it('answers every rejection identically, whatever the reason', async () => {
    // Telling a caller which check failed would help them work around it.
    const noToken = await send({ path: '/' })
    const badToken = await send({ path: '/?token=nope' })
    const badPath = await send({ path: `/nonexistent?token=${token}` })
    expect(noToken.status).toBe(badToken.status)
    expect(noToken.body).toBe(badToken.body)
    expect(badPath.status).toBe(noToken.status)
  })

  it('invalidates the old link when the token is rotated', async () => {
    const before = await send({ path: `/?token=${token}` })
    expect(before.status).toBe(200)
    web.rotateToken()
    const after = await send({ path: `/?token=${token}` })
    expect(after.status).toBe(404)
  })
})

describe('DNS rebinding', () => {
  it('refuses a foreign Host header', async () => {
    // The attack local servers forget: a page at evil.example.com points that
    // name at 127.0.0.1, and the browser sends the request with that Host. The
    // browser considers the page same-origin with it, so origin rules do not
    // help.
    const res = await send({ path: `/?token=${token}`, host: 'evil.example.com' })
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('Connect to Proton Mail Bridge')
  })

  it('refuses a foreign Host even with a valid token and port', async () => {
    const res = await send({ path: `/?token=${token}`, host: `evil.example.com:${web.port}` })
    expect(res.status).toBe(404)
  })

  it('accepts the loopback names', async () => {
    for (const host of [`127.0.0.1:${web.port}`, `localhost:${web.port}`]) {
      const res = await send({ path: `/?token=${token}`, host })
      expect(res.status).toBe(200)
    }
  })

  it('refuses a Host that merely contains a loopback name', async () => {
    const res = await send({ path: `/?token=${token}`, host: 'localhost.evil.example.com' })
    expect(res.status).toBe(404)
  })
})

describe('cross-site requests', () => {
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

  it('accepts a sign-in with a matching csrf token', async () => {
    const secrets = createSession()
    // The real token has to come from the page, so fetch it first.
    const page = await send({ path: `/?token=${token}` })
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    expect(csrf).not.toBe('')
    expect(csrf).not.toBe(csrfToken(secrets, '/sign-in'))

    const res = await send({
      method: 'POST',
      path: `/sign-in?token=${token}`,
      // The master password fields ride along even though this test is about
      // csrf. Which store is preselected depends on whether this machine has a
      // working keyring, and the encrypted file rightly refuses to be set up
      // without one. Sending them keeps the test on its own subject instead of
      // passing or failing with the environment.
      body: form({
        csrf,
        address: 'a@example.com',
        password: 'secret',
        master: 'master-password',
        masterRepeat: 'master-password',
      }),
    })
    expect(res.status).toBe(200)
    expect(signIns).toHaveLength(1)
  })

  it('refuses a write without a csrf token', async () => {
    const res = await send({
      method: 'POST',
      path: `/sign-in?token=${token}`,
      body: form({ address: 'a@example.com', password: 'secret' }),
    })
    expect(res.status).toBe(404)
    expect(signIns).toHaveLength(0)
  })

  it('refuses a csrf token issued for another action', async () => {
    // Otherwise a token lifted from one form could drive another.
    const page = await send({ path: `/?token=${token}` })
    const signInCsrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    const res = await send({
      method: 'POST',
      path: `/sign-out?token=${token}`,
      body: form({ csrf: signInCsrf }),
    })
    expect(res.status).toBe(404)
    expect(signOuts).toBe(0)
  })

  it('refuses a write from a foreign origin', async () => {
    const page = await send({ path: `/?token=${token}` })
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    const res = await send({
      method: 'POST',
      path: `/sign-in?token=${token}`,
      origin: 'https://evil.example.com',
      body: form({ csrf, address: 'a@example.com', password: 'secret' }),
    })
    expect(res.status).toBe(404)
    expect(signIns).toHaveLength(0)
  })

  it('refuses an opaque origin', async () => {
    // What a sandboxed iframe sends.
    const page = await send({ path: `/?token=${token}` })
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    const res = await send({
      method: 'POST',
      path: `/sign-in?token=${token}`,
      origin: 'null',
      body: form({ csrf, address: 'a@example.com', password: 'secret' }),
    })
    expect(res.status).toBe(404)
  })

  it('does not send a referrer policy that makes browsers hide the origin', () => {
    // The one defence that broke the others. Per the Fetch standard, a
    // `no-referrer` policy makes the browser send `Origin: null`, which the
    // check above rightly refuses. The interface then refuses its own forms:
    // confirmed in a real browser, where every POST answered 404 with
    // reason bad-origin until the policy was changed.
    //
    // The tests in this file set the Origin header themselves, so they could
    // never catch it. This one asserts on the cause instead.
    expect(REFERRER_POLICY).not.toBe('no-referrer')
    expect(securityHeaders()['Referrer-Policy']).toBe(REFERRER_POLICY)
  })
})

describe('request handling', () => {
  it('refuses methods other than GET and POST', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'TRACE']) {
      const res = await send({ method, path: `/?token=${token}` })
      expect([404, 405]).toContain(res.status)
    }
  })

  it('refuses an oversized body instead of buffering it', async () => {
    const res = await send({
      method: 'POST',
      path: `/sign-in?token=${token}`,
      body: 'x'.repeat(200_000),
    })
    expect([404, 413]).toContain(res.status)
    expect(signIns).toHaveLength(0)
  })

  it('serves no files from disk, so path traversal has nothing to reach', async () => {
    for (const path of [
      '/../package.json',
      '/../../etc/passwd',
      '/%2e%2e%2fpackage.json',
      '/static/../../package.json',
    ]) {
      const res = await send({ path: `${path}?token=${token}` })
      expect(res.status).toBe(404)
      expect(res.body).not.toContain('"name"')
      expect(res.body).not.toContain('root:')
    }
  })
})

describe('response headers', () => {
  it('sends a content security policy that forbids loading anything', async () => {
    const res = await send({ path: `/?token=${token}` })
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'self'")
  })

  it('forbids framing and sniffing, and keeps referrers on this origin', async () => {
    const res = await send({ path: `/?token=${token}` })
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    // Deliberately same-origin and not no-referrer. This assertion used to
    // demand no-referrer and so kept a real defect in place: that policy makes
    // browsers send `Origin: null`, which the origin check refuses, so every
    // form on this interface answered 404 in a real browser. Nothing is given
    // up, because the CSP forbids reaching any other host and the page links
    // nowhere else.
    expect(res.headers['referrer-policy']).toBe('same-origin')
  })

  it('forbids caching, so a later user cannot read the page from disk', async () => {
    const res = await send({ path: `/?token=${token}` })
    expect(String(res.headers['cache-control'])).toContain('no-store')
  })

  it('sets the headers on rejections too', async () => {
    const res = await send({ path: '/' })
    expect(res.headers['content-security-policy']).toBeDefined()
  })
})

describe('binding', () => {
  it('listens on loopback only, not on any other address of this machine', async () => {
    // Binding to 0.0.0.0 would put a page that stores credentials on the network.
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && !i.internal && i.family === 'IPv4')
      .map((i) => i?.address)
      .filter((a): a is string => Boolean(a))

    if (external.length === 0) {
      // No other interface to test against, which is itself fine.
      expect(true).toBe(true)
      return
    }

    const reachable = await new Promise<boolean>((resolve) => {
      const req = httpRequest(
        { hostname: external[0], port: web.port, path: '/', timeout: 2000 },
        () => resolve(true),
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
    expect(reachable).toBe(false)
  })
})

describe('the page itself', () => {
  it('states that this is not an official Proton project', async () => {
    const res = await send({ path: `/?token=${token}` })
    expect(res.body).toContain('not made by, affiliated with or endorsed by Proton AG')
    expect(res.body).toContain('unofficial')
  })

  it('uses no Proton logo or wordmark, only a palette', async () => {
    // Trademarks. Borrowing the colours is fine, the marks are not.
    const res = await send({ path: `/?token=${token}` })
    expect(res.body).not.toMatch(/<img/i)
    expect(res.body).not.toMatch(/\.svg/i)
    expect(res.body).not.toMatch(/proton\.me/i)
  })

  it('warns that the Bridge password is not the account password', async () => {
    const res = await send({ path: `/?token=${token}` })
    expect(res.body).toContain('Not your Proton account password')
  })

  it('shows all four storage options with both sides', async () => {
    const res = await send({ path: `/?token=${token}` })
    for (const title of ['System keyring', 'Encrypted file', 'This session only', 'Plain file']) {
      expect(res.body).toContain(title)
    }
    expect(res.body).toContain('class="pro"')
    expect(res.body).toContain('class="con"')
  })

  it('loads nothing from the network', async () => {
    const res = await send({ path: `/?token=${token}` })
    expect(res.body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/)
  })
})

describe('security helpers', () => {
  it('compares tokens without revealing length through an exception', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('a', '')).toBe(false)
  })

  it('accepts only loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '127.0.0.1:7345', '[::1]:7345', 'LOCALHOST']) {
      expect(isAllowedHost(host)).toBe(true)
    }
    for (const host of [undefined, '', 'example.com', 'localhost.evil.com', '127.0.0.1.evil.com', '10.0.0.5']) {
      expect(isAllowedHost(host)).toBe(false)
    }
  })

  it('accepts a missing origin but not a foreign one', () => {
    // Browsers omit Origin on ordinary navigation, and non-browser clients never
    // send it, so a missing one cannot be treated as hostile.
    expect(isAllowedOrigin(undefined, 7345)).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:7345', 7345)).toBe(true)
    expect(isAllowedOrigin('http://localhost:7345', 7345)).toBe(true)
    expect(isAllowedOrigin('https://evil.example.com', 7345)).toBe(false)
    expect(isAllowedOrigin('null', 7345)).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:9999', 7345)).toBe(false)
    expect(isAllowedOrigin('not a url', 7345)).toBe(false)
  })
})
