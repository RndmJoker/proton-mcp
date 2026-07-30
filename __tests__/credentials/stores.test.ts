import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../src/credentials/session.js'
import {
  EncryptedFileStore,
  seal,
  unseal,
  encryptedFilePath,
} from '../../src/credentials/encrypted-file.js'
import {
  KeyringStore,
  _setKeyringModule,
  _resetKeyringModule,
} from '../../src/credentials/keyring.js'
import { listStores, recommend, recommendationReason } from '../../src/credentials/availability.js'
import {
  STORE_DESCRIPTIONS,
  EXPOSURE_LABELS,
  PRESENTATION_ORDER,
} from '../../src/credentials/store.js'
import { PlainFileStore } from '../../src/credentials/plain-file.js'
import { BridgeError } from '../../src/bridge/errors.js'

const creds = { user: 'someone@example.com', pass: 'bridge-password' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proton-mcp-cred-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  _resetKeyringModule()
})

describe('SessionStore', () => {
  it('holds credentials and hands them back', async () => {
    const store = new SessionStore()
    expect(await store.load()).toBeUndefined()
    await store.save(creds)
    expect(await store.load()).toEqual(creds)
  })

  it('forgets on clear', async () => {
    const store = new SessionStore()
    await store.save(creds)
    await store.clear()
    expect(await store.load()).toBeUndefined()
  })

  it('copies rather than holding the caller\'s object', async () => {
    // A caller who overwrites their own object must not silently change what is
    // stored.
    const mutable = { ...creds }
    const store = new SessionStore()
    await store.save(mutable)
    mutable.pass = 'changed'
    expect((await store.load())?.pass).toBe('bridge-password')
  })
})

