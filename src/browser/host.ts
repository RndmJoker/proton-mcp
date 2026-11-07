/**
 * The connector Chrome starts for the extension (#59), in Chrome's words a
 * native messaging host.
 *
 * Chrome starts it when the extension asks for it, hands it the extension's
 * origin as the first argument, and talks to it over standard input and
 * output. Chrome starts it only for the extension named in its manifest, and
 * only from that extension: a web page cannot reach it.
 *
 * The connector opens a socket file for this server and relays between the two.
 * It holds nothing and decides nothing about filters. What it does decide is
 * who gets through:
 *
 * - Chrome's origin has to be the extension's fixed id.
 * - A connection on the socket has to prove it knows the secret from the
 *   setup before it may send anything, and the connector proves the same back.
 * - Every request has to be one of the three kinds in messages.ts, in exactly
 *   that shape, and every answer from the extension as well.
 *
 * It stops when Chrome closes the channel, which happens when the extension
 * is switched off, reloaded or removed, or when Chrome quits.
 *
 * The setup copies this file, with connector.ts, paths.ts, channel.ts and
 * messages.ts, into the user's configuration directory, and connector.ts
 * starts it with the Node the setup ran under. So it imports nothing but Node
 * and those files.
 */

import { createServer, connect, type Socket } from 'node:net'
import { existsSync, unlinkSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { EXTENSION_ID, PROTOCOL_VERSION, parseRequest, parseResponse, isRequestId, type BrowserResponse } from './messages.js'
import type { BrowserPaths } from './paths.js'
import {
  encodeNative,
  NativeReader,
  LineReader,
  MAX_REQUEST_LINE,
  parseLine,
  newNonce,
  proof,
  proofMatches,
  isNonce,
  readSecret,
  ensurePrivateDir,
} from './channel.js'

/** How long a request may wait for the extension. Filling in a confirmation is not waited for. */
export const REQUEST_TIMEOUT_MS = 60_000

/** How long a new connection has to prove the secret. */
const AUTH_TIMEOUT_MS = 3_000

const MAX_PENDING_PER_CONNECTION = 4
const MAX_PENDING = 16

export interface HostOptions {
  /** What Chrome writes: the extension's messages. */
  input: Readable
  /** What Chrome reads. */
  output: Writable
  /** The first argument Chrome passes: the extension's origin. */
  origin: string | undefined
  paths: BrowserPaths
  log?: (line: string) => void
  requestTimeoutMs?: number
}

export interface RunningHost {
  /** Settles once Chrome closed the channel and the socket is gone, or the connector gave up. */
  done: Promise<void>
  /** The reason the connector gave up at start, if it did. */
  failure?: string
  close(): Promise<void>
}

/** True when something already answers on the socket: a connector of another Chrome profile. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    const timer = setTimeout(() => {
      probe.destroy()
      resolve(false)
    }, 500)
    probe.once('connect', () => {
      clearTimeout(timer)
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

export async function runHost(options: HostOptions): Promise<RunningHost> {
  const { input, output, paths } = options
  const log = options.log ?? (() => undefined)
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const isPipe = paths.platform === 'win32'

  const toChrome = (message: unknown): Promise<void> =>
    new Promise((resolve) => {
      try {
        output.write(encodeNative(message), () => resolve())
      } catch (error) {
        log(`could not pass a message to Chrome: ${(error as Error).message}`)
        resolve()
      }
    })

  // Reported to the extension, which shows it in its popup, and then the
  // connector ends: Chrome sees the channel close and the extension knows why.
  const giveUp = async (failure: string): Promise<RunningHost> => {
    log(failure)
    await toChrome({ type: 'host-error', message: failure })
    return { done: Promise.resolve(), failure, close: async () => undefined }
  }

  if (options.origin !== `chrome-extension://${EXTENSION_ID}/`) {
    return giveUp('The connector was started for an extension it does not serve.')
  }
  const secret = readSecret(paths.secretFile)
  if (!secret) {
    return giveUp('The connector is not set up: the secret is missing. Run the setup again.')
  }

  if (!isPipe) {
    try {
      ensurePrivateDir(dirname(paths.socket))
    } catch (error) {
      return giveUp((error as Error).message)
    }
  }
  if ((isPipe || existsSync(paths.socket)) && (await answers(paths.socket))) {
    return giveUp(
      'Another Chrome profile already runs the connector. Only one profile at a time can serve the server; ' +
        'switch the extension off in the other one.',
    )
  }
  if (!isPipe && existsSync(paths.socket)) {
    // Left behind by a connector that did not get to clean up.
    try {
      unlinkSync(paths.socket)
    } catch {
      // Listening fails below with the reason.
    }
  }

  const pending = new Map<string, { socket: Socket; clientId: string; timer: NodeJS.Timeout }>()
  const sockets = new Set<Socket>()
  let counter = 0

  const server = createServer((socket) => serve(socket))
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(paths.socket, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    return giveUp(`The connector could not open its socket: ${(error as Error).message}`)
  }
  if (!isPipe) chmodSync(paths.socket, 0o600)
  await toChrome({ type: 'host-ready', version: PROTOCOL_VERSION })

  function serve(socket: Socket): void {
    sockets.add(socket)
    const reader = new LineReader(MAX_REQUEST_LINE)
    const nonce = newNonce()
    let ready = false
    const send = (message: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
    }
    const answer = (clientId: string, body: BrowserResponse): void => send({ type: 'response', id: clientId, body })
    const authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS)

    send({ type: 'hello', version: PROTOCOL_VERSION, nonce })

    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = reader.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const line of lines) {
        const message = parseLine(line)
        if (!ready) {
          clearTimeout(authTimer)
          if (
            !message ||
            message.type !== 'auth' ||
            !isNonce(message.nonce) ||
            !proofMatches(secret!, 'client', nonce, message.proof)
          ) {
            log('refused a connection that could not prove the secret')
            socket.destroy()
            return
          }
          ready = true
          send({ type: 'ready', proof: proof(secret!, 'host', message.nonce) })
          continue
        }
        if (!message || message.type !== 'request' || !isRequestId(message.id)) {
          socket.destroy()
          return
        }
        const clientId = message.id
        const body = parseRequest(message.body)
        if (!body) {
          answer(clientId, { ok: false, error: 'unknown-request', message: 'The connector does not pass on this request.' })
          continue
        }
        const mine = [...pending.values()].filter((entry) => entry.socket === socket).length
        if (mine >= MAX_PENDING_PER_CONNECTION || pending.size >= MAX_PENDING) {
          answer(clientId, { ok: false, error: 'busy', message: 'The extension is still working on earlier requests.' })
          continue
        }
        const id = `h${++counter}`
        const timer = setTimeout(() => {
          pending.delete(id)
          answer(clientId, { ok: false, error: 'timeout', message: 'The extension did not answer in time.' })
        }, timeoutMs)
        pending.set(id, { socket, clientId, timer })
        void toChrome({ type: 'request', id, body })
      }
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      sockets.delete(socket)
      for (const [id, entry] of pending) {
        if (entry.socket === socket) {
          clearTimeout(entry.timer)
          pending.delete(id)
        }
      }
    })
    socket.on('error', () => undefined)
  }

  const native = new NativeReader()
  input.on('data', (chunk: Buffer) => {
    let messages: unknown[]
    try {
      messages = native.push(chunk)
    } catch (error) {
      log((error as Error).message)
      void close()
      return
    }
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue
      const { type, id, body } = message as Record<string, unknown>
      if (type !== 'response' || typeof id !== 'string') continue
      const entry = pending.get(id)
      if (!entry) continue
      pending.delete(id)
      clearTimeout(entry.timer)
      const parsed = parseResponse(body) ?? {
        ok: false as const,
        error: 'internal' as const,
        message: 'The extension answered in a shape the connector does not pass on.',
      }
      if (!entry.socket.destroyed) {
        entry.socket.write(`${JSON.stringify({ type: 'response', id: entry.clientId, body: parsed })}\n`)
      }
    }
  })

  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => (resolveDone = resolve))
  let closing: Promise<void> | undefined

  function close(): Promise<void> {
    closing ??= (async () => {
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (!isPipe) {
        try {
          unlinkSync(paths.socket)
        } catch {
          // Already gone.
        }
      }
      resolveDone()
    })()
    return closing
  }

  input.on('end', () => void close())
  input.on('close', () => void close())

  return { done, close }
}

