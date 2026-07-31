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
let ports: Array<{ imapPort: number; smtpPort: number }>
/** Set to make the next sign-in or unlock fail, as a wrong password would. */
let failWith: string | undefined
/** Set to make saving the ports fail, as an unwritable settings file would. */
let portFailure: string | undefined

function build(options: { allowPorts?: boolean } = {}): WebInterface {
  return new WebInterface({
    // A free port: the fixed default would make these tests fight each other.
    port: 0,
    ...(options.allowPorts === false
      ? {}
      : {
          onPorts: async (p) => {
            if (portFailure) return portFailure
            ports.push(p)
            return undefined
          },
        }),
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
      bridgeSmtpPort: 1025,
      ...(state.connected ? { address: 'someone@example.com' } : {}),
    }),
    notify: () => undefined,
  })
}

beforeEach(async () => {
  state = { connected: false, locked: false }
  signIns = []
  unlocks = []
  discards = 0
  ports = []
  failWith = undefined
  portFailure = undefined

  web = build()
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
  it('offers every option as a radio in the one form', async () => {
    // Choosing used to post and re-render. Everything now travels with the
    // credentials, so picking an option costs no round trip at all.
    const { body } = await send(`/?token=${token}`)
    for (const kind of ['keyring', 'encrypted-file', 'session', 'plain-file']) {
      expect(body).toContain(`name="store" id="store-${kind}" value="${kind}"`)
    }
    expect(body).not.toContain('/choose-store')
  })

  it('preselects exactly one option', async () => {
    // Which one depends on the machine, because listStores probes the real
    // keyring here. That exactly one radio is checked does not: a form with
    // none checked would submit no store at all, and one with two is invalid.
    const { body } = await send(`/?token=${token}`)
    const checked = body.match(/<input type="radio"[^>]*\schecked/g) ?? []
    expect(checked).toHaveLength(1)
  })

  it('carries the master password fields for every option', async () => {
    // In the document always, shown by CSS for the one store that uses them.
    // Rendering them only for that store is what forced the reload.
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('name="master"')
    expect(body).toContain('name="masterRepeat"')
    expect(body).toContain('if you forget it')
    expect(body).toContain('class="master-fields"')
  })

  it('carries the plain file warning, closable and not a refusal', async () => {
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('class="warning-layer"')
    expect(body).toContain('The password will be readable')
    expect(body).toContain('for="warning-seen"')
    // The option itself stays selectable: the warning informs, it does not veto.
    expect(body).not.toContain('id="store-plain-file" value="plain-file" disabled')
  })

  it('refuses an option that does not exist', async () => {
    // The choice is form input now, so a name nobody offered is ordinary
    // untrusted data. It falls back to the recommendation rather than being
    // handed to the session.
    const first = await send(`/?token=${token}`)
    const res = await send(`/sign-in?token=${token}`, {
      csrf: csrfFrom(first.body, '/sign-in'),
      store: 'somewhere-else',
      address: 'someone@example.com',
      password: 'bridge-password',
      // Supplied so the encrypted file is not turned away for a missing one;
      // which store gets recommended depends on the machine.
      master: 'my-master',
      masterRepeat: 'my-master',
    })
    expect(res.status).toBe(200)
    expect(signIns).toHaveLength(1)
    expect(['keyring', 'encrypted-file', 'session', 'plain-file']).toContain(signIns[0]?.store)
    expect(signIns[0]?.user).toBe('someone@example.com')
  })
})

describe('the advanced block on the sign-in page', () => {
  it('is folded away and prefilled with what the server will use', async () => {
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('<details class="card advanced">')
    // Not open: almost nobody needs it, and it must not be the first thing read.
    expect(body).not.toContain('<details class="card advanced" open>')
    expect(body).toContain('id="imapPort" name="imapPort" type="text" inputmode="numeric"\n         value="1143"')
    expect(body).toContain('value="1025"')
  })

  it('shows the Bridge address without letting it be changed', async () => {
    // A wrong port means nothing works and you notice. A wrong address means
    // the Bridge password goes to another machine and nobody notices.
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('value="127.0.0.1" disabled')
    expect(body).not.toContain('name="host"')
    expect(body).not.toContain('name="bridgeHost"')
  })

  it('saves the ports before the credentials are tried', async () => {
    // Otherwise a Bridge listening elsewhere reports a wrong password, because
    // the attempt went to a port with nothing behind it.
    const first = await send(`/?token=${token}`)
    await send(`/sign-in?token=${token}`, {
      csrf: csrfFrom(first.body, '/sign-in'),
      store: 'session',
      address: 'someone@example.com',
      password: 'bridge-password',
      imapPort: '2143',
      smtpPort: '2025',
    })
    expect(ports).toEqual([{ imapPort: 2143, smtpPort: 2025 }])
    expect(signIns).toHaveLength(1)
  })

  it('refuses a port that is not one, and opens the block', async () => {
    const first = await send(`/?token=${token}`)
    const res = await send(`/sign-in?token=${token}`, {
      csrf: csrfFrom(first.body, '/sign-in'),
      store: 'session',
      address: 'someone@example.com',
      password: 'bridge-password',
      imapPort: '70000',
      smtpPort: '1025',
    })
    expect(res.body).toContain('not a usable port')
    expect(res.body).toContain('<details class="card advanced" open>')
    // Nothing was tried with a port that cannot work.
    expect(ports).toEqual([])
    expect(signIns).toHaveLength(0)
  })

  it('shows the ports as text when the environment set them', async () => {
    await web.stop()
    web = build({ allowPorts: false })
    token = new URL(await web.start()).searchParams.get('token') ?? ''
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('come from the environment')
    expect(body).not.toContain('name="imapPort"')
  })
})

describe('signing in with an encrypted file', () => {
  async function chooseEncrypted(): Promise<string> {
    const first = await send(`/?token=${token}`)
    return csrfFrom(first.body, '/sign-in')
  }

  it('passes the master password through', async () => {
    const signInCsrf = await chooseEncrypted()
    const res = await send(`/sign-in?token=${token}`, {
      csrf: signInCsrf,
      store: 'encrypted-file',
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
      store: 'encrypted-file',
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
      store: 'encrypted-file',
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
      store: 'encrypted-file',
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
      store: 'encrypted-file',
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
