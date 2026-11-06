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

import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Credentials, CredentialStore, StoreKind } from '../credentials/store.js'
import { STORE_DESCRIPTIONS } from '../credentials/store.js'
import { listStores, recommend, recommendationReason } from '../credentials/availability.js'
import {
  createSession,
  checkRequest,
  csrfToken,
  securityHeaders,
  hashPin,
  pinMatches,
  pinProblem,
  AttemptLimiter,
  type SessionSecrets,
  type StoredPin,
} from './security.js'
import { loginPage, rejectionPage, unlockPage } from './pages.js'
import {
  overviewSection,
  bridgeSection,
  credentialsSection,
  permissionsSection,
  activitySection,
  mailboxSection,
  type ServerSummary,
  type ToolLevelView,
  type LimitsView,
  type RecordView,
  type FilterActionsView,
} from './sections.js'
import type { Section, DisclaimerState } from './layout.js'
import type { Level, SendLimits, RecordCopy } from '../settings.js'
import { UNLOCKABLE, type Unlockable } from '../filters/sieve.js'

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
 * Which address shows which section.
 *
 * One table rather than a chain of comparisons, so that a path nobody listed
 * cannot quietly reach a renderer. Everything not in here falls through to the
 * rejection at the end of the handler.
 */
const SECTION_PATHS: Record<string, Section | undefined> = {
  '/': 'overview',
  '/mailboxes': 'mailboxes',
  '/bridge': 'bridge',
  '/credentials': 'credentials',
  '/permissions': 'permissions',
  '/activity': 'activity',
}

/**
 * Where an answer to each form lands, so a wrong PIN is reported on the page the
 * user was on. Anything not listed lands on the overview.
 */
const FORM_SECTIONS: Record<string, Section> = {
  '/settings': 'bridge',
  '/test-connection': 'bridge',
  '/sign-out': 'credentials',
  '/pin': 'permissions',
  '/permissions/levels': 'permissions',
  '/permissions/limits': 'permissions',
  '/permissions/record': 'permissions',
  '/permissions/filter-actions': 'permissions',
}

/**
 * Posts that change nothing worth a PIN. Testing the connection only reads, and
 * the notice about not being Proton's software only hides a paragraph.
 */
const WITHOUT_PIN = new Set(['/test-connection', '/dismiss-notice'])

/**
 * What `/health` answers, so a server that finds the port taken can tell a
 * running proton-mcp from some other program. Says nothing else on purpose.
 */
const HEALTH_BODY = JSON.stringify({ app: 'proton-mcp' })

/** The same names as a set, for checking a section that arrived in a form. */
const SECTIONS = new Set<string>(Object.values(SECTION_PATHS) as string[])

/**
 * The one address of the interface, shared by every running server.
 *
 * Fixed rather than random, and since 2026-11-05 also not walked upwards when
 * taken: every client session starts its own server, and the interface they
 * share has to be at the same address for all of them. The first server to
 * start serves it; the others take over when it stops.
 */
export const DEFAULT_WEB_PORT = 7345

/** How often a server that does not serve the interface tries to take it over. */
export const TAKEOVER_INTERVAL_MS = 10_000

/** Who is on the port: another proton-mcp, something else, or nobody. */
export type PortOccupant = 'proton-mcp' | 'other' | 'none'

