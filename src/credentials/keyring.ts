/**
 * Credentials in the operating system's keyring.
 *
 * @napi-rs/keyring is an optional dependency. On a platform without a prebuilt
 * binary the install does not fail, this store simply becomes unavailable and
 * the others remain. So it is loaded at runtime, and its absence has to be an
 * ordinary outcome rather than a crash.
 *
 * Every call here can block: a locked keyring opens a dialog, and the underlying
 * calls are synchronous. Callers must treat this store as potentially
 * unresponsive, see probeKeyring in availability.ts.
 */

import { createRequire } from 'node:module'
import type { CredentialStore, Credentials } from './store.js'
import { BridgeError } from '../bridge/errors.js'
import { prepareSessionBus } from './session-bus.js'

const require = createRequire(import.meta.url)

/** Identifies our entries in the keyring. */
export const SERVICE_NAME = 'proton-mcp'
/** The account under which the Bridge credentials are stored. */
export const ACCOUNT_NAME = 'bridge'

/** Minimal shape of what @napi-rs/keyring provides. */
interface KeyringEntry {
  setPassword(password: string): void
  getPassword(): string | null
  deletePassword(): boolean
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry
}

let cached: KeyringModule | undefined | null = undefined

/**
 * How the library is loaded: require rather than import(). The package is
 * CommonJS, and on 2026-11-02 import() of it handed back an empty module once
 * prepareSessionBus had looked at the D-Bus socket, in an installation that
 * reaches the package through a symbolic link, the way pnpm and npm link lay
 * packages out. Why is not known. require does not take that path, measured
 * the same day in that very layout. Replaced in tests.
 */
let loadLibrary = (): KeyringModule => require('@napi-rs/keyring') as KeyringModule

/**
 * Loads the keyring module, or reports that it is not there.
 *
 * The result is cached, including the negative one: a missing optional
 * dependency does not appear halfway through a session.
 */
export async function loadKeyringModule(): Promise<KeyringModule | undefined> {
  if (cached !== undefined) return cached ?? undefined
  // Before the library: it decides by the environment which store it uses,
  // see session-bus.ts.
  prepareSessionBus()
  try {
    const module = loadLibrary()
    cached = module
    return module
  } catch {
    cached = null
    return undefined
  }
}

/** For tests: replaces how the library is loaded. */
export function _setKeyringLoader(load: () => KeyringModule): void {
  loadLibrary = load
}

/** For tests, which must not depend on what is installed here. */
export function _setKeyringModule(module: KeyringModule | undefined): void {
  cached = module ?? null
}

/** Resets the cache. For tests. */
export function _resetKeyringModule(): void {
  cached = undefined
}

export class KeyringStore implements CredentialStore {
  readonly kind = 'keyring' as const

  constructor(
    private readonly service: string = SERVICE_NAME,
    private readonly account: string = ACCOUNT_NAME,
  ) {}

  async #entry(): Promise<KeyringEntry> {
    const module = await loadKeyringModule()
    if (!module) {
      throw new BridgeError(
        'The system keyring is not available in this installation. The optional dependency ' +
          '@napi-rs/keyring has no prebuilt binary for this platform. Choose a different place ' +
          'to keep the credentials.',
      )
    }
    return new module.Entry(this.service, this.account)
  }

  async load(): Promise<Credentials | undefined> {
    const entry = await this.#entry()
    const raw = entry.getPassword()
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as Credentials
      if (!parsed.user || !parsed.pass) return undefined
      return { user: parsed.user, pass: parsed.pass }
    } catch {
      // Someone or something wrote a value we cannot read. Treating it as
      // absent lets the user simply sign in again.
      return undefined
    }
  }

  async save(credentials: Credentials): Promise<void> {
    const entry = await this.#entry()
    // Both values go into one entry: the keyring stores a single secret per
    // account, and splitting them across two accounts would make a partial
    // state possible.
    entry.setPassword(JSON.stringify({ user: credentials.user, pass: credentials.pass }))
  }

  /**
   * Removes the entry, and succeeds only once it is gone.
   *
   * Read before and after, because deletePassword() answers false both when
   * there is nothing and when the entry is in a store it cannot see. Until
   * 2026-11-02 its answer and every error were dropped here, and a sign-out
   * reported success while the password stayed (#52).
   */
  async clear(): Promise<void> {
    const module = await loadKeyringModule()
    // Without the module, this installation cannot have stored anything here.
    if (!module) return
    const entry = new module.Entry(this.service, this.account)
    try {
      if (!entry.getPassword()) return
      entry.deletePassword()
      if (entry.getPassword()) throw new Error('the entry was still there after deleting it')
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
      throw new BridgeError(
        `The Bridge password could not be removed from the system keyring: ${reason}. Remove the ` +
          `entry "${this.service}" for "${this.account}" by hand, in the program that manages this ` +
          'keyring: Seahorse, KWalletManager, Keychain Access or the Credential Manager.',
      )
    }
  }
}