describe('seal and unseal', () => {
  it('round-trips the credentials', async () => {
    const envelope = await seal(creds, 'master')
    expect(await unseal(envelope, 'master')).toEqual(creds)
  })

  it('never puts the plaintext into the envelope', async () => {
    const envelope = await seal(creds, 'master')
    const asText = JSON.stringify(envelope)
    expect(asText).not.toContain('bridge-password')
    expect(asText).not.toContain('someone@example.com')
  })

  it('uses a fresh salt and iv every time', async () => {
    // Otherwise the same credentials would produce the same ciphertext, which
    // leaks that nothing changed.
    const a = await seal(creds, 'master')
    const b = await seal(creds, 'master')
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('refuses a wrong master password', async () => {
    const envelope = await seal(creds, 'master')
    await expect(unseal(envelope, 'wrong')).rejects.toThrow(BridgeError)
  })

  it('detects a modified ciphertext instead of returning garbage', async () => {
    // This is why GCM and not CBC.
    const envelope = await seal(creds, 'master')
    const bytes = Buffer.from(envelope.ciphertext, 'base64')
    bytes[0] = bytes[0] === 0 ? 1 : (bytes[0] ?? 0) ^ 0xff
    await expect(
      unseal({ ...envelope, ciphertext: bytes.toString('base64') }, 'master'),
    ).rejects.toThrow(/wrong, or the file was modified/)
  })

  it('detects a modified auth tag', async () => {
    const envelope = await seal(creds, 'master')
    const tag = Buffer.from(envelope.authTag, 'base64')
    tag[0] = (tag[0] ?? 0) ^ 0xff
    await expect(unseal({ ...envelope, authTag: tag.toString('base64') }, 'master')).rejects.toThrow(
      BridgeError,
    )
  })

  it('rejects an unknown format rather than trying anyway', async () => {
    const envelope = await seal(creds, 'master')
    await expect(unseal({ ...envelope, version: 2 as 1 }, 'master')).rejects.toThrow(/unknown format/)
  })

  it('refuses to encrypt without a master password', async () => {
    await expect(seal(creds, '')).rejects.toThrow(BridgeError)
  })
})

describe('EncryptedFileStore', () => {
  it('returns nothing when no file exists yet', async () => {
    const store = new EncryptedFileStore(async () => 'master', join(dir, 'absent.enc'))
    expect(await store.load()).toBeUndefined()
  })

  it('writes and reads back', async () => {
    const path = join(dir, 'creds.enc')
    const store = new EncryptedFileStore(async () => 'master', path)
    await store.save(creds)
    expect(await store.load()).toEqual(creds)
  })

  it('writes the file so only the owner can read it', async () => {
    const path = join(dir, 'creds.enc')
    await new EncryptedFileStore(async () => 'master', path).save(creds)
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('creates missing directories', async () => {
    const path = join(dir, 'deep', 'creds.enc')
    await new EncryptedFileStore(async () => 'master', path).save(creds)
    expect(existsSync(path)).toBe(true)
  })

  it('reports an unreadable file instead of treating it as empty', async () => {
    // Silently returning undefined would look like "never signed in" and lose
    // the fact that something is wrong.
    const path = join(dir, 'broken.enc')
    writeFileSync(path, 'not json at all')
    const store = new EncryptedFileStore(async () => 'master', path)
    await expect(store.load()).rejects.toThrow(/not readable as a credentials file/)
  })

  it('asks for the master password only when it is needed', async () => {
    let asked = 0
    const store = new EncryptedFileStore(
      async () => {
        asked++
        return 'master'
      },
      join(dir, 'absent.enc'),
    )
    await store.load()
    // No file, so nothing to decrypt and no reason to prompt.
    expect(asked).toBe(0)
  })

  it('removes the file on clear and tolerates it being gone', async () => {
    const path = join(dir, 'creds.enc')
    const store = new EncryptedFileStore(async () => 'master', path)
    await store.save(creds)
    await store.clear()
    expect(existsSync(path)).toBe(false)
    await expect(store.clear()).resolves.toBeUndefined()
  })

  it('reports whether a file is there without asking for the password', async () => {
    // What tells "nothing stored" from "stored but locked". The first calls for
    // the full sign-in form, the second only for a master password, so getting
    // this wrong makes the encrypted option feel broken.
    const path = join(dir, 'creds.enc')
    let asked = 0
    const store = new EncryptedFileStore(async () => {
      asked++
      return 'master'
    }, path)

    expect(await store.exists()).toBe(false)
    await store.save(creds)
    expect(await store.exists()).toBe(true)
    // save() needs the password once; exists() must not need it at all.
    expect(asked).toBe(1)

    await store.clear()
    expect(await store.exists()).toBe(false)
  })
})

describe('encryptedFilePath', () => {
  it('can be overridden for tests and containers', () => {
    expect(encryptedFilePath({ PROTON_MCP_VAULT_FILE: '/tmp/v.enc' })).toBe('/tmp/v.enc')
  })

  it('otherwise sits with the other configuration', () => {
    expect(encryptedFilePath({})).toContain('proton-mcp')
  })
})

describe('KeyringStore', () => {
  /** Stands in for @napi-rs/keyring, which the tests must not depend on. */
  function fakeKeyring() {
    const stored = new Map<string, string>()
    return {
      stored,
      module: {
        Entry: class {
          #key: string
          constructor(service: string, account: string) {
            this.#key = `${service}:${account}`
          }
          setPassword(password: string): void {
            stored.set(this.#key, password)
          }
          getPassword(): string | null {
            return stored.get(this.#key) ?? null
          }
          deletePassword(): boolean {
            return stored.delete(this.#key)
          }
        },
      },
    }
  }

  it('stores both values in a single entry', async () => {
    // The keyring holds one secret per account, so splitting them would make a
    // half-saved state possible.
    const fake = fakeKeyring()
    _setKeyringModule(fake.module)
    const store = new KeyringStore('svc', 'acct')
    await store.save(creds)
    expect(fake.stored.size).toBe(1)
    expect(await store.load()).toEqual(creds)
  })

  it('returns nothing when the keyring is empty', async () => {
    _setKeyringModule(fakeKeyring().module)
    expect(await new KeyringStore('svc', 'acct').load()).toBeUndefined()
  })

  it('treats an unreadable entry as absent, so the user can just sign in again', async () => {
    const fake = fakeKeyring()
    _setKeyringModule(fake.module)
    fake.stored.set('svc:acct', 'this is not json')
    expect(await new KeyringStore('svc', 'acct').load()).toBeUndefined()
  })

  it('treats an incomplete entry as absent', async () => {
    const fake = fakeKeyring()
    _setKeyringModule(fake.module)
    fake.stored.set('svc:acct', JSON.stringify({ user: 'only-a-user' }))
    expect(await new KeyringStore('svc', 'acct').load()).toBeUndefined()
  })

  it('explains a missing optional dependency instead of crashing', async () => {
    _setKeyringModule(undefined)
    await expect(new KeyringStore().load()).rejects.toThrow(/not available in this installation/)
  })

  it('clears the entry', async () => {
    const fake = fakeKeyring()
    _setKeyringModule(fake.module)
    const store = new KeyringStore('svc', 'acct')
    await store.save(creds)
    await store.clear()
    expect(await store.load()).toBeUndefined()
  })
})

describe('listStores', () => {
  it('lists all four options, also when the keyring is out', async () => {
    // A shorter list would leave a user wondering why an option vanished.
    const stores = await listStores({ probe: async () => ({ ok: false, reason: 'no service' }) })
    expect(stores.map((x) => x.kind).sort()).toEqual(
      ['encrypted-file', 'keyring', 'plain-file', 'session'].sort(),
    )
  })

  it('marks the keyring unavailable with a reason', async () => {
    const stores = await listStores({ probe: async () => ({ ok: false, reason: 'no service' }) })
    const keyring = stores.find((x) => x.kind === 'keyring')
    expect(keyring?.available).toBe(false)
    expect(keyring?.reason).toBe('no service')
  })

  it('keeps the other three usable when the keyring is out', async () => {
    // Otherwise a headless machine could store nothing at all.
    const stores = await listStores({ probe: async () => ({ ok: false, reason: 'x' }) })
    for (const kind of ['encrypted-file', 'session', 'plain-file'] as const) {
      expect(stores.find((x) => x.kind === kind)?.available).toBe(true)
    }
  })

  it('states both sides for every option', async () => {
    // The point of the whole module: no option is sold, none is dismissed.
    const stores = await listStores({ probe: async () => ({ ok: true, writeMs: 1, readMs: 1 }) })
    for (const store of stores) {
      expect(store.benefit.length).toBeGreaterThan(30)
      expect(store.cost.length).toBeGreaterThan(30)
      expect(store.bestFor.length).toBeGreaterThan(10)
    }
  })

  it('presents least exposed first', async () => {
    // Choosing convenience should be a conscious step down the list.
    const stores = await listStores({ probe: async () => ({ ok: true, writeMs: 1, readMs: 1 }) })
    expect(stores.map((x) => x.exposure)).toEqual(['none', 'os-protected', 'encrypted', 'plaintext'])
  })

  it('reports how often each option prompts', async () => {
    const stores = await listStores({ probe: async () => ({ ok: true, writeMs: 1, readMs: 1 }) })
    const byKind = new Map(stores.map((x) => [x.kind, x]))
    expect(byKind.get('plain-file')?.prompts).toBe('never')
    expect(byKind.get('session')?.prompts).toBe('once per server start')
    expect(byKind.get('encrypted-file')?.prompts).toBe('once per server start')
  })

  it('names the macOS code hash problem in the keyring cost', async () => {
    const stores = await listStores({ probe: async () => ({ ok: true, writeMs: 1, readMs: 1 }) })
    const keyring = stores.find((x) => x.kind === 'keyring')
    expect(keyring?.cost).toContain('code hash')
    expect(keyring?.cost).toContain('Node update')
  })

  it('says plainly what protects the plain file', async () => {
    const stores = await listStores({ probe: async () => ({ ok: true, writeMs: 1, readMs: 1 }) })
    const plain = stores.find((x) => x.kind === 'plain-file')
    expect(plain?.cost).toContain('File permissions are the only thing protecting it')
  })

  it('warns in the encrypted-file cost that a forgotten master password is final', async () => {
    const stores = await listStores({ probe: async () => ({ ok: true, writeMs: 1, readMs: 1 }) })
    expect(stores.find((x) => x.kind === 'encrypted-file')?.cost).toContain('gone for good')
  })
})

describe('recommend', () => {
  it('prefers the keyring when it works', async () => {
    const stores = await listStores({ probe: async () => ({ ok: true, writeMs: 1, readMs: 1 }) })
    expect(recommend(stores)).toBe('keyring')
  })

  it('falls back to the encrypted file, never to the plain one', async () => {
    // The plain file should be a deliberate choice, not a default.
    const stores = await listStores({ probe: async () => ({ ok: false, reason: 'x' }) })
    expect(recommend(stores)).toBe('encrypted-file')
  })
})

describe('recommendationReason', () => {
  it('explains the suggestion and says the others are open', async () => {
    const stores = await listStores({ probe: async () => ({ ok: true, writeMs: 1, readMs: 1 }) })
    const text = recommendationReason(stores)
    expect(text).toContain('any of the others')
  })

  it('passes on why the keyring is out', async () => {
    const stores = await listStores({ probe: async () => ({ ok: false, reason: 'D-Bus missing' }) })
    expect(recommendationReason(stores)).toContain('D-Bus missing')
  })
})

describe('PlainFileStore', () => {
  it('returns nothing when the file is absent', async () => {
    const store = new PlainFileStore(join(dir, 'absent'))
    expect(await store.load()).toBeUndefined()
  })

  it('writes and reads back', async () => {
    const path = join(dir, 'env')
    const store = new PlainFileStore(path)
    await store.save(creds)
    expect(await store.load()).toEqual(creds)
  })

  it('stays readable and editable by hand, which is half the point', async () => {
    const path = join(dir, 'env')
    await new PlainFileStore(path).save(creds)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('BRIDGE_USER=someone@example.com')
    expect(content).toContain('# BRIDGE_PASS is the password the Bridge generates')
  })

  it('writes with owner-only permissions', async () => {
    const path = join(dir, 'env')
    await new PlainFileStore(path).save(creds)
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('tightens permissions on an existing loose file', async () => {
    // writeFile applies its mode only when creating, so an existing file with
    // loose permissions would silently keep them.
    const path = join(dir, 'env')
    writeFileSync(path, 'BRIDGE_USER=old\nBRIDGE_PASS=old\n', { mode: 0o644 })
    await new PlainFileStore(path).save(creds)
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('warns when the file is readable by others', async () => {
    const path = join(dir, 'env')
    writeFileSync(path, 'BRIDGE_USER=a@b.c\nBRIDGE_PASS=x\n', { mode: 0o644 })
    const warnings: string[] = []
    await new PlainFileStore(path, (m) => warnings.push(m)).load()
    expect(warnings.join(' ')).toContain('readable by other users')
  })

  it('treats an incomplete file as nothing stored', async () => {
    const path = join(dir, 'env')
    writeFileSync(path, 'BRIDGE_USER=only-a-user\n')
    expect(await new PlainFileStore(path).load()).toBeUndefined()
  })

  it('removes the file on clear and tolerates it being gone', async () => {
    const path = join(dir, 'env')
    const store = new PlainFileStore(path)
    await store.save(creds)
    await store.clear()
    expect(existsSync(path)).toBe(false)
    await expect(store.clear()).resolves.toBeUndefined()
  })
})

describe('STORE_DESCRIPTIONS', () => {
  it('describes every kind fully, so no option can render blank', () => {
    for (const kind of ['keyring', 'session', 'encrypted-file', 'plain-file'] as const) {
      const d = STORE_DESCRIPTIONS[kind]
      expect(d.title).toBeTruthy()
      expect(d.summary).toBeTruthy()
      expect(d.benefit).toBeTruthy()
      expect(d.cost).toBeTruthy()
      expect(d.bestFor).toBeTruthy()
      expect(d.exposure).toBeTruthy()
    }
  })

  it('gives every exposure level a label', () => {
    for (const level of ['none', 'encrypted', 'os-protected', 'plaintext'] as const) {
      expect(EXPOSURE_LABELS[level]).toBeTruthy()
    }
  })

  it('covers all four options in the presentation order', () => {
    expect(PRESENTATION_ORDER).toHaveLength(4)
    expect(new Set(PRESENTATION_ORDER).size).toBe(4)
  })
})