export interface WebInterfaceOptions {
  /**
   * Left out, the interface uses DEFAULT_WEB_PORT. 0 lets the operating system
   * pick a free port, which the tests use to avoid collisions; there is no
   * takeover then, since no other server could know the address.
   */
  port?: number
  /** The PIN as stored, or nothing while none is set. Read on every request. */
  getPin?: () => StoredPin | undefined
  /** Stores a new PIN, or removes it with undefined. Returns an error to show. */
  onPinChange?: (next: StoredPin | undefined) => Promise<string | undefined>
  /** Every running server, for the overview. */
  getServers?: () => ServerSummary[]
  /** Told whenever this server starts or stops serving the interface. */
  onServingChange?: (serving: boolean) => void
  /** How often to try taking over the port. TAKEOVER_INTERVAL_MS unless a test says otherwise. */
  takeoverIntervalMs?: number
  /** What each tool may do and the bounds on sending without asking, for the permissions page. */
  getPermissions?: () => { tools: ToolLevelView[]; limits: LimitsView }
  /**
   * Stores the levels chosen on the page, only those not fixed by the
   * environment. Returns an error to show, or nothing.
   */
  onLevels?: (levels: Record<string, Level>) => Promise<string | undefined>
  /** Stores the bounds on sending without asking. Returns an error to show, or nothing. */
  onLimits?: (limits: SendLimits) => Promise<string | undefined>
  /** The recipient added to every message sent, for the pages. */
  getRecord?: () => RecordView
  /** Stores it, or removes it with undefined. Returns an error to show, or nothing. */
  onRecord?: (record: RecordCopy | undefined) => Promise<string | undefined>
  /** What a filter from an assistant may do beyond filing and flags, for the pages. */
  getFilterActions?: () => FilterActionsView
  /** Stores it. Returns an error to show, or nothing. */
  onFilterActions?: (actions: Unlockable[]) => Promise<string | undefined>
  /**
   * Called when the user signs in. Returns an error message to show, or nothing
   * on success. The master password is only set for the encrypted-file store.
   *
   * A warning is a sign-in that worked but left something to do, such as an
   * earlier password that could not be removed from another store (#53).
   */
  onSignIn: (
    credentials: Credentials,
    store: StoreKind,
    masterPassword?: string,
  ) => Promise<string | undefined | { warning: string }>
  /**
   * Called when the user signs out. Returns what could not be removed, to show
   * as an error, or nothing when every store is empty (#52).
   */
  onSignOut: () => Promise<string | undefined | void>
  /**
   * Opens an existing encrypted credentials file. Returns an error message to
   * show, or nothing on success.
   *
   * Only reached when getStatus reports locked, so an interface wired without
   * this cannot get here.
   */
  onUnlock?: (masterPassword: string) => Promise<string | undefined>
  /**
   * Throws the encrypted file away, for a forgotten master password. Returns
   * why it could not be deleted, or nothing.
   */
  onDiscardEncrypted?: () => Promise<string | undefined | void>
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
  /**
   * Whether the "not affiliated with Proton" notice was sent away already.
   *
   * Absent means it is shown without a way to dismiss it, which is the safe
   * direction: a legal statement should not vanish because a caller left a
   * handler out.
   */
  noticeDismissed?: () => boolean
  /** Remembers a dismissal. Without it the notice has no button. */
  onDismissNotice?: () => Promise<void>
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
  /**
   * Required, not optional. It used to fall back to 0, which is not a port:
   * the advanced block would prefill a value the same form then refused.
   */
  bridgeSmtpPort: number
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
  /** Who held the port when this server last found it taken. */
  #occupant: PortOccupant = 'none'
  #takeover: NodeJS.Timeout | undefined
  readonly #limiter = new AttemptLimiter()
  readonly #options: WebInterfaceOptions
  readonly #notify: (message: string) => void

  constructor(options: WebInterfaceOptions) {
    this.#options = options
    this.#notify = options.notify ?? ((m) => process.stderr.write(`proton-mcp: ${m}\n`))
  }

  /**
   * The address of the interface. The same for every running server, whichever
   * of them serves it, and nothing in it is secret.
   */
  get url(): string {
    const port = this.#port || this.#options.port || DEFAULT_WEB_PORT
    return `http://${BIND_ADDRESS}:${port}/`
  }

  get port(): number {
    return this.#port
  }

  /** True while this server serves the interface itself. */
  get running(): boolean {
    return this.#server?.listening === true
  }

  /**
   * Whether the interface can be reached at `url`, from this server or from
   * another running proton-mcp. False when something else holds the port.
   */
  get reachable(): boolean {
    return this.running || this.#occupant === 'proton-mcp'
  }

  /** Who held the port when this server last found it taken. */
  get occupant(): PortOccupant {
    return this.running ? 'none' : this.#occupant
  }

  #build(): Server {
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

