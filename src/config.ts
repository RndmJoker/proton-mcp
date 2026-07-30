/**
 * Configuration from environment variables and from a credentials file.
 *
 * The Bridge's ports are configurable in the Bridge itself, so they are never
 * hard-coded anywhere.
 *
 * Why a file at all: an AI client stores the environment it passes to a server
 * in its own configuration, in plain text, and reads it on every start. Keeping
 * the Bridge password out of there is worth a little machinery. A file outside
 * the repository with mode 600 keeps it out of there, and it works the same on
 * every platform, unlike a wrapper script.
 *
 * This is a stopgap. The real answer is signing in through the local web
 * interface, tracked in #16 and #17, after which this path goes away (#18).
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export interface Config {
  /** Address of the Bridge, in practice always 127.0.0.1. */
  host: string
  /**
   * The Bridge's IMAP port.
   *
   * Changeable while the server runs, through the web interface. The one
   * configuration object is shared with the Connection, which reads it on every
   * reconnect, so writing here and closing the connection is all it takes. See
   * settings.ts for why this one setting is worth that.
   */
  imapPort: number
  smtpPort: number
  /** When true, every modifying operation is blocked. */
  readOnly: boolean
  /** Port for the local web interface. Fixed for the life of the process. */
  webPort: number
}

/** Credentials, whether they come from the environment or from a store. */
export interface BridgeCredentials {
  user: string
  pass: string
}

/** Thrown when the configuration is unusable. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** Where the credentials file is looked for. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROTON_MCP_ENV_FILE) return env.PROTON_MCP_ENV_FILE
  return join(homedir(), '.config', 'proton-mcp', 'env')
}

/**
 * Parses a file of `KEY=value` lines.
 *
 * Comments and blank lines are ignored. Values are taken literally apart from
 * one layer of surrounding quotes, because a Bridge password can contain
 * characters that would otherwise invite guessing games.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Warns when a credentials file is readable by others.
 *
 * A warning rather than a refusal: on Windows the POSIX bits carry no meaning,
 * and refusing to start over a file mode would be a poor trade for someone who
 * knows what their setup looks like.
 */
export function permissionWarning(mode: number): string | undefined {
  // Anything set in the group or other bits.
  if ((mode & 0o077) === 0) return undefined
  return (
    `the file is readable by other users (mode ${(mode & 0o777).toString(8)}). ` +
    'Restrict it with: chmod 600 <file>'
  )
}

/** Reads the credentials file if there is one. Absence is not an error. */
function readCredentialsFile(
  path: string,
  onWarning: (message: string) => void,
): Record<string, string> {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    // No file, unreadable, whatever: fall back to the environment.
    return {}
  }

  if (platform() !== 'win32') {
    try {
      const warning = permissionWarning(statSync(path).mode)
      if (warning) onWarning(`${path}: ${warning}`)
    } catch {
      // Not being able to stat a file we just read is not worth failing over.
    }
  }

  return parseEnvFile(content)
}

function port(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(
      `${field} is "${value}", which is not a valid port number. Expected a whole number between 1 and 65535.`,
    )
  }
  return n
}

export interface LoadOptions {
  /** Where warnings go. Defaults to stderr, never stdout, which carries the protocol. */
  onWarning?: (message: string) => void
  /** Skips the credentials file. Used by tests. */
  skipFile?: boolean
}

/**
 * Reads the configuration.
 *
 * Credentials are no longer part of this: they can arrive through the web
 * interface at any time, so a missing password is not a configuration error and
 * must not stop the server from starting. See session.ts.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.BRIDGE_HOST?.trim() || '127.0.0.1',
    imapPort: port(env.BRIDGE_IMAP_PORT, 1143, 'BRIDGE_IMAP_PORT'),
    smtpPort: port(env.BRIDGE_SMTP_PORT, 1025, 'BRIDGE_SMTP_PORT'),
    readOnly: env.PROTON_MCP_READ_ONLY === 'true',
    webPort: port(env.PROTON_MCP_WEB_PORT, 7345, 'PROTON_MCP_WEB_PORT'),
  }
}

/**
 * Which ports the user set themselves.
 *
 * Stored settings must not override an explicit environment variable: someone
 * who set BRIDGE_IMAP_PORT meant it, and having a saved value quietly win would
 * make their setting a lie that is very hard to spot.
 */
export function portsSetExplicitly(
  env: NodeJS.ProcessEnv = process.env,
): { imapPort: boolean; smtpPort: boolean } {
  return {
    imapPort: Boolean(env.BRIDGE_IMAP_PORT?.trim()),
    smtpPort: Boolean(env.BRIDGE_SMTP_PORT?.trim()),
  }
}

/**
 * Credentials from the environment, if they are there.
 *
 * Only the environment: the file is read by the plain-file store, which is one
 * of the four the user can choose from.
 */
export function credentialsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): BridgeCredentials | undefined {
  const user = env.BRIDGE_USER?.trim()
  const pass = env.BRIDGE_PASS
  if (!user || !pass) return undefined
  return { user, pass }
}
