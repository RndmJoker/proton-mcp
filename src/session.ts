/**
 * The signed-in state of the server.
 *
 * Credentials used to be part of the configuration, read once at startup. That
 * no longer works: with the web interface they can arrive at any time, and they
 * can be revoked while the server keeps running. This is the one place that
 * knows whether we are signed in.
 *
 * It also decides where credentials come from on startup, in this order:
 *
 * 1. Environment variables, when set. An explicit setting is never overruled.
 * 2. The plain file, which is the interim path and the one existing setups use.
 * 3. The system keyring, if something was stored there.
 *
 * The encrypted file is deliberately not in that list, because it cannot be:
 * decrypting it needs a master password, and there is nowhere to ask for one
 * while a stdio server starts up. It is instead reported as **locked**, which
 * the web interface turns into a page asking for that one password. This is
 * the whole reason `locked()` and `unlock()` exist rather than a fourth entry
 * in the loop above.
 */

import type { Credentials, CredentialStore, StoreKind } from './credentials/store.js'
import { KeyringStore } from './credentials/keyring.js'
import { SessionStore } from './credentials/session.js'
import { PlainFileStore } from './credentials/plain-file.js'
import { EncryptedFileStore } from './credentials/encrypted-file.js'
import { BridgeError } from './bridge/errors.js'

export interface SessionOptions {
  /** Credentials from the environment, when they were set. */
  fromEnvironment?: Credentials
  /** Where notices go. stderr, never stdout, which carries the protocol. */
  notify?: (message: string) => void
  /** Replaces the stores. Used by tests. */
  stores?: Partial<Record<StoreKind, CredentialStore>>
}

/** What the encrypted store is told when nobody has supplied a master password. */
const NO_MASTER_PASSWORD =
  'The encrypted credentials file needs a master password. Open the configuration page and ' +
  'unlock it there.'

export class Session {
  #credentials: Credentials | undefined
  #storeKind: StoreKind | undefined
  /**
   * The master password for the encrypted file, for as long as the process runs.
   *
   * Held in memory only, and only when that store is in use. Writing it
   * anywhere would defeat the point of the option: the file is protected by
   * something that exists nowhere else.
   */
  #masterPassword: string | undefined
  readonly #stores: Record<StoreKind, CredentialStore>
  readonly #notify: (message: string) => void
  /** Set once startup has looked for stored credentials. */
  #restored = false

  constructor(options: SessionOptions = {}) {
    this.#notify = options.notify ?? ((m) => process.stderr.write(`proton-mcp: ${m}\n`))

    // Taken up right away rather than on first use. Reading the environment
    // costs nothing and cannot block, and leaving it for later made the status
    // claim "not signed in" while the very next tool call worked.
    if (options.fromEnvironment) {
      this.#credentials = options.fromEnvironment
      this.#storeKind = 'plain-file'
      this.#restored = true
    }
    this.#stores = {
      keyring: options.stores?.keyring ?? new KeyringStore(),
      session: options.stores?.session ?? new SessionStore(),
      'plain-file': options.stores?.['plain-file'] ?? new PlainFileStore(),
      'encrypted-file':
        options.stores?.['encrypted-file'] ??
        new EncryptedFileStore(async () => {
          if (this.#masterPassword === undefined) throw new BridgeError(NO_MASTER_PASSWORD)
          return this.#masterPassword
        }),
    }
  }

  get storeKind(): StoreKind | undefined {
    return this.#storeKind
  }

  get signedIn(): boolean {
    return this.#credentials !== undefined
  }

  /** The address we are signed in as, for display. Never the password. */
  get address(): string | undefined {
    return this.#credentials?.user
  }

