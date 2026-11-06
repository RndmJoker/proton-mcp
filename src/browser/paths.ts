/**
 * Where everything belonging to the browser channel lives (#59).
 *
 * Two processes have to agree on these paths without talking first: this
 * server, started by an assistant with a reduced environment, and the connector,
 * started by Chrome with the desktop's environment. So the paths depend on the
 * home directory and the user, never on variables like XDG_RUNTIME_DIR or
 * TMPDIR that one of the two may not have. The MCP SDK passes a server only
 * HOME, LOGNAME, PATH, SHELL, TERM and USER, measured on 02.11.2026.
 *
 * This file is copied next to the connector by the setup, so it imports nothing
 * but Node and the message list.
 */

import { homedir, platform as currentPlatform, userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { HOST_NAME } from './messages.js'

export type BrowserPlatform = 'linux' | 'darwin' | 'win32'

export interface BrowserPaths {
  platform: BrowserPlatform
  /** ~/.config/proton-mcp, the same directory the settings live in. */
  configDir: string
  /** Everything of the channel: the secret, the connector, the manifest on Windows. */
  browserDir: string
  /** The secret both ends prove they know. Written by the setup, readable by the user only. */
  secretFile: string
  /** The connector's own copy of its code, so it does not depend on an npx cache. */
  hostDir: string
  hostScript: string
  /** What Chrome starts: a script that runs the connector with the Node the setup ran under. */
  launcher: string
  /** The socket file, or on Windows the named pipe. */
  socket: string
  /** Where Chrome looks for the manifest that names the connector. */
  manifestFile: string
  /** On Windows, the registry key that points Chrome at the manifest. */
  registryKey?: string
}

/**
 * Longest socket path used before falling back to a short one. Linux allows
 * 107 bytes and macOS 103; longer paths fail with an error that names neither.
 */
export const MAX_SOCKET_PATH = 100

export interface PathOptions {
  env?: NodeJS.ProcessEnv
  platform?: string
  home?: string
  uid?: number
  user?: string
}

/** Turns an unsupported platform into a clear statement instead of a wrong path. */
export class UnsupportedPlatform extends Error {}

export function browserPlatform(name: string = currentPlatform()): BrowserPlatform {
  if (name === 'linux' || name === 'darwin' || name === 'win32') return name
  throw new UnsupportedPlatform(
    `The browser extension's connector is available on Linux, macOS and Windows, not on ${name}.`,
  )
}

export function browserPaths(options: PathOptions = {}): BrowserPaths {
  const env = options.env ?? process.env
  const platform = browserPlatform(options.platform)
  const path = platform === 'win32' ? win32 : posix
  const home = options.home ?? homedir()
  const configDir = path.join(home, '.config', 'proton-mcp')
  const browserDir = path.join(configDir, 'browser')
  const hostDir = path.join(browserDir, 'host')
  const launcher = path.join(hostDir, platform === 'win32' ? 'proton-mcp-browser-host.cmd' : 'proton-mcp-browser-host')

  let socket = env.PROTON_MCP_BROWSER_SOCKET?.trim()
  if (!socket) {
    if (platform === 'win32') {
      // Pipe names are global on a machine, so the user is part of the name,
      // with a short hash of it: two names that differ only in a letter a
      // pipe name cannot hold, such as an umlaut, would get the same name
      // otherwise. Node leaves the pipe's permissions at Windows' default,
      // which gives the creator, SYSTEM and administrators full access and
      // everyone else read access; a reader gets the greeting and nothing
      // more, since the secret itself never crosses the pipe.
      const raw = options.user ?? safeUserName()
      const user = raw.replace(/[^A-Za-z0-9_.-]/g, '_')
      const tag = createHash('sha256').update(raw).digest('hex').slice(0, 8)
      socket = `\\\\.\\pipe\\proton-mcp-browser-${user}-${tag}`
    } else {
      socket = path.join(configDir, 'run', 'browser.sock')
      if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
        // A fixed /tmp rather than os.tmpdir(): TMPDIR differs between the
        // two processes on macOS. The directory is checked before use, since
        // anyone can create a name in /tmp first.
        socket = path.join('/tmp', `proton-mcp-${options.uid ?? process.getuid?.() ?? 0}`, 'browser.sock')
      }
    }
  }

  const manifestName = `${HOST_NAME}.json`
  const manifestFile =
    platform === 'linux'
      ? path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', manifestName)
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', manifestName)
        : path.join(browserDir, manifestName)

  return {
    platform,
    configDir,
    browserDir,
    secretFile: path.join(browserDir, 'secret'),
    hostDir,
    hostScript: path.join(hostDir, 'connector.js'),
    launcher,
    socket,
    manifestFile,
    ...(platform === 'win32' ? { registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}` } : {}),
  }
}

function safeUserName(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'user'
  }
}
