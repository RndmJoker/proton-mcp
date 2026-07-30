import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import {
  toPem,
  loadPinned,
  savePinned,
  mismatchMessage,
  ensurePinned,
  pinPath,
  fetchCertificate,
  type PinnedCertificate,
  type FetchedCertificate,
} from '../../src/bridge/certificate.js'
import { BridgeError } from '../../src/bridge/errors.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proton-mcp-cert-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const fetched = (fingerprint: string): FetchedCertificate => ({
  fingerprint256: fingerprint,
  pem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
  subject: '127.0.0.1',
  validTo: 'Jul  9 06:19:20 2046 GMT',
})

describe('toPem', () => {
  it('wraps DER in the PEM envelope Node expects as a CA', () => {
    const pem = toPem(Buffer.from('ABC'))
    expect(pem.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true)
    expect(pem.trimEnd().endsWith('-----END CERTIFICATE-----')).toBe(true)
    expect(pem).toContain(Buffer.from('ABC').toString('base64'))
  })

  it('breaks the base64 into lines of at most 64 characters', () => {
    const pem = toPem(Buffer.alloc(500, 1))
    const body = pem.split('\n').slice(1, -2)
    expect(body.length).toBeGreaterThan(1)
    for (const line of body) expect(line.length).toBeLessThanOrEqual(64)
  })
})

describe('pinPath', () => {
  it('can be overridden, which the tests rely on', () => {
    expect(pinPath({ PROTON_MCP_CERT_FILE: '/tmp/x.json' })).toBe('/tmp/x.json')
  })

  it('otherwise sits next to the credentials file', () => {
    expect(pinPath({})).toContain('proton-mcp')
    expect(pinPath({})).toContain('known-certificate.json')
  })
})

describe('loadPinned', () => {
  it('treats a missing file as nothing pinned yet', () => {
    expect(loadPinned(join(dir, 'absent.json'))).toBeUndefined()
  })

  it('treats unreadable content as nothing pinned, rather than crashing', () => {
    const path = join(dir, 'broken.json')
    writeFileSync(path, 'this is not json')
    expect(loadPinned(path)).toBeUndefined()
  })

  it('rejects a record without a fingerprint', () => {
    // Half a record is worse than none: it would look like a pin but verify
    // nothing.
    const path = join(dir, 'partial.json')
    writeFileSync(path, JSON.stringify({ host: '127.0.0.1', port: 1143 }))
    expect(loadPinned(path)).toBeUndefined()
  })

  it('reads back what was saved', () => {
    const path = join(dir, 'good.json')
    const entry: PinnedCertificate = {
      host: '127.0.0.1',
      port: 1143,
      fingerprint256: 'AA:BB',
      pem: 'pem',
      subject: '127.0.0.1',
      validTo: 'later',
      firstSeen: '2026-07-30T00:00:00.000Z',
    }
    savePinned(path, entry)
    expect(loadPinned(path)).toEqual(entry)
  })
})

