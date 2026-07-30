/**
 * The local web interface.
 *
 * Built on node:http with no framework. For something that handles credentials,
 * every dependency is attack surface, and the routing here fits on one screen.
 *
 * It serves no files from disk at all: every response is generated. That removes
 * path traversal as a category rather than guarding against it.
 *
 * All security checks live in security.ts and run before any handler. See there
 * for what each one defends against.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Credentials, CredentialStore, StoreKind } from '../credentials/store.js'
import { STORE_DESCRIPTIONS } from '../credentials/store.js'
import { listStores, recommend, recommendationReason } from '../credentials/availability.js'
import { createSession, checkRequest, csrfToken, securityHeaders, type SessionSecrets } from './security.js'
import { loginPage, statusPage, rejectionPage, unlockPage, mailboxPage } from './pages.js'

/**
 * Upper bound for a request body.
 *
 * The forms here carry an address, a password and a token. Anything larger is
 * either a mistake or an attempt to make the process allocate memory.
 */
const MAX_BODY_BYTES = 8 * 1024

/** Only loopback. There is no option to change this, by design. */
const BIND_ADDRESS = '127.0.0.1'

/**
 * The port tried first.
 *
 * A fixed default rather than a random one, because the interface runs for as
 * long as the server does and is meant to be opened again and again. A port that
 * moved on every start would make that needlessly awkward.
 */
export const DEFAULT_WEB_PORT = 7345

/**
 * How many consecutive ports to try.
 *
 * Several clients may each start their own server, and the second one must not
 * fail over a port the first one took. Failing outright would be worse than
 * moving up by one.
 */
export const PORT_ATTEMPTS = 10

export interface WebInterfaceOptions {
  /** 0 lets the operating system pick a free port, which is the default. */
  port?: number
  /**
   * Called when the user signs in. Returns an error message to show, or nothing
   * on success. The master password is only set for the encrypted-file store.
   */
  onSignIn: (
    credentials: Credentials,
    store: StoreKind,
    masterPassword?: string,
  ) => Promise<string | undefined>
  /** Called when the user signs out. */
  onSignOut: () => Promise<void>
  /**
   * Opens an existing encrypted credentials file. Returns an error message to
   * show, or nothing on success.
   *
   * Only reached when getStatus reports locked, so an interface wired without
   * this cannot get here.
   */
  onUnlock?: (masterPassword: string) => Promise<string | undefined>
  /** Throws the encrypted file away, for a forgotten master password. */
  onDiscardEncrypted?: () => Promise<void>
  /** Supplies what the status page shows. */
  getStatus: () => Promise<StatusSnapshot>
  /**
   * Changes the Bridge ports. Returns an error message to show, or nothing.
   *
   * Absent when the ports came from the environment, which is what makes the
   * form disappear rather than fail.
   */
  onPorts?: (ports: { imapPort: number; smtpPort: number }) => Promise<string | undefined>
  /** Tries the Bridge. Returns a message either way: this one reports success. */
  onTest?: () => Promise<{ ok: boolean; message: string }>
  /** Lists the mailboxes, for the page that shows them on request. */
  getMailboxes?: () => Promise<
    Array<{ path: string; kind: 'system' | 'folder' | 'label'; selectable: boolean }>
  >
  /** What is running and what ran, for the activity section. */
  getActivity?: () => {
    running: Array<{ tool: string; forMs: number }>
    recent: Array<{ tool: string; at: number; durationMs: number; outcome: 'ok' | 'failed' }>
  }
  /** Where notices go. stderr, never stdout, which carries the MCP protocol. */
  notify?: (message: string) => void
}

/** Everything the status page needs, gathered by the caller. */
export interface StatusSnapshot {
  connected: boolean
  /**
   * True when credentials are stored but need a master password first. Leads
   * to the unlock page instead of the full sign-in form.
   */
  locked?: boolean
  /** Where the encrypted file is, shown on the unlock page. */
  encryptedPath?: string
  address?: string
  storeKind?: StoreKind
  mailboxCount?: number
  messageCount?: number
  unseenCount?: number
  certificate?: { fingerprint: string; subject: string; firstSeen: string }
  bridgeHost: string
  bridgeImapPort: number
  bridgeSmtpPort?: number
  readOnly?: boolean
  uptimeMs?: number
}

interface ParsedBody {
  fields: Record<string, string>
  tooLarge: boolean
}

/**
 * Reads a form body, refusing anything oversized.
 *
 * The limit is enforced while reading rather than after, so an oversized body is
 * never held in memory in full.
 */
