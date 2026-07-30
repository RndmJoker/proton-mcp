/**
 * Connection to the Bridge's IMAP interface.
 *
 * One connection is held for the whole process rather than opened per call:
 * the Bridge dislikes connection churn and the handshake costs time. If the
 * Bridge was restarted or the socket died in between, the next call rebuilds
 * it transparently.
 */

import { ImapFlow, type ListResponse, type MailboxLockObject } from 'imapflow'
import type { Config, BridgeCredentials } from '../config.js'
import { explainError, BridgeError } from './errors.js'
import { ensurePinned } from './certificate.js'

/** Thrown when a tool is used before anyone has signed in. */
export class NotSignedInError extends BridgeError {
  override name = 'NotSignedInError'
}

/** A mailbox as reported by the Bridge. */
export interface Mailbox {
  /** The full IMAP path, for example "Folders/Receipts/Invoices". */
  path: string
  /** The last path segment, for example "Invoices". */
  name: string
  /** Which kind of mailbox this is. Proton treats folders and labels as different things. */
  kind: 'system' | 'folder' | 'label'
  /** For system mailboxes, the IMAP special-use attribute, for example "\\Inbox". */
  specialUse?: string
  /** Whether the mailbox can hold messages. The "Folders" and "Labels" containers cannot. */
  selectable: boolean
}

/** Counters for a mailbox, cheap to obtain. */
export interface MailboxStatus {
  path: string
  messages: number
  unseen: number
  /** Changes when the Bridge renumbers UIDs, which invalidates every cached UID. */
  uidValidity: string
  uidNext: number
}

/**
 * Maps an IMAP path onto what it means in Proton.
 *
 * Proton exposes user folders below "Folders/" and labels below "Labels/".
 * Everything else is a system mailbox.
 */
export function determineKind(path: string): Mailbox['kind'] {
  if (path === 'Folders' || path.startsWith('Folders/')) return 'folder'
  if (path === 'Labels' || path.startsWith('Labels/')) return 'label'
  return 'system'
}

/** Whether an address keeps traffic on this machine. */
export function isLocal(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * Decides whether a failure is worth one retry on a fresh connection.
 *
 * Only transport-level problems qualify. A rejected login or a missing
 * mailbox would fail again on a new connection, and retrying would only
 * double the waiting time before the user sees the real reason.
 */
export function isTransportFailure(error: unknown): boolean {
  const e = error as { code?: string; message?: string }
  const code = e?.code ?? ''
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_STREAM_DESTROYED'].includes(code)) {
    return true
  }
  return /socket|connection closed|not connected|disconnected/i.test(e?.message ?? '')
}

export class Connection {
  #client: ImapFlow | undefined
  /** Guards against several callers opening a connection at the same time. */
  #opening: Promise<ImapFlow> | undefined

  constructor(
    private readonly config: Config,
    /**
     * Supplies the credentials, or nothing when no one has signed in.
     *
     * A function rather than a value: they can arrive through the web interface
     * long after the server started, and they can be revoked while it runs.
     */
    private readonly getCredentials: () => Promise<BridgeCredentials | undefined>,
    /** Where notices go. stderr, never stdout, which carries the protocol. */
    private readonly notify: (message: string) => void = (m) =>
      process.stderr.write(`proton-mcp: ${m}\n`),
  ) {}

  /** Opens the connection unless a usable one is already there. */
  async open(): Promise<ImapFlow> {
    if (this.#client?.usable) return this.#client
    // A second caller waits for the first attempt instead of starting its own.
    if (this.#opening) return this.#opening

    this.#opening = this.#connect().finally(() => {
      this.#opening = undefined
    })
    return this.#opening
  }

  async #connect(): Promise<ImapFlow> {
    const credentials = await this.getCredentials()
    if (!credentials) {
      throw new NotSignedInError(
        'No Bridge credentials are available yet, so there is nothing to connect with.',
      )
    }

    // The Bridge only ever listens on the loopback interface. A different host
    // means either a tunnel or a misconfiguration, and in the second case the
    // Bridge password would go somewhere it does not belong.
    if (!isLocal(this.config.host)) {
      this.notify(
        `BRIDGE_HOST is "${this.config.host}", which is not this machine. ` +
          'Proton Mail Bridge only listens on 127.0.0.1, so this only makes sense if you ' +
          'deliberately put a tunnel in front of it. Otherwise correct BRIDGE_HOST.',
      )
    }