describe('savePinned', () => {
  it('writes the file so only the owner can read it', () => {
    const path = join(dir, 'perm.json')
    savePinned(path, {
      host: '127.0.0.1',
      port: 1143,
      fingerprint256: 'AA',
      pem: 'p',
      subject: 's',
      validTo: 'v',
      firstSeen: '2026-07-30T00:00:00.000Z',
    })
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('creates missing directories', () => {
    const path = join(dir, 'deep', 'deeper', 'cert.json')
    savePinned(path, {
      host: '127.0.0.1',
      port: 1143,
      fingerprint256: 'AA',
      pem: 'p',
      subject: 's',
      validTo: 'v',
      firstSeen: '2026-07-30T00:00:00.000Z',
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).fingerprint256).toBe('AA')
  })
})

describe('ensurePinned', () => {
  it('records the certificate on first use', async () => {
    const path = join(dir, 'cert.json')
    let announced: PinnedCertificate | undefined
    const entry = await ensurePinned('127.0.0.1', 1143, {
      path,
      fetch: async () => fetched('AA:BB:CC'),
      now: () => new Date('2026-07-30T10:00:00Z'),
      onFirstUse: (e) => {
        announced = e
      },
    })
    expect(entry.fingerprint256).toBe('AA:BB:CC')
    expect(entry.firstSeen).toBe('2026-07-30T10:00:00.000Z')
    // The first use is the one moment this is open to interception, so it is
    // announced rather than done silently.
    expect(announced?.fingerprint256).toBe('AA:BB:CC')
    expect(loadPinned(path)?.fingerprint256).toBe('AA:BB:CC')
  })

  it('accepts an unchanged certificate without announcing anything again', async () => {
    const path = join(dir, 'cert.json')
    const options = { path, fetch: async () => fetched('AA:BB:CC') }
    await ensurePinned('127.0.0.1', 1143, options)

    let announced = false
    await ensurePinned('127.0.0.1', 1143, { ...options, onFirstUse: () => (announced = true) })
    expect(announced).toBe(false)
  })

  it('refuses to connect when the certificate changed', async () => {
    const path = join(dir, 'cert.json')
    await ensurePinned('127.0.0.1', 1143, { path, fetch: async () => fetched('AA:BB:CC') })

    await expect(
      ensurePinned('127.0.0.1', 1143, { path, fetch: async () => fetched('99:88:77') }),
    ).rejects.toThrow(BridgeError)
  })

  it('does not overwrite the record when it refuses', async () => {
    // Otherwise a single connection to something else would replace the pin.
    const path = join(dir, 'cert.json')
    await ensurePinned('127.0.0.1', 1143, { path, fetch: async () => fetched('AA:BB:CC') })
    await ensurePinned('127.0.0.1', 1143, { path, fetch: async () => fetched('99:88:77') }).catch(
      () => undefined,
    )
    expect(loadPinned(path)?.fingerprint256).toBe('AA:BB:CC')
  })

  it('records afresh when the port changed', async () => {
    // A different port is a different endpoint, not a changed certificate.
    const path = join(dir, 'cert.json')
    await ensurePinned('127.0.0.1', 1143, { path, fetch: async () => fetched('AA:BB:CC') })
    const entry = await ensurePinned('127.0.0.1', 1144, { path, fetch: async () => fetched('99:88:77') })
    expect(entry.port).toBe(1144)
    expect(entry.fingerprint256).toBe('99:88:77')
  })
})

describe('mismatchMessage', () => {
  const pinned: PinnedCertificate = {
    host: '127.0.0.1',
    port: 1143,
    fingerprint256: 'AA:BB:CC',
    pem: 'p',
    subject: '127.0.0.1',
    validTo: 'v',
    firstSeen: '2026-07-30T10:00:00.000Z',
  }

  it('shows both fingerprints, so the user can compare', () => {
    const text = mismatchMessage(pinned, { fingerprint256: '99:88:77', subject: 'x' }, '/tmp/c.json')
    expect(text).toContain('AA:BB:CC')
    expect(text).toContain('99:88:77')
  })

  it('explains the harmless case and names the file to delete', () => {
    const text = mismatchMessage(pinned, { fingerprint256: '99', subject: 'x' }, '/tmp/c.json')
    expect(text).toContain('reinstalled')
    expect(text).toContain('/tmp/c.json')
  })

  it('warns against deleting it when nothing was changed', () => {
    // The dangerous case. Without this sentence the instruction above becomes a
    // recipe for waving an attacker through.
    const text = mismatchMessage(pinned, { fingerprint256: '99', subject: 'x' }, '/tmp/c.json')
    expect(text).toContain('do not delete it')
    expect(text).toContain('Bridge password')
  })

  it('names when the expected certificate was recorded', () => {
    const text = mismatchMessage(pinned, { fingerprint256: '99', subject: 'x' }, '/tmp/c.json')
    expect(text).toContain('2026-07-30')
  })
})

describe('fetchCertificate', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()))
      server = undefined
    }
  })

  /** Starts a fake server that speaks just enough IMAP to reach STARTTLS. */
  function fakeServer(behaviour: (data: string) => string | undefined): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((socket) => {
        socket.write('* OK Fake IMAP ready\r\n')
        socket.on('data', (chunk) => {
          const answer = behaviour(chunk.toString('utf8'))
          if (answer) socket.write(answer)
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
  }

  it('explains a refused STARTTLS instead of hanging', async () => {
    const port = await fakeServer(() => 'A1 BAD unsupported\r\n')
    await expect(fetchCertificate('127.0.0.1', port, 3000)).rejects.toThrow(/refused STARTTLS/)
  })

  it('explains a server that does not speak IMAP', async () => {
    // Something other than the Bridge listening on the configured port.
    const port = await new Promise<number>((resolve) => {
      server = createServer((socket) => socket.write('HTTP/1.1 200 OK\r\n'))
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    await expect(fetchCertificate('127.0.0.1', port, 3000)).rejects.toThrow(/not answer like an IMAP server/)
  })

  it('times out rather than waiting forever', async () => {
    // A server that greets and then goes silent.
    const port = await fakeServer(() => undefined)
    await expect(fetchCertificate('127.0.0.1', port, 300)).rejects.toThrow(/did not answer within/)
  })

  it('reports a refused connection', async () => {
    // Port 1 is not in use, and binding it would need root.
    await expect(fetchCertificate('127.0.0.1', 1, 2000)).rejects.toThrow()
  })
})
