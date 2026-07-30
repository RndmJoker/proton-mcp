/**
 * Pinning the Bridge's self-signed certificate.
 *
 * The problem: the Bridge generates its own certificate and keeps it inside its
 * encrypted vault rather than on disk, so it cannot be trusted in advance. The
 * lazy answer is to switch verification off and never look again, which means
 * anything that manages to listen on the port gets the Bridge password.
 *
 * The answer here is trust on first use. On the first connection the certificate
 * is fetched and its fingerprint recorded. From then on it is pinned: Node
 * verifies against that one certificate and nothing else. A changed certificate
 * stops the server with an explanation instead of being waved through.
 *
 * Fetching needs a STARTTLS handshake of our own, because imapflow does not hand
 * the certificate out. Verified against Bridge 03.25.00: checkServerIdentity is
 * never invoked while verification is off, and the certificate is not attached
 * to the verification error either.
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect, type PeerCertificate } from 'node:tls'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { BridgeError } from './errors.js'

/** What is known about a pinned certificate. */
export interface PinnedCertificate {
  host: string
  port: number
  /** SHA-256 fingerprint, the value that is compared. */
  fingerprint256: string
  /** The certificate itself, handed to Node as the only trusted authority. */
  pem: string
  /** Subject line, for the message shown when something changes. */
  subject: string
  validTo: string
  /** When it was first recorded, so a user can tell whether it was them. */
  firstSeen: string
}

/** Where the pinned certificate is stored. Next to the credentials file. */
export function pinPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROTON_MCP_CERT_FILE) return env.PROTON_MCP_CERT_FILE
  return join(homedir(), '.config', 'proton-mcp', 'known-certificate.json')
}

/** Turns a DER certificate into the PEM form Node expects as a CA. */
export function toPem(der: Buffer): string {
  const base64 = der.toString('base64')
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

/**
 * Fetches the certificate by doing the STARTTLS dance manually.
 *
 * Deliberately minimal: it reads the greeting, sends STARTTLS, waits for the OK
 * and upgrades. It does not log in, so no credentials are involved at this
 * point.
 */
export function fetchCertificate(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<{ fingerprint256: string; pem: string; subject: string; validTo: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    let settled = false
    let stage: 'greeting' | 'starttls' = 'greeting'
    let buffer = ''

    const finish = (error?: Error, value?: Awaited<ReturnType<typeof fetchCertificate>>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else if (value) resolve(value)
    }

    const timer = setTimeout(() => {
      finish(
        new BridgeError(
          `The Bridge at ${host}:${port} did not answer within ${timeoutMs} ms while reading its certificate. ` +
            'Check that it is running and unlocked.',
        ),
      )
    }, timeoutMs)

    socket.on('error', (error) => finish(error))
    socket.setEncoding('utf8')

    socket.on('data', (chunk: string) => {
      buffer += chunk

      if (stage === 'greeting') {
        // The greeting is a single untagged line.
        if (!buffer.includes('\r\n')) return
        if (!/^\* (OK|PREAUTH)/i.test(buffer)) {
          finish(
            new BridgeError(
              `${host}:${port} did not answer like an IMAP server. Received: ${buffer.slice(0, 80).trim()}`,
            ),
          )
          return
        }
        buffer = ''
        stage = 'starttls'
        socket.write('A1 STARTTLS\r\n')
        return
      }

      if (!/^A1 /m.test(buffer)) return
      if (!/^A1 OK/im.test(buffer)) {
        finish(
          new BridgeError(
            `${host}:${port} refused STARTTLS. Received: ${buffer.slice(0, 80).trim()}. ` +
              'The Bridge normally requires STARTTLS, so this port may belong to something else.',
          ),
        )
        return
      }

      // Encoding was set for the plaintext part, and it has to go before the
      // socket is handed to the TLS layer.
      socket.setEncoding(null as unknown as BufferEncoding)

      const secure = tlsConnect(
        {
          socket,
          // The point of this connection is to look at the certificate, so it
          // cannot be validated beforehand. Nothing is sent over it.
          rejectUnauthorized: false,
        },
        () => {
          const cert: PeerCertificate = secure.getPeerCertificate()
          if (!cert || !cert.raw) {
            finish(new BridgeError(`${host}:${port} presented no certificate.`))
            return
          }
          // A certificate may carry several common names, in which case Node
          // hands over an array.
          const cn = cert.subject?.CN
          const value = {
            fingerprint256: cert.fingerprint256,
            pem: toPem(cert.raw),
            subject: Array.isArray(cn) ? cn.join(', ') : (cn ?? JSON.stringify(cert.subject ?? {})),
            validTo: cert.valid_to ?? '',
          }
          secure.destroy()
          finish(undefined, value)
        },
      )
      secure.on('error', (error) => finish(error))
    })
  })
}

/** Reads the pinned certificate. Absence means nothing has been pinned yet. */
export function loadPinned(path: string): PinnedCertificate | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PinnedCertificate
    if (!parsed.fingerprint256 || !parsed.pem) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Records a certificate as trusted. */
export function savePinned(path: string, entry: PinnedCertificate): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
}

/** The message shown when the certificate no longer matches. */
export function mismatchMessage(
  pinned: PinnedCertificate,
  actual: { fingerprint256: string; subject: string },
  path: string,
): string {
  return (
    `The certificate of the Bridge at ${pinned.host}:${pinned.port} has changed. Refusing to connect.\n\n` +
    `  expected: ${pinned.fingerprint256}\n` +
    `  received: ${actual.fingerprint256}\n\n` +
    `The expected one was recorded on ${pinned.firstSeen.slice(0, 10)}.\n\n` +
    'If you reinstalled Proton Mail Bridge or moved to a different machine, this is expected. ' +
    `Delete ${path} and the next connection will record the new certificate.\n\n` +
    'If you did not change anything, do not delete it. Something else may be listening on that port, ' +
    'and it would receive your Bridge password.'
  )
}

/** What fetching a certificate yields. */
export type FetchedCertificate = Awaited<ReturnType<typeof fetchCertificate>>

export interface EnsureOptions {
  path?: string
  onFirstUse?: (entry: PinnedCertificate) => void
  /** Replaces the fetch step. Used by tests, which have no Bridge. */
  fetch?: (host: string, port: number) => Promise<FetchedCertificate>
  /** Fixed timestamp for the record. Used by tests. */
  now?: () => Date
}

/**
 * Makes sure the certificate is known, and returns it for use as a CA.
 *
 * On first use it records what it finds, which is the only moment this is
 * open to a machine-in-the-middle. Every later connection is pinned.
 */
export async function ensurePinned(
  host: string,
  port: number,
  options: EnsureOptions = {},
): Promise<PinnedCertificate> {
  const path = options.path ?? pinPath()
  const pinned = loadPinned(path)
  const actual = await (options.fetch ?? fetchCertificate)(host, port)

  if (!pinned || pinned.host !== host || pinned.port !== port) {
    const entry: PinnedCertificate = {
      host,
      port,
      fingerprint256: actual.fingerprint256,
      pem: actual.pem,
      subject: actual.subject,
      validTo: actual.validTo,
      firstSeen: (options.now?.() ?? new Date()).toISOString(),
    }
    savePinned(path, entry)
    options.onFirstUse?.(entry)
    return entry
  }

  if (pinned.fingerprint256 !== actual.fingerprint256) {
    throw new BridgeError(mismatchMessage(pinned, actual, path))
  }

  return pinned
}
