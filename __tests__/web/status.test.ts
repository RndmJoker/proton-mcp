import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { WebInterface, type StatusSnapshot } from '../../src/web/server.js'
import { formatDuration } from '../../src/web/layout.js'

/**
 * The sections, what each one says, and what none of them says.
 *
 * The line that matters most here is the one about mailbox names. They belong to
 * the whole Proton account rather than the address that signed in, so a name like
 * Folders/Banking gives something away on its own. They appear on their own page,
 * on request, and nowhere else.
 *
 * The second is the shape of the split itself: a control belongs to the section
 * it acts on. A test that finds the port form on the overview is reporting a
 * regression, not a detail.
 */

let web: WebInterface
let token: string
let snapshot: StatusSnapshot
let ports: Array<{ imapPort: number; smtpPort: number }>
let tests: number
let testResult: { ok: boolean; message: string }
let mailboxCalls: number
/** Set to make listing mailboxes fail, as an unreachable Bridge would. */
let mailboxFailure: string | undefined
let noticeDismissed: boolean
let dismissals: number

function build(
  options: { allowPorts?: boolean; allowDismiss?: boolean; dismissSticks?: boolean } = {},
): WebInterface {
  return new WebInterface({
    port: 0,
    onSignIn: async () => undefined,
    onSignOut: async () => {
      snapshot.connected = false
    },
    getStatus: async () => snapshot,
    ...(options.allowPorts === false
      ? {}
      : {
          onPorts: async (p) => {
            ports.push(p)
            snapshot.bridgeImapPort = p.imapPort
            snapshot.bridgeSmtpPort = p.smtpPort
            return undefined
          },
        }),
    ...(options.allowDismiss === false
      ? {}
      : {
          noticeDismissed: () => noticeDismissed,
          onDismissNotice: async () => {
            dismissals++
            // Not sticking is a real state: it is what a settings file that
            // cannot be written looks like from here.
            if (options.dismissSticks !== false) noticeDismissed = true
          },
        }),
    onTest: async () => {
      tests++
      return testResult
    },
    getMailboxes: async () => {
      mailboxCalls++
      if (mailboxFailure) throw new Error(mailboxFailure)
      return [
        { path: 'INBOX', kind: 'system' as const, selectable: true },
        { path: 'Folders', kind: 'folder' as const, selectable: false },
        { path: 'Folders/Banking', kind: 'folder' as const, selectable: true },
        { path: 'Labels/Receipts', kind: 'label' as const, selectable: true },
      ]
    },
    getActivity: () => ({
      running: [{ tool: 'search_messages', forMs: 4200 }],
      recent: [
        { tool: 'list_folders', at: 1_700_000_000_000, durationMs: 120, outcome: 'ok' as const },
        { tool: 'get_message', at: 1_700_000_001_000, durationMs: 90, outcome: 'failed' as const },
      ],
    }),
    notify: () => undefined,
  })
}

beforeEach(async () => {
  ports = []
  tests = 0
  mailboxCalls = 0
  dismissals = 0
  noticeDismissed = false
  mailboxFailure = undefined
  testResult = { ok: true, message: 'The Bridge answered and accepted the credentials.' }
  snapshot = {
    connected: true,
    address: 'someone@example.com',
    storeKind: 'keyring',
    mailboxCount: 12,
    messageCount: 26_816,
    unseenCount: 3,
    bridgeHost: '127.0.0.1',
    bridgeImapPort: 1143,
    bridgeSmtpPort: 1025,
    readOnly: false,
    uptimeMs: 3_600_000,
    certificate: {
      fingerprint: 'AA:BB:CC:DD',
      subject: 'Proton Mail Bridge',
      firstSeen: '2026-07-29T10:00:00.000Z',
    },
  }
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

/** The hidden csrf field of one form on a rendered page. */
function csrfFrom(body: string, action: string): string {
  const form = body.split(`action="${action}?token=`)[1] ?? ''
  return /name="csrf" value="([^"]+)"/.exec(form)?.[1] ?? ''
}