    // Pin the certificate before handing over any credentials. On first use this
    // records what it finds, afterwards it verifies. A changed certificate stops
    // us here rather than after the password has gone out.
    const pinned = await ensurePinned(this.config.host, this.config.imapPort, {
      onFirstUse: (entry) =>
        this.notify(
          `recorded the Bridge certificate on first use, fingerprint ${entry.fingerprint256}. ` +
            'Further connections are verified against it.',
        ),
    })

    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.imapPort,
      // The Bridge expects a plaintext connection upgraded via STARTTLS,
      // not a direct TLS handshake.
      secure: false,
      auth: { user: credentials.user, pass: credentials.pass },
      tls: {
        // Verified against exactly one certificate: the pinned one. This is
        // stricter than the public trust store, which would accept any
        // certificate signed by any recognised authority.
        rejectUnauthorized: true,
        ca: [pinned.pem],
        // The Bridge's certificate does not carry 127.0.0.1 as a name, so the
        // hostname check has to be skipped. It adds nothing on top of pinning:
        // matching a specific certificate is a stronger statement than matching
        // a name inside it.
        checkServerIdentity: () => undefined,
      },
      // No logging: the library would otherwise write headers and subject
      // lines to stderr.
      logger: false,
    })

    // Without a listener, a socket error after a successful connect would
    // become an unhandled event and take down the process.
    client.on('error', () => {
      // The state is checked via client.usable before every use, so the next
      // call rebuilds the connection. Nothing to do here beyond not crashing.
    })

    try {
      await client.connect()
    } catch (error) {
      throw explainError(error, this.config.host, this.config.imapPort)
    }

    this.#client = client
    return client
  }

  /**
   * Runs an operation and retries it once on a fresh connection if the
   * transport failed. That is the case when the Bridge was restarted between
   * two calls, which is common: it goes down with the machine and comes back
   * locked.
   */
  async #withRetry<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.open()
    try {
      return await operation(client)
    } catch (error) {
      if (!isTransportFailure(error)) {
        throw error instanceof BridgeError
          ? error
          : explainError(error, this.config.host, this.config.imapPort)
      }
      // Drop the dead connection and try exactly once more.
      this.#client = undefined
      const fresh = await this.open()
      try {
        return await operation(fresh)
      } catch (again) {
        throw explainError(again, this.config.host, this.config.imapPort)
      }
    }
  }

  /** Lists every mailbox. */
  async listMailboxes(): Promise<Mailbox[]> {
    const raw = await this.#withRetry<ListResponse[]>((client) => client.list())

    return raw.map((box) => {
      const path = box.path
      const segments = path.split('/')
      const entry: Mailbox = {
        path,
        name: segments[segments.length - 1] ?? path,
        kind: determineKind(path),
        selectable: !box.flags.has('\\Noselect'),
      }
      if (box.specialUse) entry.specialUse = box.specialUse
      return entry
    })
  }

  /**
   * Counters for a mailbox without selecting it.
   *
   * Needed before every fetch: the Bridge answers `FETCH 1:*` on an empty
   * mailbox with `BAD no such message` instead of an empty result, so the
   * count has to be known in advance.
   */
  async status(path: string): Promise<MailboxStatus> {
    const st = await this.#withRetry((client) =>
      client.status(path, { messages: true, unseen: true, uidValidity: true, uidNext: true }),
    )
    return {
      path,
      messages: st.messages ?? 0,
      unseen: st.unseen ?? 0,
      // uidValidity arrives as a BigInt and is only ever compared, never
      // calculated with, so a string is the honest representation.
      uidValidity: String(st.uidValidity ?? ''),
      uidNext: st.uidNext ?? 0,
    }
  }

  /**
   * Opens a mailbox, runs `operation` and releases the lock afterwards.
   *
   * A single IMAP connection has exactly one selected mailbox, so concurrent
   * calls would otherwise pull the rug out from under each other. imapflow
   * serialises this via a lock, and every mailbox access goes through here.
   */
  async withMailbox<T>(
    path: string,
    operation: (client: ImapFlow, status: MailboxStatus) => Promise<T>,
  ): Promise<T> {
    const status = await this.status(path)
    return this.#withRetry(async (client) => {
      let lock: MailboxLockObject
      try {
        lock = await client.getMailboxLock(path)
      } catch (error) {
        throw new BridgeError(
          `The mailbox "${path}" could not be opened. Check the exact spelling; ` +
            'user folders live below "Folders/" and labels below "Labels/". ' +
            'Use list_folders to see the available paths.',
          { cause: error },
        )
      }
      try {
        return await operation(client, status)
      } finally {
        lock.release()
      }
    })
  }

  /** Closes the connection if one is open. */
  async close(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    if (!client) return
    try {
      await client.logout()
    } catch {
      // While shutting down, a failed logout attempt does not matter.
    }
  }
}