  /**
   * Returns the credentials, restoring them from a store on first use.
   *
   * Restoring happens here rather than at startup so that a locked keyring
   * cannot block the server from starting. It costs one attempt on the first
   * tool call instead.
   */
  async credentials(): Promise<Credentials | undefined> {
    if (this.#credentials) return this.#credentials
    if (this.#restored) return undefined
    this.#restored = true

    // Order matters: the cheap and non-blocking source first.
    for (const kind of ['plain-file', 'keyring'] as const) {
      try {
        const found = await this.#stores[kind].load()
        if (found) {
          this.#credentials = found
          this.#storeKind = kind
          return found
        }
      } catch (error) {
        // A store that cannot be read is not a reason to fail: another one may
        // work, and the web interface can always be used.
        this.#notify(`could not read credentials from the ${kind}: ${(error as Error).message}`)
      }
    }

    return undefined
  }

  /**
   * Whether credentials are stored that only a master password can open.
   *
   * Distinct from "not signed in": the user does not need to fetch their Bridge
   * password from the Bridge again, they need to type one thing. A page that
   * asked for everything would make the encrypted option feel broken.
   */
  async locked(): Promise<boolean> {
    if (this.#credentials) return false
    const exists = this.#stores['encrypted-file'].exists
    if (!exists) return false
    try {
      return await exists.call(this.#stores['encrypted-file'])
    } catch {
      // Not being able to look is not the same as it being there.
      return false
    }
  }

  /**
   * Opens the encrypted file with the given master password.
   *
   * Returns the credentials so the caller can verify them against the Bridge.
   * On failure the password is dropped again: keeping a wrong one would make
   * every later attempt fail with a message about the file instead of about
   * the password.
   */
  async unlock(masterPassword: string): Promise<Credentials> {
    if (!masterPassword) throw new BridgeError('The master password is required.')
    this.#masterPassword = masterPassword
    try {
      const found = await this.#stores['encrypted-file'].load()
      if (!found) {
        throw new BridgeError('There is no encrypted credentials file to unlock.')
      }
      this.#credentials = found
      this.#storeKind = 'encrypted-file'
      this.#restored = true
      return found
    } catch (error) {
      this.#masterPassword = undefined
      throw error
    }
  }

  /**
   * Throws away the encrypted file without opening it.
   *
   * The way out for someone who forgot their master password. Without it they
   * would be stuck on the unlock page for good, because nothing anywhere can
   * decrypt that file. What is destroyed is a Bridge password that can be
   * looked up in the Bridge again, so this is recoverable in the only sense
   * that matters.
   */
  async discardEncrypted(): Promise<void> {
    await this.#stores['encrypted-file'].clear()
    this.#masterPassword = undefined
  }

  /**
   * Stores credentials and marks the session as signed in.
   *
   * The caller has already verified them against the Bridge: storing something
   * that does not work would be worse than not storing it.
   */
  async signIn(
    credentials: Credentials,
    storeKind: StoreKind,
    /** Required for the encrypted file, meaningless for every other store. */
    masterPassword?: string,
  ): Promise<void> {
    if (storeKind === 'encrypted-file') {
      if (!masterPassword) {
        throw new BridgeError(
          'Keeping the credentials in an encrypted file needs a master password to encrypt them with.',
        )
      }
      this.#masterPassword = masterPassword
    }

    try {
      await this.#stores[storeKind].save(credentials)
    } catch (error) {
      // A master password that did not lead to a stored file must not stay
      // behind, or the next attempt would silently use it.
      if (storeKind === 'encrypted-file') this.#masterPassword = undefined
      throw error
    }

    this.#credentials = credentials
    this.#storeKind = storeKind
    this.#restored = true
  }

  /** Forgets the credentials everywhere they might be. */
  async signOut(): Promise<void> {
    // Every store, not only the one in use: a user signing out means "remove it",
    // and a leftover in another store would silently sign them back in.
    for (const kind of Object.keys(this.#stores) as StoreKind[]) {
      try {
        await this.#stores[kind].clear()
      } catch {
        // Nothing there is the outcome we wanted anyway.
      }
    }
    this.#credentials = undefined
    this.#storeKind = undefined
    this.#masterPassword = undefined
    this.#restored = true
  }

  /** Replaces a store. Used by tests and by the startup wiring. */
  setStore(kind: StoreKind, store: CredentialStore): void {
    this.#stores[kind] = store
  }
}