describe('the sections and how they are reached', () => {
  it('offers every section in the navigation', async () => {
    const { body } = await send(`/?token=${token}`)
    for (const path of ['/mailboxes', '/bridge', '/credentials', '/activity']) {
      expect(body).toContain(`href="${path}?token=${token}"`)
    }
  })

  it('marks the section being looked at', async () => {
    const { body } = await send(`/bridge?token=${token}`)
    expect(body).toContain(`href="/bridge?token=${token}" aria-current="page"`)
    // And only that one. Matched on the full attribute rather than the name,
    // which also appears in the stylesheet.
    expect(body.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('refuses a path nobody listed', async () => {
    const { status } = await send(`/settings?token=${token}`)
    expect(status).toBe(404)
  })

  it('carries no script anywhere', async () => {
    // The CSP forbids it. A page that grew one would be refused by the browser
    // rather than by anything here, which is a bad way to find out.
    for (const path of ['/', '/bridge', '/credentials', '/activity', '/mailboxes']) {
      const { body } = await send(`${path}?token=${token}`)
      expect(body).not.toMatch(/<script/i)
      expect(body).not.toMatch(/\son[a-z]+=/i)
    }
  })
})

describe('what the overview reports', () => {
  it('names the connection, the address and where credentials are kept', async () => {
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('connected')
    expect(body).toContain('someone@example.com')
    expect(body).toContain('System keyring')
  })

  it('shows both Bridge ports and the interface port', async () => {
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('127.0.0.1:1143')
    expect(body).toContain('127.0.0.1:1025')
    expect(body).toContain(`127.0.0.1:${web.port}`)
  })

  it('states the read-only mode plainly', async () => {
    const withoutWrites = await send(`/?token=${token}`)
    expect(withoutWrites.body).toContain('read and write')

    snapshot.readOnly = true
    const readOnly = await send(`/?token=${token}`)
    expect(readOnly.body).toContain('read-only')
  })

  it('shows the uptime and the counters', async () => {
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('1 h 0 min')
    expect(body).toContain('26816')
    expect(body).toContain('3 unread')
  })

  it('carries no control of its own', async () => {
    // Every button lives in the section it acts on, so that a page opened to
    // check something is not the page where something is changed by accident.
    const { body } = await send(`/?token=${token}`)
    const main = body.split('<main>')[1] ?? ''
    expect(main).not.toContain('<button type="submit">')
  })
})

describe('the bridge section', () => {
  it('shows the pinned certificate', async () => {
    const { body } = await send(`/bridge?token=${token}`)
    expect(body).toContain('AA:BB:CC:DD')
    expect(body).toContain('Proton Mail Bridge')
    expect(body).toContain('2026-07-29')
  })

  it('says so when nothing is pinned yet', async () => {
    delete snapshot.certificate
    const { body } = await send(`/bridge?token=${token}`)
    expect(body).toContain('Nothing recorded yet')
  })
})

describe('activity', () => {
  it('shows what is running and for how long', async () => {
    const { body } = await send(`/activity?token=${token}`)
    expect(body).toContain('search_messages')
    expect(body).toContain('4 s')
    expect(body).toContain('In progress')
  })

  it('shows finished calls with their outcome', async () => {
    const { body } = await send(`/activity?token=${token}`)
    expect(body).toContain('list_folders')
    expect(body).toContain('get_message')
    expect(body).toContain('failed')
  })

  it('explains that arguments are not recorded', async () => {
    // The promise the record keeps. If this text goes, check that the record
    // still keeps it.
    const { body } = await send(`/activity?token=${token}`)
    expect(body).toContain('deliberately not recorded')
  })

  it('is not on any other section', async () => {
    const { body } = await send(`/?token=${token}`)
    expect(body).not.toContain('search_messages')
  })
})

describe('mailbox names', () => {
  it('are not on the overview', async () => {
    const { body } = await send(`/?token=${token}`)
    expect(body).not.toContain('Folders/Banking')
    expect(mailboxCalls).toBe(0)
  })

  it('appear only on their own page, when asked for', async () => {
    const { body } = await send(`/mailboxes?token=${token}`)
    expect(body).toContain('Folders/Banking')
    expect(body).toContain('Labels/Receipts')
    expect(body).toContain('INBOX')
    expect(mailboxCalls).toBe(1)
  })

  it('leaves out the containers that cannot hold messages', async () => {
    const { body } = await send(`/mailboxes?token=${token}`)
    // "Folders" itself is \Noselect and is only an artefact of the IMAP layout.
    expect(body).not.toMatch(/<code>Folders<\/code>/)
  })

  it('need a token like everything else', async () => {
    const { status, body } = await send('/mailboxes')
    expect(status).toBe(404)
    expect(body).not.toContain('Folders/Banking')
  })

  it('are not offered when nobody is signed in', async () => {
    snapshot.connected = false
    const { body } = await send(`/mailboxes?token=${token}`)
    expect(body).not.toContain('Folders/Banking')
    expect(mailboxCalls).toBe(0)
  })

  it('report a failure instead of an empty list', async () => {
    mailboxFailure = 'the Bridge is not answering'
    const { body } = await send(`/mailboxes?token=${token}`)
    expect(body).toContain('the Bridge is not answering')
  })
})

describe('changing the Bridge ports', () => {
  it('saves valid ports and says so, on the section they belong to', async () => {
    const page = await send(`/bridge?token=${token}`)
    const res = await send(`/settings?token=${token}`, {
      csrf: csrfFrom(page.body, '/settings'),
      imapPort: '2143',
      smtpPort: '2025',
    })
    expect(ports).toEqual([{ imapPort: 2143, smtpPort: 2025 }])
    expect(res.body).toContain('Ports saved')
    expect(res.body).toContain('name="imapPort"')
    expect(res.body).toContain('value="2143"')
  })

  it('refuses something that is not a port', async () => {
    const page = await send(`/bridge?token=${token}`)
    for (const bad of ['0', '65536', 'abc', '', '1143.5']) {
      const res = await send(`/settings?token=${token}`, {
        csrf: csrfFrom(page.body, '/settings'),
        imapPort: bad,
        smtpPort: '1025',
      })
      expect(res.body).toContain('not a usable port')
    }
    expect(ports).toEqual([])
  })

  it('needs its own csrf token', async () => {
    const page = await send(`/credentials?token=${token}`)
    const res = await send(`/settings?token=${token}`, {
      csrf: csrfFrom(page.body, '/sign-out'),
      imapPort: '2143',
      smtpPort: '2025',
    })
    expect(res.status).toBe(404)
    expect(ports).toEqual([])
  })

  it('offers no form at all when the environment set the ports', async () => {
    await web.stop()
    web = build({ allowPorts: false })
    token = new URL(await web.start()).searchParams.get('token') ?? ''
    const { body } = await send(`/bridge?token=${token}`)
    // An explicit BRIDGE_IMAP_PORT has to keep meaning what it says.
    expect(body).toContain('come from the environment')
    expect(body).not.toContain('name="imapPort"')
  })

  it('never offers a host field, on any section', async () => {
    // It would be a field that sends the Bridge password to another machine.
    for (const path of ['/', '/bridge', '/credentials', '/activity', '/mailboxes']) {
      const { body } = await send(`${path}?token=${token}`)
      expect(body).not.toContain('name="host"')
      expect(body).not.toContain('name="bridgeHost"')
    }
  })
})

describe('testing the connection', () => {
  it('reports success as a notice', async () => {
    const page = await send(`/bridge?token=${token}`)
    const res = await send(`/test-connection?token=${token}`, {
      csrf: csrfFrom(page.body, '/test-connection'),
    })
    expect(tests).toBe(1)
    expect(res.body).toContain('accepted the credentials')
    expect(res.body).toContain('class="notice"')
  })

  it('reports a failure as an error', async () => {
    testResult = { ok: false, message: 'Connection refused on 127.0.0.1:1143.' }
    const page = await send(`/bridge?token=${token}`)
    const res = await send(`/test-connection?token=${token}`, {
      csrf: csrfFrom(page.body, '/test-connection'),
    })
    expect(res.body).toContain('Connection refused')
    expect(res.body).toContain('class="error"')
  })
})

describe('the unofficial notice', () => {
  it('is on every page, signed in or not', async () => {
    snapshot.connected = false
    const signedOut = await send(`/?token=${token}`)
    expect(signedOut.body).toContain('not made by, affiliated with or endorsed by Proton AG')

    snapshot.connected = true
    for (const path of ['/', '/bridge', '/credentials', '/activity', '/mailboxes']) {
      const { body } = await send(`${path}?token=${token}`)
      expect(body).toContain('not made by, affiliated with or endorsed by Proton AG')
    }
  })

  it('can be sent away, and stays away', async () => {
    const page = await send(`/?token=${token}`)
    const res = await send(`/dismiss-notice?token=${token}`, {
      csrf: csrfFrom(page.body, '/dismiss-notice'),
      from: 'overview',
    })
    expect(dismissals).toBe(1)
    expect(res.body).not.toContain('not made by, affiliated with or endorsed by Proton AG')

    const later = await send(`/bridge?token=${token}`)
    expect(later.body).not.toContain('not made by, affiliated with or endorsed by Proton AG')
  })

  it('leaves the unofficial mark in place', async () => {
    // The notice is a paragraph read once. The mark beside the name is what
    // actually keeps anyone from taking this for Proton's own software.
    noticeDismissed = true
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('class="unofficial"')
  })

  it('answers on the section it was dismissed from', async () => {
    const page = await send(`/activity?token=${token}`)
    const res = await send(`/dismiss-notice?token=${token}`, {
      csrf: csrfFrom(page.body, '/dismiss-notice'),
      from: 'activity',
    })
    expect(res.body).toContain('href="/activity?token=' + token + '" aria-current="page"')
  })

  it('does not carry a section that does not exist back into the page', async () => {
    // Measured on an interface where the dismissal does not stick, because
    // that is the only state in which the notice comes back and its "from"
    // field can be read. With a sticking dismissal the notice is gone and the
    // switch in #render would land on the overview regardless, which would
    // make this test agree with itself rather than check anything.
    await web.stop()
    web = build({ dismissSticks: false })
    token = new URL(await web.start()).searchParams.get('token') ?? ''

    const page = await send(`/?token=${token}`)
    const res = await send(`/dismiss-notice?token=${token}`, {
      csrf: csrfFrom(page.body, '/dismiss-notice'),
      from: '../../etc/passwd',
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('name="from" value="overview"')
    expect(res.body).not.toContain('passwd')
  })

  it('needs a csrf token like every other write', async () => {
    const res = await send(`/dismiss-notice?token=${token}`, { csrf: 'wrong', from: 'overview' })
    expect(res.status).toBe(404)
    expect(dismissals).toBe(0)
  })

  it('is shown without a button when nothing can remember the dismissal', async () => {
    // The safe direction. A missing handler must not make a legal statement
    // disappear.
    await web.stop()
    web = build({ allowDismiss: false })
    token = new URL(await web.start()).searchParams.get('token') ?? ''
    const { body } = await send(`/?token=${token}`)
    expect(body).toContain('not made by, affiliated with or endorsed by Proton AG')
    expect(body).not.toContain('class="dismiss"')
  })
})

describe('formatDuration', () => {
  it('reads the way a person would say it', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(430)).toBe('430 ms')
    expect(formatDuration(2500)).toBe('2 s')
    expect(formatDuration(90_000)).toBe('1 min 30 s')
    expect(formatDuration(3_600_000)).toBe('1 h 0 min')
    expect(formatDuration(90_000_000)).toBe('1 d 1 h')
  })

  it('does not produce a negative duration', () => {
    // Clocks can step backwards; a page saying "-3 ms" looks broken.
    expect(formatDuration(-5)).toBe('0 ms')
  })
})
