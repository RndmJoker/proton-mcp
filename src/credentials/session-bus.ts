/**
 * Which store "System keyring" means on Linux, and making it the desktop's.
 *
 * @napi-rs/keyring picks its store from one variable. Measured on 2026-11-02
 * with version 1.3.0 under KDE Plasma: with DBUS_SESSION_BUS_ADDRESS set, an
 * entry goes to the Secret Service, which is GNOME Keyring or KWallet. Without
 * it, or with an address that leads nowhere, the entry goes to the kernel's
 * keyrings instead. Those live in memory: gone after a restart, and the
 * persistent one expires after days without use. Each process sees only its
 * own store, so a server started with the variable cannot remove what one
 * started without it stored, and the other way round.
 *
 * MCP clients leave the variable out unless told otherwise: the SDK passes on
 * HOME, LOGNAME, PATH, SHELL, TERM and USER and nothing else. So what "System
 * keyring" meant depended on how the client started this server. The address
 * is therefore supplied here when it is missing and the session has a bus in
 * the usual place, the way every desktop program finds it.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'

/** Where an entry ends up. "platform" is Keychain or Credential Manager. */
export type KeyringBackend = 'secret-service' | 'kernel' | 'platform'

export interface SessionBusOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  uid?: number
  /** Whether a path is a socket. Replaced in tests. */
  isSocket?: (path: string) => boolean
}

function socketAt(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

/** The path of a unix:path= address, if the address has one. */
function socketPath(address: string): string | undefined {
  return /(?:^|;)unix:(?:[^;]*,)?path=([^,;]+)/.exec(address)?.[1]
}

/**
 * Supplies DBUS_SESSION_BUS_ADDRESS when it is missing and a session bus is
 * there, and says which store the keyring library will use.
 *
 * Has to run before the library is loaded, and in every process that loads it:
 * the probe of the sign-in page runs in a child, which inherits what is set
 * here.
 */
export function prepareSessionBus(options: SessionBusOptions = {}): KeyringBackend {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) !== 'linux') return 'platform'
  const isSocket = options.isSocket ?? socketAt

  const given = env.DBUS_SESSION_BUS_ADDRESS
  if (given) {
    // An abstract or TCP address cannot be checked from here and is taken as
    // given. A path that is not there leads to the kernel, as measured.
    const path = socketPath(given)
    return path === undefined || isSocket(path) ? 'secret-service' : 'kernel'
  }

  const uid = options.uid ?? process.getuid?.()
  const candidates = [
    ...(env.XDG_RUNTIME_DIR ? [join(env.XDG_RUNTIME_DIR, 'bus')] : []),
    ...(uid !== undefined ? [`/run/user/${uid}/bus`] : []),
  ]
  const found = candidates.find((path) => isSocket(path))
  if (found === undefined) return 'kernel'
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${found}`
  return 'secret-service'
}

/** What the sign-in page says when the keyring is the kernel's. */
export const KERNEL_KEYRING_NOTE =
  'No desktop session was found, so the password would go to the kernel\'s keyring rather than to ' +
  'GNOME Keyring or KWallet. That keyring lives in memory only: the password is gone after a ' +
  'restart, and after a few days without use, three by default.'