export function readBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<ParsedBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    request.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > maxBytes) {
        aborted = true
        chunks.length = 0
        // Deliberately not destroy(): that resets the connection and the client
        // sees ECONNRESET instead of an explanation. The rest of the body is
        // drained and discarded so the handler can still answer with 413.
        request.resume()
        resolve({ fields: {}, tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (aborted) return
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const fields: Record<string, string> = {}
      for (const [key, value] of params) fields[key] = value
      resolve({ fields, tooLarge: false })
    })
    request.on('error', () => {
      if (!aborted) resolve({ fields: {}, tooLarge: false })
    })
  })
}

export class WebInterface {
  #server: Server | undefined
  #secrets: SessionSecrets = createSession()
  #port = 0
  readonly #options: WebInterfaceOptions
  readonly #notify: (message: string) => void

  constructor(options: WebInterfaceOptions) {
    this.#options = options
    this.#notify = options.notify ?? ((m) => process.stderr.write(`proton-mcp: ${m}\n`))
  }

  /** The URL the user has to open, including the access token. */
  get url(): string {
    return `http://${BIND_ADDRESS}:${this.#port}/?token=${this.#secrets.accessToken}`
  }

  get port(): number {
    return this.#port
  }

  get running(): boolean {
    return this.#server?.listening === true
  }

  async start(): Promise<string> {
    if (this.#server?.listening) return this.url

    const build = (): Server => {
      const created = createServer((request, response) => {
        void this.#handle(request, response).catch(() => {
          // A handler that throws must not take the process down, and must not
          // leak anything either.
          this.#send(response, 500, 'text/plain; charset=utf-8', 'Internal error.')
        })
      })
      // Slow clients must not be able to tie up the server indefinitely.
      created.headersTimeout = 10_000
      created.requestTimeout = 30_000
      return created
    }

    const wanted = this.#options.port ?? DEFAULT_WEB_PORT
    // Port 0 means "any free port" and needs no retry loop.
    const attempts = wanted === 0 ? 1 : PORT_ATTEMPTS
    let server: Server | undefined
    let lastError: Error | undefined

