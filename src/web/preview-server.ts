/**
 * Shows a message waiting for confirmation, from the server that holds it.
 *
 * Until 2026-11-05 this was a page of the interface. Since then every running
 * server shares one interface at a fixed address, served by whichever started
 * first, but a waiting message lives only in the memory of the server that
 * asked about it. Handing it to the server behind the interface would send
 * decrypted mail from one process to another for the sake of a page. So each
 * server shows its own, on a port the operating system picks.
 *
 * What protects the page: it listens on loopback only, refuses any Host header
 * that is not this machine, and finds a message only by the digest of its
 * recipients, subject and body, which nobody can produce without knowing all
 * three already. It serves nothing else, has no form and no button, and keeps
 * the interface's content security policy, which also governs the sandboxed
 * frame the message is drawn in.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAllowedHost, securityHeaders } from './security.js'
import { pendingPage, noPendingPage, type PendingData } from './pending.js'
import { rejectionPage } from './pages.js'

const BIND_ADDRESS = '127.0.0.1'

/** A digest as `digestOf` writes it: SHA-256 in hexadecimal. */
const DIGEST = /^[0-9a-f]{64}$/

export interface PreviewServerOptions {
  /** The message behind a digest, or nothing when none is waiting. */
  getPending: (digest: string) => Omit<PendingData, 'disclaimer'> | undefined
  /** Where notices go. stderr, never stdout, which carries the MCP protocol. */
  notify?: (message: string) => void
}

export class PreviewServer {
  #server: Server | undefined
  #port = 0
  readonly #options: PreviewServerOptions

  constructor(options: PreviewServerOptions) {
    this.#options = options
  }

  get running(): boolean {
    return this.#server?.listening === true
  }

  /** The address of one waiting message, or nothing while not running. */
  urlFor(digest: string): string | undefined {
    if (!this.running || !DIGEST.test(digest)) return undefined
    return `http://${BIND_ADDRESS}:${this.#port}/pending/${digest}`
  }

  async start(): Promise<void> {
    if (this.running) return
    const server = createServer((request, response) => {
      try {
        this.#handle(request, response)
      } catch {
        this.#send(response, 500, 'Internal error.', 'text/plain; charset=utf-8')
      }
    })
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // Port 0: the operating system picks a free one. Nobody types this
      // address; it travels in the confirmation.
      server.listen(0, BIND_ADDRESS, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    this.#port = typeof address === 'object' && address ? address.port : 0
    this.#server = server
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (!server) return
    server.closeIdleConnections()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  #send(response: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
    response.writeHead(status, { ...securityHeaders(), 'Content-Type': type })
    response.end(body)
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      this.#send(response, 405, rejectionPage())
      return
    }
    if (!isAllowedHost(request.headers.host)) {
      this.#options.notify?.('preview refused a request for a foreign host')
      this.#send(response, 404, rejectionPage())
      return
    }

    const path = new URL(request.url ?? '/', `http://${BIND_ADDRESS}`).pathname
    const digest = path.startsWith('/pending/') ? path.slice('/pending/'.length) : undefined
    if (!digest || !DIGEST.test(digest)) {
      this.#send(response, 404, rejectionPage())
      return
    }

    // A digest nobody is holding gives the empty page rather than a refusal,
    // because the ordinary reason to land here is having answered already.
    const waiting = this.#options.getPending(digest)
    this.#send(
      response,
      200,
      waiting ? pendingPage({ ...waiting, disclaimer: 'plain' }) : noPendingPage('plain'),
    )
  }
}
