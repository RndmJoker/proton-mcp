/**
 * This server's end of the browser channel (#59).
 *
 * One connection per request: filters are asked about now and then, and a
 * connection held open would have to notice Chrome going away and coming back,
 * which a fresh one does for free.
 *
 * When the extension cannot be reached, the answer says so plainly and names
 * the cause wherever it can be found out: no setup, Chrome not running, the
 * extension missing or switched off, a connector left over from before. Tobi
 * asked for exactly that on 05.11.2026: "the extension is not active", and
 * help with it, rather than an error code nobody can act on.
 */

import { connect, type Socket } from 'node:net'
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, win32 } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION, parseResponse, type BrowserRequest, type BrowserResponse } from './messages.js'
import { browserPaths, UnsupportedPlatform, type BrowserPaths } from './paths.js'
import { LineReader, parseLine, newNonce, proof, proofMatches, isNonce, readSecret } from './channel.js'

/** The command that sets the connector up, as a user types it. */
export const SETUP_COMMAND = 'npx -y @rndmjoker/proton-mcp@latest setup-browser'

export type Unavailable =
  | 'platform'
  | 'not-set-up'
  | 'setup-broken'
  | 'browser-closed'
  | 'extension-not-connected'
  | 'connector-stale'
  | 'connector-outdated'
  | 'secret-mismatch'
  | 'unsafe-socket-dir'
  | 'no-answer'

/** The extension cannot be reached. The message says why, the help what to do. */
export class BrowserUnavailable extends Error {
  constructor(
    readonly reason: Unavailable,
    message: string,
    readonly help: string[],
  ) {
    super(message)
  }
}

const LOAD_EXTENSION =
  'Load the extension in Chrome: open chrome://extensions, switch on Developer mode, choose ' +
  '"Load unpacked" and pick the unpacked folder of the extension from the release.'

const RELOAD_EXTENSION =
  'Open chrome://extensions, find "Proton MCP Helper" and click its reload arrow. Its popup ' +
  'shows what it reports about the connector.'

/** Whether Chrome is running, or nothing when that cannot be told. */
export function chromeRunning(platform: BrowserPaths['platform']): boolean | undefined {
  try {
    if (platform === 'linux') {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue
        try {
          if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() === 'chrome') return true
        } catch {
          // A process that ended while the list was read.
        }
      }
      return false
    }
    // Programs by their full path: a bare name is looked up in the current
    // directory first on Windows, and a project the assistant works in could
    // carry a tasklist.exe of its own. Found in the review of 06.11.2026.
    if (platform === 'darwin') {
      const list = execFileSync('/bin/ps', ['-axo', 'comm'], { encoding: 'utf8', timeout: 3000 })
      return list.split('\n').some((line) => line.endsWith('/Google Chrome'))
    }
    const tasklist = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe')
    const list = execFileSync(tasklist, ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    })
    return /chrome\.exe/i.test(list)
  } catch {
    return undefined
  }
}

/** The Node the launcher starts the connector with, read back from the launcher. */
function launcherNode(paths: BrowserPaths): string | undefined {
  try {
    const text = readFileSync(paths.launcher, 'utf8')
    const match = paths.platform === 'win32' ? /^"([^"]+)"/m.exec(text) : /^exec '((?:[^']|'\\'')+)'/m.exec(text)
    return match?.[1]?.replace(/'\\''/g, "'")
  } catch {
    return undefined
  }
}

/**
 * Why nothing answers on the socket, as far as it can be told from outside.
 *
 * Checked from the cause that needs the most work to the one that needs the
 * least, so the answer starts where the user has to start.
 */
export function diagnose(
  paths: BrowserPaths,
  running: boolean | undefined = chromeRunning(paths.platform),
): BrowserUnavailable {
  if (!existsSync(paths.secretFile) || !existsSync(paths.manifestFile) || !existsSync(paths.launcher)) {
    return new BrowserUnavailable(
      'not-set-up',
      'The browser extension Proton MCP Helper is not active: its connector is not set up on this computer.',
      [
        `Run this in a terminal: ${SETUP_COMMAND}`,
        LOAD_EXTENSION,
        'Reload any open Proton tab once afterwards.',
      ],
    )
  }
  const node = launcherNode(paths)
  if (node && !existsSync(node)) {
    return new BrowserUnavailable(
      'setup-broken',
      `The browser extension Proton MCP Helper is not active: its connector was set up with a Node that no longer exists (${node}).`,
      [`Run the setup again in a terminal: ${SETUP_COMMAND}`, RELOAD_EXTENSION],
    )
  }
  if (running === false) {
    return new BrowserUnavailable(
      'browser-closed',
      'The browser extension Proton MCP Helper is not active: Chrome is not running.',
      ['Start Chrome and open https://mail.proton.me, signed in to the account.'],
    )
  }
  return new BrowserUnavailable(
    'extension-not-connected',
    'The browser extension Proton MCP Helper is not active: ' +
      (running ? 'Chrome is running and the connector is set up, but ' : 'the connector is set up, but ') +
      'the extension has not started it. It is missing, switched off, or needs a reload.',
    [
      RELOAD_EXTENSION,
      'If it is not listed there: ' + LOAD_EXTENSION,
    ],
  )
}

/** Why a directory is not private enough for the socket, or nothing when it is or does not exist yet. */
export function unsafeDirectory(dir: string): string | undefined {
  let stat
  try {
    stat = lstatSync(dir)
  } catch {
    return undefined
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `${dir} is not a plain directory.`
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) return `${dir} belongs to another user.`
  if ((stat.mode & 0o077) !== 0) return `${dir} can be opened by other users.`
  return undefined
}

