import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { WebInterface } from '../../src/web/server.js'
import { createSession } from '../../src/web/security.js'
import type { StoreKind } from '../../src/credentials/store.js'

/**
 * The sign-in flow as a user walks it, rather than as an attacker.
 *
 * Attacks live in security/web-interface.test.ts. What matters here is that the
 * page asks for the right things: the encrypted file needs a master password,
 * and a restart with one already on disk must ask for that password alone
 * instead of sending the user back to the Bridge for theirs.
 */

interface State {
  connected: boolean
  locked: boolean
}

let web: WebInterface
let token: string
let state: State
let signIns: Array<{ user: string; pass: string; store: StoreKind; master?: string }>
let unlocks: string[]
let discards: number
/** Set to make the next sign-in or unlock fail, as a wrong password would. */
let failWith: string | undefined

beforeEach(async () => {
  state = { connected: false, locked: false }
  signIns = []
  unlocks = []
  discards = 0
  failWith = undefined

  web = new WebInterface({
    // A free port: the fixed default would make these tests fight each other.
    port: 0,
    onSignIn: async (credentials, store, master) => {
      if (failWith) return failWith
      signIns.push({ ...credentials, store, ...(master ? { master } : {}) })
      state.connected = true
      if (store === 'encrypted-file') state.locked = false
      return undefined
    },
    onSignOut: async () => {
      state.connected = false
    },
    onUnlock: async (master) => {
      unlocks.push(master)
      if (failWith) return failWith
      state.connected = true
      state.locked = false
      return undefined
    },
    onDiscardEncrypted: async () => {
      discards++
      state.locked = false
    },
    getStatus: async () => ({
      connected: state.connected,
      locked: state.locked,
      encryptedPath: '/home/someone/.config/proton-mcp/credentials.enc',
      bridgeHost: '127.0.0.1',
      bridgeImapPort: 1143,
      ...(state.connected ? { address: 'someone@example.com' } : {}),
    }),
    notify: () => undefined,
  })
  token = new URL(await web.start()).searchParams.get('token') ?? ''
})

afterEach(async () => {
  await web.stop()
})

interface Response {
  status: number
  body: string
}

function send(path: string, body?: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const encoded = body ? new URLSearchParams(body).toString() : undefined
    const headers: Record<string, string> = { Host: `127.0.0.1:${web.port}` }
    if (encoded !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['Content-Length'] = String(Buffer.byteLength(encoded))
      headers.Origin = `http://127.0.0.1:${web.port}`
    }
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: web.port,
        path,
        method: encoded === undefined ? 'GET' : 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    if (encoded !== undefined) req.write(encoded)
    req.end()
  })
}

/**
 * Pulls the hidden CSRF field out of a rendered page, the way a browser would.
 *
 * The session secret never leaves the interface, so the page it rendered is the
 * only honest source for a valid token. Building one from a secret of our own
 * would prove nothing except that the check rejects strangers.
 */
function csrfFrom(body: string, action: string): string {
  // Matches the form for the given action and takes the csrf value inside it.
  const form = body.split(`action="${action}?token=`)[1] ?? ''
  return /name="csrf" value="([^"]+)"/.exec(form)?.[1] ?? ''
}

describe('choosing where the password is kept', () => {
  it('shows which option is selected', async () => {
    const first = await send(`/?token=${token}`)
    // Nothing chosen yet: the suggestion is marked as selected so the form
    // never claims a destination the user did not see.
    expect(first.body).toContain('Will be kept in:')

    const chosen = await send(`/choose-store?token=${token}`, {
      csrf: csrfFrom(first.body, '/choose-store'),
      kind: 'plain-file',
    })
    expect(chosen.status).toBe(200)
    expect(chosen.body).toContain('selected')
    expect(chosen.body).toContain('Plain file')
  })

  it('asks for a master password once the encrypted file is chosen', async () => {
    const first = await send(`/?token=${token}`)
    const chosen = await send(`/choose-store?token=${token}`, {
      csrf: csrfFrom(first.body, '/choose-store'),
      kind: 'encrypted-file',
    })
    // The field that was missing entirely, which made this option unusable.
    expect(chosen.body).toContain('name="master"')
    expect(chosen.body).toContain('name="masterRepeat"')
    expect(chosen.body).toContain('if you forget it')
  })

  it('does not ask for a master password for the other stores', async () => {
    const first = await send(`/?token=${token}`)
    const chosen = await send(`/choose-store?token=${token}`, {
      csrf: csrfFrom(first.body, '/choose-store'),
      kind: 'session',
    })
    expect(chosen.body).not.toContain('name="master"')
  })
})

