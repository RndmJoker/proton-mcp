import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../src/session.js'
import type { CredentialStore, Credentials, StoreKind } from '../src/credentials/store.js'

/**
 * The session is the one place that knows whether we are signed in, so its
 * mistakes are the ones users feel: being asked for a password that is already
 * stored, or not being asked for one that is needed.
 *
 * The encrypted-file tests deliberately let the Session build that store
 * itself, only pointing it at a temporary path through the environment. Passing
 * a replacement store would bring its own master-password callback along, and
 * that callback is precisely what is under test here.
 */

const creds: Credentials = { user: 'someone@example.com', pass: 'bridge-password' }

/** A store that records what happened to it. */
function fake(
  kind: StoreKind,
  initial?: Credentials,
): CredentialStore & { saved: Credentials[]; cleared: number } {
  let held = initial
  return {
    kind,
    saved: [] as Credentials[],
    cleared: 0,
    async load() {
      return held
    },
    async save(c: Credentials) {
      this.saved.push(c)
      held = c
    },
    async clear() {
      this.cleared++
      held = undefined
    },
  }
}

/** The three stores that must never touch the real machine during a test. */
function harmlessStores(
  overrides: Partial<Record<StoreKind, CredentialStore>> = {},
): Partial<Record<StoreKind, CredentialStore>> {
  return {
    keyring: fake('keyring'),
    session: fake('session'),
    'plain-file': fake('plain-file'),
    ...overrides,
  }
}

const quiet = () => undefined

let dir: string
let vault: string
const previousVault = process.env.PROTON_MCP_VAULT_FILE

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proton-mcp-session-'))
  vault = join(dir, 'creds.enc')
  process.env.PROTON_MCP_VAULT_FILE = vault
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (previousVault === undefined) delete process.env.PROTON_MCP_VAULT_FILE
  else process.env.PROTON_MCP_VAULT_FILE = previousVault
})

describe('Session sign-in state', () => {
  it('takes up environment credentials right away', () => {
    // Not on first use: reporting "not signed in" while the next tool call
    // worked was a real bug.
    const session = new Session({ fromEnvironment: creds, stores: harmlessStores(), notify: quiet })
    expect(session.signedIn).toBe(true)
    expect(session.address).toBe('someone@example.com')
  })

  it('exposes the address but not the password', () => {
    const session = new Session({ fromEnvironment: creds, stores: harmlessStores(), notify: quiet })
    expect(session.address).toBe(creds.user)
    // Private fields, so nothing enumerable carries the secret.
    expect(JSON.stringify(session)).not.toContain(creds.pass)
  })

  it('restores from the plain file before the keyring', async () => {
    const keyring = fake('keyring', { user: 'other@example.com', pass: 'x' })
    const session = new Session({
      stores: harmlessStores({ 'plain-file': fake('plain-file', creds), keyring }),
      notify: quiet,
    })
    expect(await session.credentials()).toEqual(creds)
    expect(session.storeKind).toBe('plain-file')
  })

  it('carries on when one store cannot be read', async () => {
    const broken: CredentialStore = {
      kind: 'plain-file',
      load: async () => {
        throw new Error('permission denied')
      },
      save: async () => undefined,
      clear: async () => undefined,
    }
    const notices: string[] = []
    const session = new Session({
      stores: harmlessStores({ 'plain-file': broken, keyring: fake('keyring', creds) }),
      notify: (m) => notices.push(m),
    })
    expect(await session.credentials()).toEqual(creds)
    expect(notices.join(' ')).toContain('permission denied')
  })

  it('clears every store on sign-out, not only the one in use', async () => {
    const all = {
      keyring: fake('keyring'),
      session: fake('session'),
      'plain-file': fake('plain-file'),
      'encrypted-file': fake('encrypted-file'),
    }
    const session = new Session({ stores: all, notify: quiet })
    await session.signIn(creds, 'session')
    await session.signOut()
    for (const kind of Object.keys(all) as StoreKind[]) {
      expect(all[kind].cleared).toBeGreaterThan(0)
    }
    expect(session.signedIn).toBe(false)
  })
})

describe('Session with an encrypted file', () => {
  /** A session whose encrypted store is the real one, pointed at the temp path. */
  const build = () => new Session({ stores: harmlessStores(), notify: quiet })

  it('refuses to store in an encrypted file without a master password', async () => {
    const session = build()
    await expect(session.signIn(creds, 'encrypted-file')).rejects.toThrow(/master password/i)
    expect(session.signedIn).toBe(false)
    expect(existsSync(vault)).toBe(false)
  })

  it('encrypts with the given master password and opens it again later', async () => {
    await build().signIn(creds, 'encrypted-file', 'my-master')
    expect(existsSync(vault)).toBe(true)

    // A fresh process: nothing in memory, only the file on disk.
    const later = build()
    expect(later.signedIn).toBe(false)
    expect(await later.locked()).toBe(true)
    expect(await later.unlock('my-master')).toEqual(creds)
    expect(later.signedIn).toBe(true)
    expect(later.storeKind).toBe('encrypted-file')
  })

  it('rejects a wrong master password without remembering it', async () => {
    await build().signIn(creds, 'encrypted-file', 'my-master')

    const later = build()
    await expect(later.unlock('wrong')).rejects.toThrow(/could not be decrypted/)
    expect(later.signedIn).toBe(false)
    // Still locked, so the page asks again rather than claiming the file is broken.
    expect(await later.locked()).toBe(true)
    // The right one still works: a rejected attempt must not leave the wrong
    // password behind for the next call to trip over.
    expect(await later.unlock('my-master')).toEqual(creds)
  })

  it('refuses an empty master password on unlock', async () => {
    await expect(build().unlock('')).rejects.toThrow(/required/i)
  })

  it('says so when there is no file to unlock', async () => {
    await expect(build().unlock('my-master')).rejects.toThrow(/no encrypted credentials file/i)
  })

  it('reports locked only while something is stored and nothing is open', async () => {
    const session = build()
    // No file at all: nothing to unlock.
    expect(await session.locked()).toBe(false)
    await session.signIn(creds, 'encrypted-file', 'my-master')
    // Signed in, so the unlock page must not appear.
    expect(await session.locked()).toBe(false)
  })

  it('is never restored automatically on startup', async () => {
    // Deliberate: decrypting needs a master password and a stdio server has
    // nowhere to ask for one. It has to come back locked, not signed in, and
    // above all not as an error that stops the server from starting.
    await build().signIn(creds, 'encrypted-file', 'my-master')
    const later = build()
    expect(await later.credentials()).toBeUndefined()
    expect(await later.locked()).toBe(true)
  })

  it('discards the file for a forgotten master password', async () => {
    await build().signIn(creds, 'encrypted-file', 'my-master')
    const later = build()
    expect(await later.locked()).toBe(true)
    await later.discardEncrypted()
    // The way out: no longer locked, so the sign-in form appears instead of a
    // page that only accepts something the user does not have.
    expect(await later.locked()).toBe(false)
    expect(existsSync(vault)).toBe(false)
  })

  it('forgets the master password on sign-out', async () => {
    const session = build()
    await session.signIn(creds, 'encrypted-file', 'my-master')
    await session.signOut()
    // Sign-out deleted the file too, so the proof is that storing again needs
    // the password to be supplied afresh rather than being reused silently.
    await expect(session.signIn(creds, 'encrypted-file')).rejects.toThrow(/master password/i)
  })
})
