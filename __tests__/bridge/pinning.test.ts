import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  certificateChanged,
  fetchCertificate,
  pinFor,
  savePinned,
  type FetchedCertificate,
  type PinnedCertificate,
} from '../../src/bridge/certificate.js'
import { Connection } from '../../src/bridge/connection.js'
import { BridgeError, explainError, isConnectionFailure } from '../../src/bridge/errors.js'
import { sendMessage } from '../../src/mail/send.js'
import type { Draft } from '../../src/mail/compose.js'
import { loadConfig } from '../../src/config.js'
import { fakeImap, fakeSmtp, hasOpenssl, makeCertificate, type TestCertificate } from '../helpers/tls-servers.js'
import { closedPort } from '../helpers/closed-port.js'

/**
 * Up to 0.4.11 every connection and every send began with a probe of its own,
 * and the Bridge logged each one as "Cannot upgrade connection: EOF". The probe
 * now runs on first use and after a failure. What must not change is that no
 * password reaches a server with a different certificate, or one that offers
 * no encryption at all.
 */

const fetched = (fingerprint: string): FetchedCertificate => ({
  fingerprint256: fingerprint,
  pem: 'PEM',
  subject: 'bridge',
  validTo: '',
})

const pinned = (fingerprint: string, port = 1143): PinnedCertificate => ({
  host: '127.0.0.1',
  port,
  fingerprint256: fingerprint,
  pem: 'PEM',
  subject: 'bridge',
  validTo: '',
  firstSeen: '2026-11-02T00:00:00.000Z',
})

describe('pinFor', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proton-mcp-pin-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads nothing from the Bridge once a certificate is pinned', async () => {
    const path = join(dir, 'pin.json')
    savePinned(path, pinned('AA'))
    const fetch = vi.fn(async () => fetched('AA'))
    const result = await pinFor('127.0.0.1', 1143, { path, fetch })
    expect(fetch).not.toHaveBeenCalled()
    expect(result.fingerprint256).toBe('AA')
  })

  it('reads and records the certificate on first use', async () => {
    const path = join(dir, 'pin.json')
    const fetch = vi.fn(async () => fetched('BB'))
    const result = await pinFor('127.0.0.1', 1143, { path, fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.fingerprint256).toBe('BB')
  })
})

describe('certificateChanged', () => {
  it('explains a certificate that differs from the pinned one', async () => {
    const result = await certificateChanged('127.0.0.1', 1143, pinned('AA'), {
      path: join(tmpdir(), 'pin.json'),
      fetch: async () => fetched('BB'),
    })
    expect(result).toBeInstanceOf(BridgeError)
    expect(result?.message).toMatch(/has changed/)
  })

  it('says nothing when the certificate is the pinned one', async () => {
    const result = await certificateChanged('127.0.0.1', 1143, pinned('AA'), {
      fetch: async () => fetched('AA'),
    })
    expect(result).toBeUndefined()
  })

  it('says nothing when the probe fails as well, so the first failure is reported', async () => {
    const result = await certificateChanged('127.0.0.1', 1143, pinned('AA'), {
      fetch: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    expect(result).toBeUndefined()
  })
})

describe('explaining a failure', () => {
  it('reads the system code nodemailer keeps as originalCode', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
    })
    expect(isConnectionFailure(error)).toBe(true)
    expect(explainError(error, '127.0.0.1', 1025).message).toMatch(/Nothing is accepting connections/)
  })

  it('says that no password was sent where STARTTLS was required and did not happen', () => {
    const error = Object.assign(new Error('Server does not support STARTTLS'), { tlsFailed: true })
    expect(explainError(error, '127.0.0.1', 1143).message).toMatch(/so the password was not sent/)
  })
})

describe('a Bridge that is not running, with a certificate already pinned', () => {
  // Without a probe in front of every connection, this is where a Bridge that
  // is not running shows up now: in the connection or the send itself.
  let dir: string
  let pinPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proton-mcp-down-'))
    pinPath = join(dir, 'pin.json')
    vi.stubEnv('PROTON_MCP_CERT_FILE', pinPath)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is explained when a connection is opened', async () => {
    const port = await closedPort()
    savePinned(pinPath, pinned('AA', port))
    const connection = new Connection(loadConfig({ BRIDGE_IMAP_PORT: String(port) }), credentials, () => {})
    const failure = await connection.open().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toMatch(/Nothing is accepting connections/)
  })

  it('is explained when a message is sent', async () => {
    const port = await closedPort()
    savePinned(pinPath, pinned('AA', port))
    const config = loadConfig({ BRIDGE_IMAP_PORT: String(port), BRIDGE_SMTP_PORT: String(port) })
    const failure = await sendMessage(config, credentials, false, DRAFT).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).remedy).toBe('unreachable')
    expect((failure as BridgeError).message).toMatch(/Nothing is accepting connections/)
  })
})

