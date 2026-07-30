/**
 * Credentials in a file, encrypted with a master password.
 *
 * The option that needs no system service, which makes it the one for
 * containers, headless machines and anywhere a keyring is out of reach. The
 * price is honest and unavoidable: the master password has to be entered every
 * time the server starts, because storing it somewhere would only move the
 * problem.
 *
 * AES-256-GCM with a key derived by scrypt. GCM rather than CBC so a modified
 * file is detected instead of decrypting into garbage, and scrypt rather than a
 * plain hash so guessing the master password stays expensive.
 */

import { randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFile, writeFile, unlink, mkdir, access, constants } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { CredentialStore, Credentials } from './store.js'
import { BridgeError } from '../bridge/errors.js'

/**
 * Own wrapper instead of promisify: scrypt is overloaded, and promisify picks
 * the signature without the options object, which is exactly the one we need
 * because the cost parameters live in there.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

/** Deliberately costly. These are the defaults Node documents as reasonable. */
const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 32 }
const SALT_BYTES = 16
const IV_BYTES = 12

/** What ends up in the file. Everything except the master password. */
interface Envelope {
  version: 1
  algorithm: 'aes-256-gcm'
  kdf: 'scrypt'
  salt: string
  iv: string
  authTag: string
  ciphertext: string
}

export function encryptedFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROTON_MCP_VAULT_FILE) return env.PROTON_MCP_VAULT_FILE
  return join(homedir(), '.config', 'proton-mcp', 'credentials.enc')
}

async function deriveKey(masterPassword: string, salt: Buffer): Promise<Buffer> {
  return scrypt(masterPassword, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  })
}

/** Encrypts credentials into the envelope that gets written to disk. */
export async function seal(credentials: Credentials, masterPassword: string): Promise<Envelope> {
  if (!masterPassword) {
    throw new BridgeError('A master password is required to encrypt the credentials.')
  }
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await deriveKey(masterPassword, salt)

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = JSON.stringify({ user: credentials.user, pass: credentials.pass })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

/** Decrypts an envelope. A wrong master password and a tampered file look alike. */
export async function unseal(envelope: Envelope, masterPassword: string): Promise<Credentials> {
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new BridgeError(
      `The credentials file uses an unknown format (version ${envelope.version}, ${envelope.algorithm}). ` +
        'It was probably written by a newer version of proton-mcp.',
    )
  }

  const key = await deriveKey(masterPassword, Buffer.from(envelope.salt, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))

  let plaintext: string
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // GCM cannot tell a wrong key from a modified file, and neither can we.
    // Saying so is better than guessing which one it was.
    throw new BridgeError(
      'The credentials could not be decrypted. Either the master password is wrong, or the file ' +
        'was modified. Nothing was changed on disk.',
    )
  }

  const parsed = JSON.parse(plaintext) as Credentials
  if (!parsed.user || !parsed.pass) {
    throw new BridgeError('The credentials file decrypted but does not contain a user and password.')
  }
  return { user: parsed.user, pass: parsed.pass }
}

export class EncryptedFileStore implements CredentialStore {
  readonly kind = 'encrypted-file' as const

  constructor(
    /** Supplies the master password. Asked for as late as possible. */
    private readonly masterPassword: () => Promise<string>,
    private readonly path: string = encryptedFilePath(),
  ) {}

  /**
   * Whether a credentials file is there, without trying to decrypt it.
   *
   * Answers the question the sign-in page needs before it can decide what to
   * ask for: an existing file means the user only has to supply the master
   * password, not their Bridge password all over again.
   */
  async exists(): Promise<boolean> {
    try {
      await access(this.path, constants.R_OK)
      return true
    } catch {
      return false
    }
  }

  async load(): Promise<Credentials | undefined> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      return undefined
    }

    let envelope: Envelope
    try {
      envelope = JSON.parse(raw) as Envelope
    } catch {
      throw new BridgeError(
        `${this.path} is not readable as a credentials file. Delete it and sign in again.`,
      )
    }

    return unseal(envelope, await this.masterPassword())
  }

  async save(credentials: Credentials): Promise<void> {
    const envelope = await seal(credentials, await this.masterPassword())
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.path, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 })
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path)
    } catch {
      // Already gone is the outcome we wanted.
    }
  }
}