    for (let i = 0; i < attempts; i++) {
      const candidate = wanted === 0 ? 0 : wanted + i
      // A fresh instance per attempt: after a failed listen() the old one is not
      // reliably reusable.
      const attempt = build()
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error)
          attempt.once('error', onError)
          // Explicitly loopback: binding to 0.0.0.0 would put a page that stores
          // credentials onto the network.
          attempt.listen(candidate, BIND_ADDRESS, () => {
            attempt.removeListener('error', onError)
            resolve()
          })
        })
        server = attempt
        lastError = undefined
        break
      } catch (error) {
        attempt.close()
        lastError = error as Error
        if ((error as { code?: string }).code !== 'EADDRINUSE') break
        // Taken, most likely by another instance of this server. Try the next.
      }
    }

    if (!server || lastError) {
      const code = (lastError as { code?: string } | undefined)?.code
      throw new Error(
        code === 'EADDRINUSE'
          ? `Ports ${wanted} to ${wanted + attempts - 1} are all in use, so the web interface ` +
            'could not start. Set PROTON_MCP_WEB_PORT to a free port.'
          : `The web interface could not start: ${lastError?.message ?? 'unknown reason'}`,
      )
    }

    const address = server.address()
    this.#port = typeof address === 'object' && address ? address.port : 0
    this.#server = server
    return this.url
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (!server) return

    // close() alone only stops accepting new connections and then waits for the
    // existing ones. A browser keeps its connection alive, so a single open tab
    // would hold the shutdown forever and the MCP server would never exit.
    server.closeIdleConnections()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Invalidates the current link and issues a new one. */
  rotateToken(): string {
    this.#secrets = createSession()
    return this.url
  }

  #send(response: ServerResponse, status: number, contentType: string, body: string): void {
    response.writeHead(status, { ...securityHeaders(), 'Content-Type': contentType })
    response.end(body)
  }

  #reject(response: ServerResponse, status = 404): void {
    // Always the same page and the same status, whatever the reason. Telling a
    // caller which check failed would help them work around it.
    this.#send(response, status, 'text/html; charset=utf-8', rejectionPage())
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${BIND_ADDRESS}:${this.#port}`)
    const path = url.pathname
    const method = request.method ?? 'GET'
    const writing = method === 'POST'

    if (method !== 'GET' && method !== 'POST') {
      this.#reject(response, 405)
      return
    }

    // Answered before the token check and without a log line. Browsers ask for
    // it on every page view, and each one would otherwise be recorded as a
    // refused request, which buries the refusals that mean something.
    if (path === '/favicon.ico') {
      response.writeHead(404, { ...securityHeaders(), 'Content-Length': '0' })
      response.end()
      return
    }

    // The body has to be read before the checks for a POST, because the CSRF
    // token is in it. It is bounded, so this cannot be used to make us allocate.
    const body = writing ? await readBody(request) : { fields: {}, tooLarge: false }
    if (body.tooLarge) {
      // Close the connection after answering: the client may still be sending,
      // and keeping the socket alive would mean reading the rest for nothing.
      response.setHeader('Connection', 'close')
      this.#reject(response, 413)
      return
    }

    const purpose = path
    const check = checkRequest({
      request,
      secrets: this.#secrets,
      port: this.#port,
      presentedToken: url.searchParams.get('token') ?? undefined,
      writing,
      ...(writing ? { csrf: { purpose, presented: body.fields.csrf } } : {}),
    })

    if (!check.ok) {
      // Worth a line on stderr: a rejected request on a loopback-only interface
      // is either a mistake or something worth knowing about.
      this.#notify(`web interface refused a ${method} to ${path} (${check.reason})`)
      this.#reject(response)
      return
    }

    if (method === 'GET' && path === '/') {
      await this.#renderEntry(response)
      return
    }
    if (method === 'GET' && path === '/mailboxes') {
      await this.#renderMailboxes(response)
      return
    }
    if (writing && path === '/settings') {
      await this.#handlePorts(response, body.fields)
      return
    }
    if (writing && path === '/test-connection') {
      await this.#handleTest(response)
      return
    }
    if (writing && path === '/sign-in') {
      await this.#handleSignIn(response, body.fields)
      return
    }
    if (writing && path === '/choose-store') {
      await this.#handleChooseStore(response, body.fields)
      return
    }
    if (writing && path === '/unlock') {
      await this.#handleUnlock(response, body.fields)
      return
    }
    if (writing && path === '/discard-encrypted') {
      await this.#options.onDiscardEncrypted?.()
      await this.#renderEntry(response)
      return
    }
    if (writing && path === '/sign-out') {
      await this.#options.onSignOut()
      await this.#renderEntry(response)
      return
    }

    this.#reject(response)
  }

  /**
   * Shows whichever of the three pages fits the current state.
   *
   * The state decides, not the caller: signed in leads to the status page,
   * stored-but-locked to the unlock page, and nothing stored to the sign-in
   * form. An error message follows along to whichever page that turns out to
   * be, which is what puts a wrong master password on the unlock page and a
   * refused Bridge login on the sign-in form without either having to say so.
   */
  async #renderEntry(
    response: ServerResponse,
    error?: string,
    address?: string,
    notice?: string,
  ): Promise<void> {
    const status = await this.#options.getStatus()

    if (!status.connected && status.locked) {
      const page = unlockPage({
        token: this.#secrets.accessToken,
        csrf: csrfToken(this.#secrets, '/unlock'),
        csrfDiscard: csrfToken(this.#secrets, '/discard-encrypted'),
        path: status.encryptedPath ?? 'your user directory',
        ...(error ? { error } : {}),
      })
      this.#send(response, 200, 'text/html; charset=utf-8', page)
      return
    }

    if (status.connected) {
      const activity = this.#options.getActivity?.() ?? { running: [], recent: [] }
      const page = statusPage({
        token: this.#secrets.accessToken,
        csrfSignOut: csrfToken(this.#secrets, '/sign-out'),
        csrfSettings: csrfToken(this.#secrets, '/settings'),
        csrfTest: csrfToken(this.#secrets, '/test-connection'),
        connected: true,
        ...(status.address ? { address: status.address } : {}),
        ...(status.storeKind
          ? { storeKind: status.storeKind, storeTitle: STORE_DESCRIPTIONS[status.storeKind].title }
          : {}),
        ...(status.mailboxCount !== undefined ? { mailboxCount: status.mailboxCount } : {}),
        ...(status.messageCount !== undefined ? { messageCount: status.messageCount } : {}),
        ...(status.unseenCount !== undefined ? { unseenCount: status.unseenCount } : {}),
        ...(status.certificate ? { certificate: status.certificate } : {}),
        bridgeHost: status.bridgeHost,
        bridgeImapPort: status.bridgeImapPort,
        bridgeSmtpPort: status.bridgeSmtpPort ?? 0,
        // No handler means the ports are not ours to change.
        portsLocked: this.#options.onPorts === undefined,
        readOnly: status.readOnly === true,
        webPort: this.#port,
        uptimeMs: status.uptimeMs ?? 0,
        running: activity.running,
        recent: activity.recent,
        ...(error ? { error } : {}),
        ...(notice ? { notice } : {}),
      })
      this.#send(response, 200, 'text/html; charset=utf-8', page)
      return
    }

    const stores = await listStores()
    const page = loginPage({
      token: this.#secrets.accessToken,
      csrf: csrfToken(this.#secrets, '/sign-in'),
      csrfChooseStore: csrfToken(this.#secrets, '/choose-store'),
      stores,
      suggested: recommend(stores),
      suggestionReason: recommendationReason(stores),
      ...(this.#chosenStore ? { chosen: this.#chosenStore } : {}),
      ...(error ? { error } : {}),
      ...(address ? { address } : {}),
    })
    this.#send(response, 200, 'text/html; charset=utf-8', page)
  }

  #chosenStore: StoreKind | undefined

  async #handleChooseStore(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    const kind = fields.kind as StoreKind | undefined
    if (!kind || !(kind in STORE_DESCRIPTIONS)) {
      await this.#renderEntry(response, 'That storage option does not exist.')
      return
    }
    const stores = await listStores()
    const chosen = stores.find((s) => s.kind === kind)
    if (!chosen?.available) {
      await this.#renderEntry(
        response,
        `${STORE_DESCRIPTIONS[kind].title} cannot be used on this machine. ${chosen?.reason ?? ''}`,
      )
      return
    }
    this.#chosenStore = kind
    await this.#renderEntry(response)
  }

  /**
   * The folders and labels, only ever on this page.
   *
   * Never folded into the status page: these names belong to the whole Proton
   * account and give away banks, employers and authorities on their own.
   */
  async #renderMailboxes(response: ServerResponse): Promise<void> {
    const status = await this.#options.getStatus()
    if (!status.connected || !this.#options.getMailboxes) {
      // Nothing to show, and no reason to hint at what would be there.
      await this.#renderEntry(response)
      return
    }

    let mailboxes: Awaited<ReturnType<NonNullable<WebInterfaceOptions['getMailboxes']>>> = []
    let error: string | undefined
    try {
      mailboxes = await this.#options.getMailboxes()
    } catch (failure) {
      error = (failure as Error).message
    }

    const page = mailboxPage({
      token: this.#secrets.accessToken,
      mailboxes,
      ...(error ? { error } : {}),
    })
    this.#send(response, 200, 'text/html; charset=utf-8', page)
  }

  async #handlePorts(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    if (!this.#options.onPorts) {
      await this.#renderEntry(response, 'The ports are set through the environment on this server.')
      return
    }

    const parsed: Record<'imapPort' | 'smtpPort', number> = { imapPort: 0, smtpPort: 0 }
    for (const field of ['imapPort', 'smtpPort'] as const) {
      const raw = (fields[field] ?? '').trim()
      const value = Number(raw)
      if (!raw || !Number.isInteger(value) || value < 1 || value > 65535) {
        await this.#renderEntry(
          response,
          `"${raw}" is not a usable port for ${field === 'imapPort' ? 'IMAP' : 'SMTP'}. ` +
            'Expected a whole number between 1 and 65535.',
        )
        return
      }
      parsed[field] = value
    }

    const error = await this.#options.onPorts(parsed)
    await this.#renderEntry(
      response,
      error,
      undefined,
      error ? undefined : `Ports saved: IMAP ${parsed.imapPort}, SMTP ${parsed.smtpPort}.`,
    )
  }

  async #handleTest(response: ServerResponse): Promise<void> {
    if (!this.#options.onTest) {
      await this.#renderEntry(response, 'This server cannot test the connection.')
      return
    }
    const result = await this.#options.onTest()
    await this.#renderEntry(
      response,
      result.ok ? undefined : result.message,
      undefined,
      result.ok ? result.message : undefined,
    )
  }

  async #handleUnlock(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    const master = fields.master ?? ''
    if (!master) {
      await this.#renderEntry(response, 'The master password is required.')
      return
    }
    if (!this.#options.onUnlock) {
      await this.#renderEntry(response, 'This server cannot open encrypted credential files.')
      return
    }
    const error = await this.#options.onUnlock(master)
    await this.#renderEntry(response, error)
  }

  async #handleSignIn(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    const address = (fields.address ?? '').trim()
    const password = fields.password ?? ''

    if (!address || !password) {
      await this.#renderEntry(response, 'Both the address and the Bridge password are required.', address)
      return
    }

    const stores = await listStores()
    const store = this.#chosenStore ?? recommend(stores)

    // Checked here rather than in the session, because this is where the second
    // field exists to compare against. A typo in a password nothing can recover
    // has to be caught before it is used to encrypt anything.
    let master: string | undefined
    if (store === 'encrypted-file') {
      master = fields.master ?? ''
      if (!master) {
        await this.#renderEntry(
          response,
          'The encrypted file needs a master password to encrypt the credentials with.',
          address,
        )
        return
      }
      if (master !== (fields.masterRepeat ?? '')) {
        await this.#renderEntry(response, 'The two master passwords do not match.', address)
        return
      }
    }

    const error = await this.#options.onSignIn({ user: address, pass: password }, store, master)
    // No password is kept anywhere in this class, whatever the outcome.
    await this.#renderEntry(response, error, error ? address : undefined)
  }
}

export type { CredentialStore }