const DRAFT: Draft = {
  from: { address: 'me@example.com' },
  to: [{ address: 'you@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Subject',
  text: 'Body',
  messageId: '<one@example.com>',
}

const credentials = async () => ({ user: 'nobody@example.com', pass: 'placeholder' })

/** Whether a server received anything that carries the password. */
const sawLogin = (lines: string[]) => lines.some((line) => /\b(LOGIN|AUTHENTICATE)\b/i.test(line))
const sawAuth = (lines: string[]) => lines.some((line) => /^AUTH\b/i.test(line))

describe.skipIf(!hasOpenssl)('against a server with a real certificate', () => {
  let dir: string
  let bridge: TestCertificate
  let impostor: TestCertificate
  let pinPath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'proton-mcp-tls-'))
    bridge = makeCertificate(dir, 'bridge')
    impostor = makeCertificate(dir, 'impostor')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    pinPath = join(dir, `pin-${Math.random().toString(36).slice(2)}.json`)
    vi.stubEnv('PROTON_MCP_CERT_FILE', pinPath)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const pinTo = (certificate: TestCertificate, port: number) =>
    savePinned(pinPath, {
      host: '127.0.0.1',
      port,
      fingerprint256: certificate.fingerprint256,
      pem: certificate.cert,
      subject: 'bridge',
      validTo: '',
      firstSeen: '2026-11-02T00:00:00.000Z',
    })

  it('ends the probe with LOGOUT instead of breaking off the connection', async () => {
    const server = await fakeImap(bridge)
    try {
      const value = await fetchCertificate('127.0.0.1', server.port)
      expect(value.fingerprint256).toBe(bridge.fingerprint256)
      expect(server.lines).toContain('A2 LOGOUT')
    } finally {
      await server.close()
    }
  })

  it('opens a connection without a probe once the certificate is pinned', async () => {
    const server = await fakeImap(bridge)
    try {
      pinTo(bridge, server.port)
      const connection = new Connection(loadConfig({ BRIDGE_IMAP_PORT: String(server.port) }), credentials, () => {})
      await connection.open()
      await connection.close()
      expect(server.connections).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('refuses a different certificate before the password is sent', async () => {
    const server = await fakeImap(impostor)
    try {
      pinTo(bridge, server.port)
      const connection = new Connection(loadConfig({ BRIDGE_IMAP_PORT: String(server.port) }), credentials, () => {})
      const failure = await connection.open().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BridgeError)
      expect((failure as BridgeError).message).toMatch(/has changed/)
      expect(sawLogin(server.lines)).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('does not log in where STARTTLS is not offered', async () => {
    const server = await fakeImap(bridge, { starttls: false })
    try {
      pinTo(bridge, server.port)
      const connection = new Connection(loadConfig({ BRIDGE_IMAP_PORT: String(server.port) }), credentials, () => {})
      const failure = await connection.open().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BridgeError)
      expect((failure as BridgeError).message).toMatch(/so the password was not sent/)
      expect(sawLogin(server.lines)).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('sends without a probe once the certificate is pinned', async () => {
    const imap = await fakeImap(bridge)
    const smtp = await fakeSmtp(bridge)
    try {
      pinTo(bridge, imap.port)
      const config = loadConfig({ BRIDGE_IMAP_PORT: String(imap.port), BRIDGE_SMTP_PORT: String(smtp.port) })
      const outcome = await sendMessage(config, credentials, false, DRAFT)
      expect(outcome.accepted).toEqual(['you@example.com'])
      expect(imap.connections).toBe(0)
    } finally {
      await imap.close()
      await smtp.close()
    }
  })

  it('refuses to send to a different certificate before AUTH', async () => {
    const imap = await fakeImap(impostor)
    const smtp = await fakeSmtp(impostor)
    try {
      pinTo(bridge, imap.port)
      const config = loadConfig({ BRIDGE_IMAP_PORT: String(imap.port), BRIDGE_SMTP_PORT: String(smtp.port) })
      const failure = await sendMessage(config, credentials, false, DRAFT).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BridgeError)
      expect((failure as BridgeError).message).toMatch(/has changed/)
      expect(sawAuth(smtp.lines)).toBe(false)
    } finally {
      await imap.close()
      await smtp.close()
    }
  })
})