export interface AskOptions {
  paths?: BrowserPaths
  /** How long to wait for the answer after the request went out. */
  timeoutMs?: number
  /** Replaces the check for a running Chrome, for tests. */
  chromeRunning?: () => boolean | undefined
}

/** Waits for the next message on the socket, or fails when it closes or takes too long. */
class Conversation {
  #queue: Array<Record<string, unknown> | undefined> = []
  #waiting: Array<(message: Record<string, unknown> | undefined) => void> = []
  #closed = false

  constructor(readonly socket: Socket) {
    const reader = new LineReader()
    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = reader.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const line of lines) this.#deliver(parseLine(line))
    })
    socket.on('close', () => {
      this.#closed = true
      for (const waiter of this.#waiting.splice(0)) waiter(undefined)
    })
    socket.on('error', () => undefined)
  }

  #deliver(message: Record<string, unknown> | undefined): void {
    const waiter = this.#waiting.shift()
    if (waiter) waiter(message)
    else this.#queue.push(message)
  }

  next(timeoutMs: number): Promise<Record<string, unknown> | undefined | 'timeout'> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift())
    if (this.#closed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#waiting.indexOf(done)
        if (index >= 0) this.#waiting.splice(index, 1)
        resolve('timeout')
      }, timeoutMs)
      const done = (message: Record<string, unknown> | undefined): void => {
        clearTimeout(timer)
        resolve(message)
      }
      this.#waiting.push(done)
    })
  }

  send(message: unknown): void {
    if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(message)}\n`)
  }
}

function open(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/**
 * Sends one request to the extension and returns its answer.
 *
 * Throws BrowserUnavailable whenever the extension cannot be reached, with the
 * cause and what helps. An answer from the extension that reports a problem,
 * such as no Proton tab, is returned as an answer: the extension is there.
 */
export async function askBrowser(request: BrowserRequest, options: AskOptions = {}): Promise<BrowserResponse> {
  let paths: BrowserPaths
  try {
    paths = options.paths ?? browserPaths()
  } catch (error) {
    if (error instanceof UnsupportedPlatform) throw new BrowserUnavailable('platform', error.message, [])
    throw error
  }
  const running = options.chromeRunning ?? (() => chromeRunning(paths.platform))

  const secret = readSecret(paths.secretFile)
  if (!secret) throw diagnose(paths, running())

  // The connector refuses a socket directory somebody else owns or others can
  // open; the server checks the same before it says anything there, so a name
  // taken first in /tmp is named as the cause rather than as a wrong secret.
  if (paths.platform !== 'win32') {
    const unsafe = unsafeDirectory(dirname(paths.socket))
    if (unsafe) {
      throw new BrowserUnavailable('unsafe-socket-dir', `The browser extension Proton MCP Helper cannot be reached safely: ${unsafe}`, [
        `Remove ${dirname(paths.socket)} if it is not yours, then reload the extension in chrome://extensions.`,
      ])
    }
  }

  let socket: Socket
  try {
    socket = await open(paths.socket)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ECONNREFUSED' && paths.platform !== 'win32') {
      throw new BrowserUnavailable(
        'connector-stale',
        'The browser extension Proton MCP Helper is not active: its connector stopped without ' +
          'closing its socket.',
        [RELOAD_EXTENSION, 'If that does not help, restart Chrome.'],
      )
    }
    throw diagnose(paths, running())
  }

  const conversation = new Conversation(socket)
  try {
    const hello = await conversation.next(3000)
    if (hello === 'timeout' || !hello || hello.type !== 'hello' || !isNonce(hello.nonce)) {
      throw new BrowserUnavailable(
        'connector-stale',
        'The browser extension Proton MCP Helper is not active: something answers on its ' +
          'socket, but not the way its connector does.',
        [RELOAD_EXTENSION, `If that does not help, run the setup again: ${SETUP_COMMAND}`],
      )
    }
    if (hello.version !== PROTOCOL_VERSION) {
      throw new BrowserUnavailable(
        'connector-outdated',
        `The browser extension's connector speaks version ${String(hello.version)} of the channel and this server ` +
          `version ${PROTOCOL_VERSION}, so they cannot work together.`,
        [`Run the setup again: ${SETUP_COMMAND}`, 'Update the extension to the release that matches this server.', RELOAD_EXTENSION],
      )
    }

    const mine = newNonce()
    conversation.send({ type: 'auth', proof: proof(secret, 'client', hello.nonce), nonce: mine })
    const ready = await conversation.next(3000)
    if (ready === 'timeout' || !ready || ready.type !== 'ready' || !proofMatches(secret, 'host', mine, ready.proof)) {
      throw new BrowserUnavailable(
        'secret-mismatch',
        'The browser extension is running, but its connector and this server do not share the same secret. ' +
          'That happens when the setup ran again after Chrome started the connector.',
        [RELOAD_EXTENSION, `If that does not help, run the setup again: ${SETUP_COMMAND}`],
      )
    }

    const id = randomUUID()
    conversation.send({ type: 'request', id, body: request })
    const timeoutMs = options.timeoutMs ?? 90_000
    for (;;) {
      const message = await conversation.next(timeoutMs)
      if (message === 'timeout' || message === undefined) {
        throw new BrowserUnavailable(
          'no-answer',
          'The browser extension did not answer in time. It may still carry out the request, so look ' +
            'with list_filters before asking for it again.',
          ['Check that Chrome is not stuck.', RELOAD_EXTENSION],
        )
      }
      if (message.type !== 'response' || message.id !== id) continue
      const body = parseResponse(message.body)
      if (!body) {
        return { ok: false, error: 'internal', message: 'The extension answered in a shape this server does not know.' }
      }
      return body
    }
  } finally {
    socket.destroy()
  }
}
