/**
 * Credentials in the operating system's keyring.
 *
 * @napi-rs/keyring is an optional dependency. On a platform without a prebuilt
 * binary the install does not fail, this store simply becomes unavailable and
 * the others remain. So the import has to be dynamic and its failure has to be
 * an ordinary outcome rather than a crash.
 *
 * Every call here can block: a locked keyring opens a dialog, and the underlying
 * calls are synchronous. Callers must treat this store as potentially
 * unresponsive, see probeKeyring in availability.ts.
 */

import type { CredentialStore, Credentials } from './store.js'
import { BridgeError } from '../bridge/errors.js'

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
 * Loads the keyring module, or reports that it is not there.
 *
 * The result is cached, including the negative one: a missing optional
 * dependency does not appear halfway through a session.
 */
export async function loadKeyringModule(): Promise<KeyringModule | undefined> {
  if (cached !== undefined) return cached ?? undefined
  try {
    const module = (await import('@napi-rs/keyring')) as unknown as KeyringModule
    cached = module
    return module
  } catch {
    cached = null
    return undefined
  }
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

  async clear(): Promise<void> {
    const entry = await this.#entry()
    try {
      entry.deletePassword()
    } catch {
      // Nothing stored is the outcome we wanted anyway.
    }
  }
}
