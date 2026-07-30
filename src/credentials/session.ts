/**
 * Credentials held in memory only.
 *
 * The safest option and the least convenient: nothing reaches the disk, and
 * nothing survives the process. For most clients that means signing in again
 * for every conversation, because they start the server anew each time.
 */

import type { CredentialStore, Credentials } from './store.js'

export class SessionStore implements CredentialStore {
  readonly kind = 'session' as const
  #held: Credentials | undefined

  async load(): Promise<Credentials | undefined> {
    return this.#held
  }

  async save(credentials: Credentials): Promise<void> {
    this.#held = { user: credentials.user, pass: credentials.pass }
  }

  async clear(): Promise<void> {
    this.#held = undefined
  }
}
