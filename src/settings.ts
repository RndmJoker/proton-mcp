/**
 * Settings the user can change while the server runs.
 *
 * One file for every running server. Each client session starts its own server,
 * and until 2026-11-05 a setting changed in one interface held for that one
 * server only. Now the interface has one fixed address, the first server to
 * start serves it, and every server watches this file, so a change applies to
 * all of them at once.
 *
 * What lives here: the Bridge ports, the PIN that guards changes, what the
 * assistant may do per tool and within which bounds, what a filter from it may
 * do beyond filing and flags, a recipient added to every message sent, and a
 * counter that tells every server to reread the stored credentials after a
 * sign-in or a sign-out somewhere else.
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

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { watch, mkdirSync, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { StoredPin } from './web/security.js'
import { UNLOCKABLE, type Unlockable } from './filters/sieve.js'

/** What the assistant may do with one tool. */
export type Level = 'off' | 'ask' | 'act'

/**
 * Bounds on sending without asking. Every one of them is optional, and a send
 * outside a bound asks rather than failing.
 */
export interface SendLimits {
  /** Addresses or domains (written as "@example.com") that may be sent to. */
  allowed?: string[]
  /** How many messages may go out without asking per rolling hour. */
  maxPerHour?: number
  /** The last day, YYYY-MM-DD, on which sending without asking applies. */
  until?: string
}

/** One recipient added to every message this server sends. */
export interface RecordCopy {
  address: string
  mode: 'cc' | 'bcc'
}

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
  /** The PIN every change in the interface asks for. Absent means none is set. */
  pin?: StoredPin
  /**
   * Raised by the server that showed the interface whenever somebody signed in
   * or out there. Every other server rereads the stored credentials when it
   * sees the number change.
   */
  credentialsGeneration?: number
  /** Per tool name, where it departs from the default. */
  levels?: Record<string, Level>
  limits?: SendLimits
  record?: RecordCopy
  /** What a filter from an assistant may do beyond filing and flags. Absent means nothing more. */
  filterActions?: Unlockable[]
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

const LEVELS = new Set<string>(['off', 'ask', 'act'])
const TOOL_NAME = /^[a-z][a-z_]{1,63}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Keeps what has the right shape and drops the rest, field by field.
 *
 * Exported for the tests and for anything that receives settings from
 * somewhere other than this file. Whether a tool name exists is not decided
 * here: an entry for a tool a later version removed must not break the file.
 */
export function sanitise(candidate: Record<string, unknown>): StoredSettings {
  const settings: StoredSettings = {}
  if (isPort(candidate.imapPort)) settings.imapPort = candidate.imapPort
  if (isPort(candidate.smtpPort)) settings.smtpPort = candidate.smtpPort
  // Only a literal true hides it. Anything else, including a string "true" from
  // a hand-edited file, leaves the notice where it is.
  if (candidate.noticeDismissed === true) settings.noticeDismissed = true

  const pin = candidate.pin as Record<string, unknown> | undefined
  if (pin && typeof pin.salt === 'string' && typeof pin.hash === 'string' && pin.salt && pin.hash) {
    settings.pin = { salt: pin.salt, hash: pin.hash }
  }

  const generation = candidate.credentialsGeneration
  if (typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0) {
    settings.credentialsGeneration = generation
  }

  if (typeof candidate.levels === 'object' && candidate.levels !== null) {
    const levels: Record<string, Level> = {}
    for (const [tool, level] of Object.entries(candidate.levels)) {
      if (TOOL_NAME.test(tool) && typeof level === 'string' && LEVELS.has(level)) {
        levels[tool] = level as Level
      }
    }
    if (Object.keys(levels).length > 0) settings.levels = levels
  }

  if (typeof candidate.limits === 'object' && candidate.limits !== null) {
    const raw = candidate.limits as Record<string, unknown>
    const limits: SendLimits = {}
    if (Array.isArray(raw.allowed)) {
      const allowed = raw.allowed.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length < 255,
      )
      if (allowed.length > 0) limits.allowed = allowed
    }
    if (typeof raw.maxPerHour === 'number' && Number.isInteger(raw.maxPerHour) && raw.maxPerHour > 0) {
      limits.maxPerHour = raw.maxPerHour
    }
    if (typeof raw.until === 'string' && DAY.test(raw.until)) limits.until = raw.until
    if (Object.keys(limits).length > 0) settings.limits = limits
  }

  const record = candidate.record as Record<string, unknown> | undefined
  if (
    record &&
    typeof record.address === 'string' &&
    record.address.length > 0 &&
    (record.mode === 'cc' || record.mode === 'bcc')
  ) {
    settings.record = { address: record.address, mode: record.mode }
  }

  // Names a later version no longer knows are dropped, one by one.
  if (Array.isArray(candidate.filterActions)) {
    const known = UNLOCKABLE.filter((action) => (candidate.filterActions as unknown[]).includes(action))
    if (known.length > 0) settings.filterActions = known
  }

  return settings
}

/**
 * Reads the stored settings.
 *
 * A missing, unreadable or broken file yields no settings rather than an error:
 * none of them is worth refusing to start over, and every one has a default
 * that is today's behaviour. Values of the wrong shape are dropped
 * individually, so one bad entry does not discard a good one.
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
  return sanitise(parsed as Record<string, unknown>)
}

/**
 * Writes the settings.
 *
 * Mode 600 like everything else this server puts on disk: the file holds the
 * hash of the PIN now, and a directory of mixed permissions is how the file that
 * does matter ends up readable one day.
 *
 * Written to a neighbouring file and renamed into place, because several
 * servers read this file whenever it changes. A rename is atomic on the same
 * file system, so a reader sees the old settings or the new ones and never half
 * of each.
 */
export async function saveSettings(
  settings: StoredSettings,
  path = settingsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Changes some settings and keeps the rest as they are on disk.
 *
 * Reads first rather than writing a copy held in memory: another server may
 * have written since, and the copy would quietly undo that.
 */
export async function updateSettings(
  change: (current: StoredSettings) => StoredSettings,
  path = settingsPath(),
): Promise<StoredSettings> {
  const next = change(await loadSettings(path))
  await saveSettings(next, path)
  return next
}

/**
 * Calls `onChange` with the settings whenever the file changes.
 *
 * Watches the directory rather than the file, because the file is replaced by a
 * rename on every write, and a watch on the old file would see nothing after
 * the first change. Bursts are collected for a moment so one write leads to one
 * call. Returns a function that stops watching.
 */
export function watchSettings(
  onChange: (settings: StoredSettings) => void,
  path = settingsPath(),
  delayMs = 100,
): () => void {
  let watcher: FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined
  const name = basename(path)

  const reload = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void loadSettings(path).then(onChange)
    }, delayMs)
    timer.unref()
  }

  try {
    // Created here when missing, or the watch would have nothing to attach to
    // and the first save by another server would go unnoticed.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    watcher = watch(dirname(path), { persistent: false }, (_event, file) => {
      // Some platforms leave the name out. Rereading then costs one read.
      if (file === null || file === name) reload()
    })
    watcher.on('error', () => {
      // A directory that disappears ends the watch. The settings in memory stay
      // as they were, which is the same as nobody having changed anything.
    })
  } catch {
    // Not watchable on this system. Settings then apply to the server that
    // showed the interface and to every server started afterwards.
  }

  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}