  /** One attempt at the port. Resolves with the error instead of throwing. */
  async #listen(port: number): Promise<Error | undefined> {
    const attempt = this.#build()
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        attempt.once('error', onError)
        // Explicitly loopback: binding to 0.0.0.0 would put a page that stores
        // credentials onto the network.
        attempt.listen(port, BIND_ADDRESS, () => {
          attempt.removeListener('error', onError)
          resolve()
        })
      })
    } catch (error) {
      attempt.close()
      return error as Error
    }
    const address = attempt.address()
    this.#port = typeof address === 'object' && address ? address.port : 0
    this.#server = attempt
    this.#occupant = 'none'
    this.#options.onServingChange?.(true)
    return undefined
  }

  /**
   * Asks whoever holds the port whether it is a proton-mcp.
   *
   * The answer decides between "another session serves the interface, all is
   * well" and "something else sits on this port", which the user has to hear
   * about, because then nobody serves the interface at all.
   */
  static async probe(port: number, timeoutMs = 1500): Promise<PortOccupant> {
    return new Promise((resolve) => {
      const request = httpRequest(
        { host: BIND_ADDRESS, port, path: '/health', method: 'GET', timeout: timeoutMs },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size <= 256) chunks.push(chunk)
          })
          response.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { app?: unknown }
              resolve(body.app === 'proton-mcp' ? 'proton-mcp' : 'other')
            } catch {
              resolve('other')
            }
          })
        },
      )
      request.on('timeout', () => request.destroy())
      request.on('error', (error) => {
        resolve((error as { code?: string }).code === 'ECONNREFUSED' ? 'none' : 'other')
      })
      request.end()
    })
  }

  /**
   * Serves the interface, or leaves it to the server that already does.
   *
   * Never throws over a taken port. Another proton-mcp on it is the ordinary
   * case with several sessions; this server then tries every few seconds to
   * take over, so the interface survives the session that started it. Anything
   * else on the port is reported once, and taken over too if it ever leaves.
   */
  async start(): Promise<string> {
    if (this.running) return this.url

    const wanted = this.#options.port ?? DEFAULT_WEB_PORT
    const failure = await this.#listen(wanted)
    if (!failure) return this.url

    if ((failure as { code?: string }).code !== 'EADDRINUSE' || wanted === 0) {
      throw new Error(`The web interface could not start: ${failure.message}`)
    }

    this.#occupant = await WebInterface.probe(wanted)
    if (this.#occupant === 'other') {
      this.#notify(
        `port ${wanted} is held by a program that is not proton-mcp, so the web interface is not ` +
          'available. Set PROTON_MCP_WEB_PORT to a free port for every proton-mcp, or stop that ' +
          'program. This server takes the port as soon as it is free.',
      )
    }
    this.#scheduleTakeover(wanted)
    return this.url
  }

  #scheduleTakeover(port: number): void {
    if (this.#takeover) return
    this.#takeover = setInterval(() => {
      void (async () => {
        if (this.running) return
        if (await this.#listen(port)) {
          // Still taken. Find out by whom, so the status stays honest.
          this.#occupant = await WebInterface.probe(port)
          return
        }
        clearInterval(this.#takeover)
        this.#takeover = undefined
        this.#notify(`took over the web interface at ${this.url}`)
      })()
    }, this.#options.takeoverIntervalMs ?? TAKEOVER_INTERVAL_MS)
    // Waiting to take over must not keep the process alive on its own.
    this.#takeover.unref()
  }

  async stop(): Promise<void> {
    if (this.#takeover) clearInterval(this.#takeover)
    this.#takeover = undefined
    const server = this.#server
    this.#server = undefined
    if (!server) return
    this.#options.onServingChange?.(false)

    // close() alone only stops accepting new connections and then waits for the
    // existing ones. A browser keeps its connection alive, so a single open tab
    // would hold the shutdown forever and the MCP server would never exit.
    server.closeIdleConnections()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
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

    // Answered before the checks and without a log line. Browsers ask for it on
    // every page view, and each one would otherwise be recorded as a refused
    // request, which buries the refusals that mean something.
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

    if (method === 'GET') {
      if (path === '/health') {
        response.writeHead(200, { ...securityHeaders(), 'Content-Type': 'application/json' })
        response.end(HEALTH_BODY)
        return
      }
      const section = SECTION_PATHS[path]
      if (section) {
        await this.#render(section, response)
        return
      }
    }

    // The PIN, for every change. A wrong one is the user's mistake and gets a
    // page that says so, unlike the refusals above, which say nothing.
    if (writing && !WITHOUT_PIN.has(path)) {
      const refusal = await this.#checkPin(body.fields.pin)
      if (refusal) {
        await this.#render(FORM_SECTIONS[path] ?? 'overview', response, {
          error: refusal,
          ...(path === '/sign-in' && body.fields.address ? { address: body.fields.address } : {}),
        })
        return
      }
    }

    if (writing && path === '/pin') {
      await this.#handlePin(response, body.fields)
      return
    }
    if (writing && path === '/permissions/levels') {
      await this.#handleLevels(response, body.fields)
      return
    }
    if (writing && path === '/permissions/limits') {
      await this.#handleLimits(response, body.fields)
      return
    }
    if (writing && path === '/permissions/record') {
      await this.#handleRecord(response, body.fields)
      return
    }
    if (writing && path === '/permissions/filter-actions') {
      await this.#handleFilterActions(response, body.fields)
      return
    }
    if (writing && path === '/dismiss-notice') {
      await this.#handleDismissNotice(response, body.fields)
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
    if (writing && path === '/unlock') {
      await this.#handleUnlock(response, body.fields)
      return
    }
    if (writing && path === '/discard-encrypted') {
      const failure = await this.#options.onDiscardEncrypted?.()
      // Both of these end with nobody signed in, so the section asked for is
      // beside the point: #render lands on the sign-in form either way.
      await this.#render('overview', response, failure ? { error: failure } : {})
      return
    }
    if (writing && path === '/sign-out') {
      // What could not be removed is shown where the user looks next. A plain
      // sign-in form would read as a clean sign-out, which it was not (#52).
      const left = await this.#options.onSignOut()
      await this.#render('overview', response, left ? { error: left } : {})
      return
    }

    this.#reject(response)
  }

  /**
   * Renders one section, or whichever page the current state demands instead.
   *
   * The state outranks the request: stored-but-locked leads to the unlock page
   * and nothing stored to the sign-in form, whichever section was asked for.
   * That is what puts a wrong master password on the unlock page and a refused
   * Bridge login on the sign-in form without either having to say so, and it is
   * also why no section has to check whether anybody is signed in.
   */
  async #render(
    section: Section,
    response: ServerResponse,
    outcome: {
      error?: string
      notice?: string
      address?: string
      store?: StoreKind
      /** Opens the advanced block, so a rejected port is where the eye lands. */
      showAdvanced?: boolean
    } = {},
  ): Promise<void> {
    const { error, notice, address, store, showAdvanced } = outcome
    const status = await this.#options.getStatus()
    const pinRequired = this.#options.getPin?.() !== undefined
    const disclaimer = this.#disclaimerFor(section)

    if (!status.connected && status.locked) {
      const page = unlockPage({
        pinRequired,
        disclaimer,
        csrf: csrfToken(this.#secrets, '/unlock'),
        csrfDiscard: csrfToken(this.#secrets, '/discard-encrypted'),
        path: status.encryptedPath ?? 'your user directory',
        ...(error ? { error } : {}),
      })
      this.#send(response, 200, 'text/html; charset=utf-8', page)
      return
    }

    if (!status.connected) {
      const stores = await listStores()
      const page = loginPage({
        pinRequired,
        disclaimer,
        csrf: csrfToken(this.#secrets, '/sign-in'),
        stores,
        suggested: recommend(stores),
        suggestionReason: recommendationReason(stores),
        bridgeHost: status.bridgeHost,
        bridgeImapPort: status.bridgeImapPort,
        bridgeSmtpPort: status.bridgeSmtpPort,
        portsLocked: this.#options.onPorts === undefined,
        ...(store ? { chosen: store } : {}),
        ...(error ? { error } : {}),
        ...(address ? { address } : {}),
        ...(showAdvanced ? { showAdvanced } : {}),
      })
      this.#send(response, 200, 'text/html; charset=utf-8', page)
      return
    }

    const banners = {
      disclaimer,
      pinRequired,
      ...(error ? { error } : {}),
      ...(notice ? { notice } : {}),
    }
    const storeTitle = status.storeKind
      ? { storeTitle: STORE_DESCRIPTIONS[status.storeKind].title }
      : {}

    let page: string
    switch (section) {
      case 'mailboxes':
        page = await this.#renderMailboxes(banners)
        break

      case 'bridge':
        page = bridgeSection({
          csrfSettings: csrfToken(this.#secrets, '/settings'),
          csrfTest: csrfToken(this.#secrets, '/test-connection'),
          bridgeHost: status.bridgeHost,
          bridgeImapPort: status.bridgeImapPort,
          bridgeSmtpPort: status.bridgeSmtpPort,
          // No handler means the ports are not ours to change.
          portsLocked: this.#options.onPorts === undefined,
          ...(status.certificate ? { certificate: status.certificate } : {}),
          ...banners,
        })
        break

      case 'credentials':
        page = credentialsSection({
          csrfSignOut: csrfToken(this.#secrets, '/sign-out'),
          ...(status.address ? { address: status.address } : {}),
          ...(status.storeKind ? { storeKind: status.storeKind } : {}),
          ...storeTitle,
          ...banners,
        })
        break

      case 'permissions': {
        const permissions = this.#options.getPermissions?.()
        page = permissionsSection({
          csrfPin: csrfToken(this.#secrets, '/pin'),
          csrfLevels: csrfToken(this.#secrets, '/permissions/levels'),
          csrfLimits: csrfToken(this.#secrets, '/permissions/limits'),
          csrfRecord: csrfToken(this.#secrets, '/permissions/record'),
          csrfFilterActions: csrfToken(this.#secrets, '/permissions/filter-actions'),
          ...(permissions ? { tools: permissions.tools, limits: permissions.limits } : {}),
          ...(this.#options.getRecord ? { record: this.#options.getRecord() } : {}),
          ...(this.#options.getFilterActions ? { filterActions: this.#options.getFilterActions() } : {}),
          ...banners,
        })
        break
      }

      case 'activity': {
        const activity = this.#options.getActivity?.() ?? { running: [], recent: [] }
        page = activitySection({ ...activity, ...banners })
        break
      }

      default:
        page = overviewSection({
          connected: true,
          ...(this.#options.getServers ? { servers: this.#options.getServers() } : {}),
          ...((): { record?: { address: string; mode: 'cc' | 'bcc' } } => {
            const record = this.#options.getRecord?.()
            return record?.address ? { record: { address: record.address, mode: record.mode ?? 'bcc' } } : {}
          })(),
          ...(this.#options.getFilterActions ? { filterActions: this.#options.getFilterActions().allowed } : {}),
          ...(this.#options.getPermissions
            ? {
                departures: this.#options
                  .getPermissions()
                  .tools.filter((tool) => tool.departs)
                  .map((tool) => ({
                    tool: tool.tool,
                    level: { off: 'off', ask: 'ask first', act: 'act on its own' }[tool.level],
                  })),
              }
            : {}),
          ...(status.address ? { address: status.address } : {}),
          ...storeTitle,
          ...(status.mailboxCount !== undefined ? { mailboxCount: status.mailboxCount } : {}),
          ...(status.messageCount !== undefined ? { messageCount: status.messageCount } : {}),
          ...(status.unseenCount !== undefined ? { unseenCount: status.unseenCount } : {}),
          bridgeHost: status.bridgeHost,
          bridgeImapPort: status.bridgeImapPort,
          bridgeSmtpPort: status.bridgeSmtpPort,
          readOnly: status.readOnly === true,
          webPort: this.#port,
          uptimeMs: status.uptimeMs ?? 0,
          ...banners,
        })
    }

    this.#send(response, 200, 'text/html; charset=utf-8', page)
  }

  /**
   * Checks the PIN of a change. Returns why it was refused, or nothing.
   *
   * No PIN set means nothing to check: then anything on this machine can make
   * changes, which the pages say. Too many wrong attempts lock out every attempt
   * for a while, the right one included, so the lock cannot be used to tell
   * when a guess was right.
   */
  async #checkPin(presented: string | undefined): Promise<string | undefined> {
    const stored = this.#options.getPin?.()
    if (!stored) return undefined
    if (!this.#limiter.allowed()) {
      return 'Too many wrong PINs. Changes are refused for a minute, whichever PIN is entered.'
    }
    if (presented && (await pinMatches(presented, stored))) {
      this.#limiter.reset()
      return undefined
    }
    this.#limiter.fail()
    this.#notify('web interface refused a change with a wrong or missing PIN')
    return presented ? 'The PIN is not right.' : 'This change needs the PIN.'
  }

  /**
   * Takes the levels from the form.
   *
   * Only tools the page offered, only levels each one offers, and nothing the
   * environment fixed: the form is untrusted input like any other, and a value
   * it should not carry is refused rather than quietly dropped.
   */
  async #handleLevels(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    const view = this.#options.getPermissions?.()
    if (!view || !this.#options.onLevels) {
      await this.#render('permissions', response, { error: 'This server cannot store levels.' })
      return
    }
    const levels: Record<string, Level> = {}
    for (const tool of view.tools) {
      if (tool.fixed) continue
      const value = fields[`level:${tool.tool}`]
      if (value === undefined) continue
      if (!tool.options.includes(value as Level)) {
        await this.#render('permissions', response, {
          error: `"${value}" is not a level ${tool.tool} offers.`,
        })
        return
      }
      levels[tool.tool] = value as Level
    }
    const failure = await this.#options.onLevels(levels)
    await this.#render('permissions', response, failure ? { error: failure } : { notice: 'The levels are saved.' })
  }

  /** Takes the bounds on sending without asking from the form, each one checked. */
  async #handleLimits(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    if (!this.#options.onLimits) {
      await this.#render('permissions', response, { error: 'This server cannot store bounds.' })
      return
    }
    const limits: SendLimits = {}

    const allowed = (fields.allowed ?? '')
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    const malformed = allowed.find((entry) => !/^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(entry))
    if (malformed) {
      await this.#render('permissions', response, {
        error: `"${malformed}" is neither an address nor a domain written as @example.com.`,
      })
      return
    }
    if (allowed.length > 0) limits.allowed = allowed

    const max = (fields.maxPerHour ?? '').trim()
    if (max) {
      const value = Number(max)
      if (!Number.isInteger(value) || value < 1 || value > 10_000) {
        await this.#render('permissions', response, {
          error: `"${max}" is not a usable number of messages per hour.`,
        })
        return
      }
      limits.maxPerHour = value
    }

    const until = (fields.until ?? '').trim()
    if (until) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(`${until}T00:00:00Z`))) {
        await this.#render('permissions', response, { error: `"${until}" is not a day.` })
        return
      }
      limits.until = until
    }

    const failure = await this.#options.onLimits(limits)
    await this.#render('permissions', response, failure ? { error: failure } : { notice: 'The bounds are saved.' })
  }

  /**
   * Takes what filters may do from the form: only the actions the page
   * offers, each only as a ticked box, and nothing the environment fixed.
   */
  async #handleFilterActions(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    if (!this.#options.onFilterActions || !this.#options.getFilterActions) {
      await this.#render('permissions', response, { error: 'This server cannot store what filters may do.' })
      return
    }
    if (this.#options.getFilterActions().fixed) {
      await this.#render('permissions', response, {
        error: 'What filters may do is set in the environment (PROTON_MCP_FILTER_ACTIONS), so it is not changed here.',
      })
      return
    }
    const named = Object.keys(fields)
      .filter((key) => key.startsWith('action:'))
      .map((key) => key.slice('action:'.length))
    const unknown = named.find((name) => !(UNLOCKABLE as readonly string[]).includes(name))
    if (unknown !== undefined) {
      await this.#render('permissions', response, { error: `"${unknown}" is not an action a filter can be allowed.` })
      return
    }
    const odd = named.find((name) => fields[`action:${name}`] !== 'on')
    if (odd !== undefined) {
      await this.#render('permissions', response, { error: `The box for ${odd} came back with a value it does not have.` })
      return
    }
    const failure = await this.#options.onFilterActions(UNLOCKABLE.filter((action) => named.includes(action)))
    await this.#render('permissions', response, failure ? { error: failure } : { notice: 'What filters may do is saved.' })
  }

  /** Takes the copy recipient from the form. An empty address removes it. */
  async #handleRecord(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    if (!this.#options.onRecord) {
      await this.#render('permissions', response, { error: 'This server cannot store a copy recipient.' })
      return
    }
    // The page shows no form when the environment sets the copy, but a
    // request does not need the page. Storing it anyway would change nothing,
    // since the environment wins, and the notice would claim otherwise.
    if (this.#options.getRecord?.().fixed) {
      await this.#render('permissions', response, {
        error: 'The copy is set in the environment (PROTON_MCP_COPY_TO), so it is not changed here.',
      })
      return
    }
    const address = (fields.address ?? '').trim()
    if (!address) {
      const failure = await this.#options.onRecord(undefined)
      await this.#render('permissions', response,
        failure ? { error: failure } : { notice: 'No copy is added to messages any more.' })
      return
    }
    const mode = fields.mode === 'cc' ? 'cc' : 'bcc'
    if (fields.mode !== undefined && fields.mode !== 'cc' && fields.mode !== 'bcc') {
      await this.#render('permissions', response, { error: `"${fields.mode}" is neither cc nor bcc.` })
      return
    }
    const failure = await this.#options.onRecord({ address, mode })
    await this.#render('permissions', response,
      failure ? { error: failure } : { notice: `Every message sent now also goes to ${address} as ${mode === 'cc' ? 'Cc' : 'Bcc'}.` })
  }

  /**
   * Sets, changes or removes the PIN.
   *
   * Changing and removing have passed the PIN check before this runs, like
   * every other change. Setting one where none exists needs nothing, because
   * until then anything could have changed anything anyway.
   */
  async #handlePin(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    if (!this.#options.onPinChange) {
      await this.#render('permissions', response, {
        error: 'This server cannot store a PIN.',
      })
      return
    }
    const action = fields.action
    const existing = this.#options.getPin?.()

    if (action === 'remove') {
      const failure = await this.#options.onPinChange(undefined)
      await this.#render('permissions', response,
        failure
          ? { error: failure }
          : { notice: 'The PIN is removed. Anything on this machine can change these settings again.' },
      )
      return
    }

    if (action !== 'set' && action !== 'change') {
      await this.#render('permissions', response)
      return
    }
    if (action === 'set' && existing) {
      await this.#render('permissions', response, {
        error: 'A PIN is set already. Change it with the current one.',
      })
      return
    }

    const next = fields.next ?? ''
    const problem = pinProblem(next)
    if (problem) {
      await this.#render('permissions', response, { error: problem })
      return
    }
    if (next !== (fields.nextRepeat ?? '')) {
      await this.#render('permissions', response, { error: 'The two PINs do not match.' })
      return
    }

    const failure = await this.#options.onPinChange(await hashPin(next))
    this.#limiter.reset()
    await this.#render('permissions', response,
      failure
        ? { error: failure }
        : { notice: action === 'set' ? 'The PIN is set.' : 'The PIN is changed.' },
    )
  }

  /**
   * Whether the notice is shown, and whether it carries a button.
   *
   * A server wired without a way to remember the dismissal still shows the
   * notice, just without the button. Silently dropping it because a handler is
   * missing would be the one outcome nobody wants.
   */
  #disclaimerFor(section: Section): DisclaimerState {
    if (this.#options.noticeDismissed?.() === true) return 'dismissed'
    if (!this.#options.onDismissNotice) return 'plain'
    return { csrf: csrfToken(this.#secrets, '/dismiss-notice'), from: section }
  }

  /**
   * Sends the notice away for good.
   *
   * The section it was dismissed from travels in the form, so the answer is the
   * page the user was already on rather than a jump back to the overview. An
   * unknown value falls back to the overview instead of being trusted.
   */
  async #handleDismissNotice(
    response: ServerResponse,
    fields: Record<string, string>,
  ): Promise<void> {
    await this.#options.onDismissNotice?.()
    const from = SECTIONS.has(fields.from ?? '') ? (fields.from as Section) : 'overview'
    await this.#render(from, response)
  }


  /**
   * The folders and labels, only ever on this page.
   *
   * Never folded into another section: these names belong to the whole Proton
   * account and give away banks, employers and authorities on their own. The
   * caller has already established that somebody is signed in, so the only
   * question left here is whether the Bridge answers.
   */
  async #renderMailboxes(
    banners: { error?: string; notice?: string; disclaimer: DisclaimerState; pinRequired: boolean },
  ): Promise<string> {
    let mailboxes: Awaited<ReturnType<NonNullable<WebInterfaceOptions['getMailboxes']>>> = []
    let error: string | undefined = banners.error
    if (this.#options.getMailboxes) {
      try {
        mailboxes = await this.#options.getMailboxes()
      } catch (failure) {
        error = (failure as Error).message
      }
    }

    return mailboxSection({
      mailboxes,
      pinRequired: banners.pinRequired,
      disclaimer: banners.disclaimer,
      ...(error ? { error } : {}),
      ...(banners.notice ? { notice: banners.notice } : {}),
    })
  }

  /**
   * Reads a pair of ports out of a form.
   *
   * One place for it, because two forms carry them now: the bridge section and
   * the advanced block of the sign-in page. A port that is wrong has to be
   * caught before anything tries to connect with it, or the answer is
   * "connection refused" and the cause is invisible.
   */
  static #readPorts(
    fields: Record<string, string>,
  ): { ports: { imapPort: number; smtpPort: number } } | { error: string } {
    const parsed: Record<'imapPort' | 'smtpPort', number> = { imapPort: 0, smtpPort: 0 }
    for (const field of ['imapPort', 'smtpPort'] as const) {
      const raw = (fields[field] ?? '').trim()
      const value = Number(raw)
      if (!raw || !Number.isInteger(value) || value < 1 || value > 65535) {
        return {
          error:
            `"${raw}" is not a usable port for ${field === 'imapPort' ? 'IMAP' : 'SMTP'}. ` +
            'Expected a whole number between 1 and 65535.',
        }
      }
      parsed[field] = value
    }
    return { ports: parsed }
  }

  async #handlePorts(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    if (!this.#options.onPorts) {
      await this.#render('bridge', response, {
        error: 'The ports are set through the environment on this server.',
      })
      return
    }

    const read = WebInterface.#readPorts(fields)
    if ('error' in read) {
      await this.#render('bridge', response, { error: read.error })
      return
    }
    const parsed = read.ports

    const error = await this.#options.onPorts(parsed)
    await this.#render('bridge', response, {
      ...(error
        ? { error }
        : { notice: `Ports saved: IMAP ${parsed.imapPort}, SMTP ${parsed.smtpPort}.` }),
    })
  }

  async #handleTest(response: ServerResponse): Promise<void> {
    if (!this.#options.onTest) {
      await this.#render('bridge', response, { error: 'This server cannot test the connection.' })
      return
    }
    const result = await this.#options.onTest()
    await this.#render('bridge', response,
      result.ok ? { notice: result.message } : { error: result.message },
    )
  }

  async #handleUnlock(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    const master = fields.master ?? ''
    if (!master) {
      await this.#render('overview', response, { error: 'The master password is required.' })
      return
    }
    if (!this.#options.onUnlock) {
      await this.#render('overview', response, {
        error: 'This server cannot open encrypted credential files.',
      })
      return
    }
    const error = await this.#options.onUnlock(master)
    await this.#render('overview', response, { ...(error ? { error } : {}) })
  }

  /**
   * Reads the storage option out of the form.
   *
   * It arrives as a radio value now rather than being remembered from an
   * earlier post, so it is ordinary untrusted input: a name that is not one of
   * the four, or one that cannot work on this machine, falls back to the
   * recommendation rather than being passed on.
   */
  async #storeFromForm(
    fields: Record<string, string>,
  ): Promise<{ store: StoreKind; error?: string }> {
    const stores = await listStores()
    const wanted = fields.store
    if (!wanted || !(wanted in STORE_DESCRIPTIONS)) return { store: recommend(stores) }

    const kind = wanted as StoreKind
    const entry = stores.find((s) => s.kind === kind)
    if (!entry?.available) {
      return {
        store: recommend(stores),
        error: `${STORE_DESCRIPTIONS[kind].title} cannot be used on this machine. ${entry?.reason ?? ''}`,
      }
    }
    return { store: kind }
  }

  async #handleSignIn(response: ServerResponse, fields: Record<string, string>): Promise<void> {
    const address = (fields.address ?? '').trim()
    const password = fields.password ?? ''
    const { store, error: storeError } = await this.#storeFromForm(fields)

    if (storeError) {
      await this.#render('overview', response, { error: storeError, address, store })
      return
    }

    // The ports come first, before the credentials are tried. Somebody whose
    // Bridge listens elsewhere would otherwise be told their password is wrong,
    // because the attempt went to a port with nothing behind it. Only when the
    // form carries them: the block is read-only when the environment decided.
    if (this.#options.onPorts && fields.imapPort !== undefined) {
      const read = WebInterface.#readPorts(fields)
      if ('error' in read) {
        await this.#render('overview', response, {
          error: read.error,
          address,
          store,
          showAdvanced: true,
        })
        return
      }
      const failed = await this.#options.onPorts(read.ports)
      if (failed) {
        await this.#render('overview', response, {
          error: failed,
          address,
          store,
          showAdvanced: true,
        })
        return
      }
    }

    if (!address || !password) {
      await this.#render('overview', response, {
        error: 'Both the address and the Bridge password are required.',
        address,
        store,
      })
      return
    }

    // Checked here rather than in the session, because this is where the second
    // field exists to compare against. A typo in a password nothing can recover
    // has to be caught before it is used to encrypt anything.
    //
    // Read only for the store that uses it. The field is in the document for
    // every option now, hidden by CSS, so a value left behind by switching
    // options would otherwise be taken for a choice.
    let master: string | undefined
    if (store === 'encrypted-file') {
      master = fields.master ?? ''
      if (!master) {
        await this.#render('overview', response, {
          error: 'The encrypted file needs a master password to encrypt the credentials with.',
          address,
          store,
        })
        return
      }
      if (master !== (fields.masterRepeat ?? '')) {
        await this.#render('overview', response, {
          error: 'The two master passwords do not match.',
          address,
          store,
        })
        return
      }
    }

    const outcome = await this.#options.onSignIn({ user: address, pass: password }, store, master)
    // No password is kept anywhere in this class, whatever the outcome.
    if (typeof outcome === 'string' && outcome) {
      await this.#render('overview', response, { error: outcome, address, store })
      return
    }
    await this.#render('overview', response, typeof outcome === 'object' ? { error: outcome.warning } : {})
  }
}

export type { CredentialStore }