describe('signing in with an encrypted file', () => {
  async function chooseEncrypted(): Promise<string> {
    const first = await send(`/?token=${token}`)
    const chosen = await send(`/choose-store?token=${token}`, {
      csrf: csrfFrom(first.body, '/choose-store'),
      kind: 'encrypted-file',
    })
    return csrfFrom(chosen.body, '/sign-in')
  }

  it('passes the master password through', async () => {
    const signInCsrf = await chooseEncrypted()
    const res = await send(`/sign-in?token=${token}`, {
      csrf: signInCsrf,
      address: 'someone@example.com',
      password: 'bridge-password',
      master: 'my-master',
      masterRepeat: 'my-master',
    })
    expect(res.status).toBe(200)
    expect(signIns).toEqual([
      {
        user: 'someone@example.com',
        pass: 'bridge-password',
        store: 'encrypted-file',
        master: 'my-master',
      },
    ])
  })

  it('refuses two master passwords that differ', async () => {
    const signInCsrf = await chooseEncrypted()
    const res = await send(`/sign-in?token=${token}`, {
      csrf: signInCsrf,
      address: 'someone@example.com',
      password: 'bridge-password',
      master: 'my-master',
      masterRepeat: 'my-mistake',
    })
    // Caught before anything is encrypted: a typo in a password nothing can
    // recover would otherwise lock the file for good.
    expect(res.body).toContain('do not match')
    expect(signIns).toHaveLength(0)
  })

  it('refuses a missing master password', async () => {
    const signInCsrf = await chooseEncrypted()
    const res = await send(`/sign-in?token=${token}`, {
      csrf: signInCsrf,
      address: 'someone@example.com',
      password: 'bridge-password',
    })
    expect(res.body).toContain('needs a master password')
    expect(signIns).toHaveLength(0)
  })

  it('keeps the address after a failed attempt but never the password', async () => {
    failWith = 'the Bridge refused those credentials'
    const signInCsrf = await chooseEncrypted()
    const res = await send(`/sign-in?token=${token}`, {
      csrf: signInCsrf,
      address: 'someone@example.com',
      password: 'bridge-password',
      master: 'my-master',
      masterRepeat: 'my-master',
    })
    expect(res.body).toContain('someone@example.com')
    expect(res.body).toContain('the Bridge refused those credentials')
    expect(res.body).not.toContain('bridge-password')
    expect(res.body).not.toContain('my-master')
  })
})

describe('unlocking a stored encrypted file', () => {
  beforeEach(() => {
    // What a restart looks like: the file is on disk, nothing is open.
    state.locked = true
  })

  it('asks for the master password alone', async () => {
    const res = await send(`/?token=${token}`)
    expect(res.body).toContain('Unlock the stored credentials')
    expect(res.body).toContain('name="master"')
    // The Bridge password is already on disk, so asking for it again would be
    // asking the user to go back to the Bridge for nothing.
    expect(res.body).not.toContain('name="password"')
    expect(res.body).not.toContain('name="address"')
  })

  it('names the file so the user can find it', async () => {
    const res = await send(`/?token=${token}`)
    expect(res.body).toContain('/home/someone/.config/proton-mcp/credentials.enc')
  })

  it('unlocks with the right password and lands on the overview', async () => {
    const page = await send(`/?token=${token}`)
    const res = await send(`/unlock?token=${token}`, {
      csrf: csrfFrom(page.body, '/unlock'),
      master: 'my-master',
    })
    expect(unlocks).toEqual(['my-master'])
    expect(res.body).toContain('Overview')
    expect(res.body).toContain('someone@example.com')
  })

  it('stays on the unlock page when the password is wrong', async () => {
    failWith = 'The credentials could not be decrypted.'
    const page = await send(`/?token=${token}`)
    const res = await send(`/unlock?token=${token}`, {
      csrf: csrfFrom(page.body, '/unlock'),
      master: 'wrong',
    })
    expect(res.body).toContain('Unlock the stored credentials')
    expect(res.body).toContain('could not be decrypted')
    // Not thrown back to the full form: the file is still there and still only
    // needs one password.
    expect(res.body).not.toContain('name="address"')
  })

  it('refuses an empty master password without calling through', async () => {
    const page = await send(`/?token=${token}`)
    const res = await send(`/unlock?token=${token}`, {
      csrf: csrfFrom(page.body, '/unlock'),
      master: '',
    })
    expect(res.body).toContain('required')
    expect(unlocks).toHaveLength(0)
  })

  it('offers a way out for a forgotten master password', async () => {
    const page = await send(`/?token=${token}`)
    expect(page.body).toContain('Forgot the master password?')

    const res = await send(`/discard-encrypted?token=${token}`, {
      csrf: csrfFrom(page.body, '/discard-encrypted'),
    })
    expect(discards).toBe(1)
    // Back to the ordinary sign-in form: without this the user would be stuck
    // on a page that only accepts something they do not have.
    expect(res.body).toContain('Connect to Proton Mail Bridge')
  })

  it('binds the discard form to its own action', async () => {
    // A CSRF token for one action must not work for another, and deleting the
    // stored credentials is the one action where that matters most.
    const page = await send(`/?token=${token}`)
    const res = await send(`/discard-encrypted?token=${token}`, {
      csrf: csrfFrom(page.body, '/unlock'),
    })
    expect(res.status).toBe(404)
    expect(discards).toBe(0)
  })
})

describe('a browser-shaped request', () => {
  /**
   * Posts the way a browser does: with the Origin the page was served from, and
   * with the csrf token read out of that page.
   *
   * Worth its own test because the defect this guards against was invisible to
   * every other one. A `no-referrer` policy makes browsers send `Origin: null`,
   * the origin check refuses that, and the interface refuses its own forms. The
   * tests here set Origin themselves, so they all passed while nothing worked.
   */
  it('completes a sign-in with the page-supplied token and origin', async () => {
    const page = await send(`/?token=${token}`)
    const res = await send(`/sign-in?token=${token}`, {
      csrf: csrfFrom(page.body, '/sign-in'),
      address: 'someone@example.com',
      password: 'bridge-password',
      master: 'my-master',
      masterRepeat: 'my-master',
    })
    expect(res.status).toBe(200)
    expect(signIns).toHaveLength(1)
  })

  it('answers the favicon quietly instead of logging a refusal', async () => {
    // Browsers ask on every page view. Recording each as a refused request
    // buries the refusals that mean something.
    const res = await send('/favicon.ico')
    expect(res.status).toBe(404)
    expect(res.body).toBe('')
  })
})

describe('createSession', () => {
  it('mints different secrets every time', () => {
    const a = createSession()
    const b = createSession()
    expect(a.accessToken).not.toBe(b.accessToken)
    expect(a.csrfSecret).not.toBe(b.csrfSecret)
  })
})
