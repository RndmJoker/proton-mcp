/**
 * The wire under the browser channel (#59): how messages are framed, and how
 * the two ends of the socket recognise each other.
 *
 * Chrome talks to the connector over its standard input and output, each message
 * a four-byte length in the machine's byte order followed by JSON. The connector
 * and this server talk over a socket file, one JSON message per line.
 *
 * Before anything else on the socket, both ends prove that they know the
 * secret the setup wrote, without sending it. The connector proves it as well,
 * not only the server: a program that got to the socket name first could
 * otherwise collect what the server sends, the account address and the
 * proposed scripts among it.
 *
 * Copied next to the connector by the setup, so it imports nothing but Node.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { endianness } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { lstatSync, mkdirSync, chmodSync, readFileSync } from 'node:fs'

/**
 * The largest message accepted from Chrome, and the longest line on the
 * socket. Both have to hold the largest answer the extension may give: a
 * thousand filters of up to 60,000 characters each, as messages.ts allows.
 */
export const MAX_FROM_CHROME = 64 * 1024 * 1024

/** Chrome refuses anything larger from a native host and closes the channel. */
export const MAX_TO_CHROME = 1024 * 1024

/** The longest line accepted on the socket: an answer, which can be as large as one from Chrome. */
export const MAX_LINE = MAX_FROM_CHROME

/**
 * The longest line the connector takes from a program on the socket. A
 * request carries at most one script of 60,000 characters and fifty moves,
 * so anything near this is not one, and is not kept in memory before the
 * secret is even proven.
 */
export const MAX_REQUEST_LINE = 1024 * 1024

const LITTLE = endianness() === 'LE'

export class FrameError extends Error {}

/** One message for Chrome: the length, then the JSON. */
export function encodeNative(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > MAX_TO_CHROME) throw new FrameError(`A message of ${body.length} bytes is more than Chrome accepts.`)
  const head = Buffer.alloc(4)
  if (LITTLE) head.writeUInt32LE(body.length)
  else head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

/** Reads Chrome's framed messages out of a stream, however the chunks fall. */
export class NativeReader {
  #buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      if (this.#buffer.length < 4) return messages
      const length = LITTLE ? this.#buffer.readUInt32LE(0) : this.#buffer.readUInt32BE(0)
      if (length > MAX_FROM_CHROME) throw new FrameError(`A message of ${length} bytes is more than the connector accepts.`)
      if (this.#buffer.length < 4 + length) return messages
      const body = this.#buffer.subarray(4, 4 + length).toString('utf8')
      this.#buffer = this.#buffer.subarray(4 + length)
      try {
        messages.push(JSON.parse(body))
      } catch {
        throw new FrameError('A message from Chrome was not JSON.')
      }
    }
  }
}

/**
 * Splits a socket stream into lines, refusing one that never ends.
 *
 * Decodes across chunks: a character of more than one byte can be split
 * between two of them, and decoding each chunk alone turned a letter such as
 * an umlaut in a filter name into replacement characters, silently, found in
 * the review of 06.11.2026.
 */
export class LineReader {
  #pending = ''
  readonly #decoder = new StringDecoder('utf8')

  constructor(readonly max: number = MAX_LINE) {}

  push(chunk: Buffer | string): string[] {
    this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk)
    const lines = this.#pending.split('\n')
    this.#pending = lines.pop() ?? ''
    if (this.#pending.length > this.max) throw new FrameError('A line on the socket is longer than accepted.')
    return lines.filter((line) => line.trim().length > 0)
  }
}

/** Reads one line as a JSON object, or nothing when it is not one. */
export function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function newNonce(): string {
  return randomBytes(32).toString('hex')
}

/** The proof of one end. The role is part of it, so a proof cannot be reflected back. */
export function proof(secret: Buffer, role: 'client' | 'host', nonce: string): string {
  return createHmac('sha256', secret).update(`proton-mcp-browser:${role}:${nonce}`).digest('hex')
}

export function proofMatches(secret: Buffer, role: 'client' | 'host', nonce: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || !/^[0-9a-f]{64}$/.test(presented)) return false
  return timingSafeEqual(Buffer.from(proof(secret, role, nonce), 'hex'), Buffer.from(presented, 'hex'))
}

/** True for a nonce as newNonce makes them. */
export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** The secret from its file, or nothing when there is none or it is not one. */
export function readSecret(file: string): Buffer | undefined {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : undefined
  } catch {
    return undefined
  }
}

/** A directory that is not private enough to hold the socket. */
export class UnsafeDirectory extends Error {}

/**
 * Creates the directory for the socket, readable by the user only, and refuses
 * one that somebody else owns, that is a symbolic link, or that others can
 * open. Only meaningful for socket files; on Windows the pipe has its own
 * permissions.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafeDirectory(`${dir} is not a plain directory, so the socket is not placed there.`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new UnsafeDirectory(`${dir} belongs to another user, so the socket is not placed there.`)
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}
