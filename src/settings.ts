/**
 * Settings the user can change while the server runs.
 *
 * Only the Bridge ports, and that is the whole point of the file: the Bridge
 * lets you change them, they are the setting most likely to be wrong, and
 * getting them wrong looks exactly like a Bridge that is not running. Editing an
 * environment variable in a client's configuration and restarting is a poor way
 * to find that out.
 *
 * **The host is deliberately not settable here.** It stays with the environment,
 * where changing it is a conscious act. A host field in a web form is a field
 * that sends the Bridge password to another machine, and no convenience is worth
 * that.
 *
 * The environment still wins. Someone who set BRIDGE_IMAP_PORT explicitly meant
 * it, and having a stored value silently override it would make their setting a
 * lie.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface StoredSettings {
  imapPort?: number
  smtpPort?: number
  /**
   * Whether the "not affiliated with Proton" notice was sent away.
   *
   * Kept here rather than in the browser because there is no JavaScript in the
   * interface to write a cookie, and because a setting the server holds is the
   * same setting in every browser. It only ever hides the paragraph: the
   * `unofficial` mark beside the name stays whatever this says.
   */
  noticeDismissed?: boolean
}

/** Where the settings live. Next to the credentials, under the user's own data. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROTON_MCP_SETTINGS_FILE) return env.PROTON_MCP_SETTINGS_FILE
  return join(homedir(), '.config', 'proton-mcp', 'settings.json')
}

/** True for something that can be an IMAP or SMTP port. */
export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * Reads the stored settings.
 *
 * A missing, unreadable or broken file yields no settings rather than an error:
 * these are conveniences, and none of them is worth refusing to start over.
 * Values that are not ports are dropped individually, so one bad entry does not
 * discard a good one.
 */
export async function loadSettings(path = settingsPath()): Promise<StoredSettings> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}

  const candidate = parsed as Record<string, unknown>
  const settings: StoredSettings = {}
  if (isPort(candidate.imapPort)) settings.imapPort = candidate.imapPort
  if (isPort(candidate.smtpPort)) settings.smtpPort = candidate.smtpPort
  // Only a literal true hides it. Anything else, including a string "true" from
  // a hand-edited file, leaves the notice where it is.
  if (candidate.noticeDismissed === true) settings.noticeDismissed = true
  return settings
}

/**
 * Writes the settings.
 *
 * Mode 600 like everything else this server puts on disk. Port numbers are not
 * secret, but a directory of mixed permissions is how the file that does matter
 * ends up readable one day.
 */
export async function saveSettings(
  settings: StoredSettings,
  path = settingsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}
