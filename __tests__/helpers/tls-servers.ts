/**
 * Stand-ins for the Bridge's two ports that speak real TLS.
 *
 * Pinning can only be tested against a server that presents a certificate, and
 * the point of the tests is which commands reach it: a LOGIN or an AUTH sent
 * to a server with the wrong certificate is the failure that matters. So both
 * servers record every line they receive.
 *
 * The certificates are made at run time with openssl, so that no private key is
 * ever committed. The CI image carries openssl; where it is missing, the tests
 * that need it say so and are skipped.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { TLSSocket } from 'node:tls'

/** Whether openssl is there to make throwaway certificates with. */
export const hasOpenssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

export interface TestCertificate {
  key: string
  cert: string
  /** In the form Node reports it, colon separated upper case hex. */
  fingerprint256: string
}

/** A throwaway self-signed certificate, written into `dir`. */
export function makeCertificate(dir: string, name: string): TestCertificate {
  const keyPath = join(dir, `${name}.key`)
  const certPath = join(dir, `${name}.crt`)
  const made = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-subj', `/CN=${name}`, '-days', '1', '-keyout', keyPath, '-out', certPath,
    ],
    { stdio: 'pipe' },
  )
  if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr.toString()}`)
  const cert = readFileSync(certPath, 'utf8')
  return { key: readFileSync(keyPath, 'utf8'), cert, fingerprint256: new X509Certificate(cert).fingerprint256 }
}

export interface FakeServer {
  port: number
  /** How many connections were opened. */
  connections: number
  /** Every line received, in order, across all connections. */
  lines: string[]
  close(): Promise<void>
}

/** Reads CRLF-terminated lines from a socket. */
function onLines(socket: Socket | TLSSocket, handle: (line: string) => void): () => void {
  let buffer = ''
  const listener = (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let end: number
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      handle(line)
    }
  }
  socket.on('data', listener)
  return () => socket.off('data', listener)
}

async function listen(
  serve: (socket: Socket, state: FakeServer) => void,
): Promise<FakeServer> {
  const sockets = new Set<Socket>()
  let server: Server | undefined
  const state: FakeServer = {
    port: 0,
    connections: 0,
    lines: [],
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server?.close(() => resolve())
      }),
  }
  server = createServer((socket) => {
    state.connections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    serve(socket, state)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  state.port = typeof address === 'object' && address ? address.port : 0
  return state
}

/** Wraps a plain socket as the server side of a TLS session. */
function upgrade(socket: Socket, certificate: TestCertificate): TLSSocket {
  const secure = new TLSSocket(socket, { isServer: true, key: certificate.key, cert: certificate.cert })
  // A client that refuses the certificate breaks off the handshake, which is
  // the expected outcome of some tests and nothing to report.
  secure.on('error', () => {})
  return secure
}

/**
 * An IMAP server that offers STARTTLS with the given certificate, or does not
 * offer it at all, and answers every other command with OK.
 */
export function fakeImap(certificate: TestCertificate, options: { starttls?: boolean } = {}): Promise<FakeServer> {
  const starttls = options.starttls ?? true
  return listen((plain, state) => {
    const capabilities = (secure: boolean) =>
      ['IMAP4rev1', ...(starttls && !secure ? ['STARTTLS'] : [])].join(' ')

    const answer = (socket: Socket | TLSSocket, secure: boolean) => (line: string) => {
      state.lines.push(line)
      const [tag = '*', command = ''] = line.split(' ')
      switch (command.toUpperCase()) {
        case 'CAPABILITY':
          socket.write(`* CAPABILITY ${capabilities(secure)}\r\n${tag} OK done\r\n`)
          return
        case 'STARTTLS':
          if (!starttls || secure) {
            socket.write(`${tag} BAD not here\r\n`)
            return
          }
          stopPlain()
          socket.write(`${tag} OK begin TLS\r\n`)
          {
            const tls = upgrade(plain, certificate)
            onLines(tls, answer(tls, true))
          }
          return
        case 'LOGOUT':
          socket.write(`* BYE bye\r\n${tag} OK done\r\n`)
          socket.end()
          return
        default:
          socket.write(`${tag} OK done\r\n`)
      }
    }

    const stopPlain = onLines(plain, answer(plain, false))
    plain.write(`* OK [CAPABILITY ${capabilities(false)}] fake ready\r\n`)
  })
}

/**
 * An SMTP server that offers STARTTLS with the given certificate and accepts a
 * whole transaction.
 */
export function fakeSmtp(certificate: TestCertificate): Promise<FakeServer> {
  return listen((plain, state) => {
    let inData = false

    const answer = (socket: Socket | TLSSocket, secure: boolean) => (line: string) => {
      state.lines.push(line)
      if (inData) {
        if (line === '.') {
          inData = false
          socket.write('250 2.0.0 OK queued\r\n')
        }
        return
      }
      const verb = (line.split(' ')[0] ?? '').toUpperCase()
      switch (verb) {
        case 'EHLO':
          socket.write(
            secure
              ? '250-fake\r\n250 AUTH PLAIN LOGIN\r\n'
              : '250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n',
          )
          return
        case 'STARTTLS':
          stopPlain()
          socket.write('220 2.0.0 ready\r\n')
          {
            const tls = upgrade(plain, certificate)
            onLines(tls, answer(tls, true))
          }
          return
        case 'AUTH':
          socket.write('235 2.7.0 accepted\r\n')
          return
        case 'DATA':
          inData = true
          socket.write('354 go ahead\r\n')
          return
        case 'QUIT':
          socket.write('221 bye\r\n')
          socket.end()
          return
        default:
          socket.write('250 OK\r\n')
      }
    }

    const stopPlain = onLines(plain, answer(plain, false))
    plain.write('220 fake ESMTP\r\n')
  })
}
