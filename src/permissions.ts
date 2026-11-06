/**
 * What the assistant may do, tool by tool.
 *
 * Three levels, decided per tool by the user:
 *
 * - `off`: the tool does not exist as far as the assistant is concerned. It is
 *   taken out of the list the client sees, and a call that arrives anyway is
 *   refused with the name of the setting that refused it.
 * - `ask`: the tool runs only after the person agrees through the client. Every
 *   sending tool works this way by default, and so does proposing a filter.
 * - `act`: the tool runs without asking. Every other tool works this way by
 *   default.
 *
 * The defaults are exactly the behaviour before this file existed, so nothing
 * changes on an upgrade. Only the tools that can ask at all offer `ask`: for a
 * tool that reads, a question before every call would be noise nobody reads.
 *
 * ## Who decides
 *
 * The environment first, then the interface, then the default. An environment
 * variable is set where the server is registered with the client, which takes
 * a person editing that configuration; the interface takes a PIN once the user
 * sets one, and without a PIN anything on the machine can change it, the
 * assistant included. Both are said where they are set.
 *
 * ## Sending without asking
 *
 * When a sending tool acts on its own, three optional bounds apply, and a send
 * outside any of them asks instead of failing: permitted recipients or domains,
 * a maximum per rolling hour, and a last day. A bound turns a mistake or a
 * crafted message into a question rather than into mail that has left.
 */

import type { Level, SendLimits, StoredSettings } from './settings.js'
import { UNLOCKABLE, NO_UNLOCKS, type Unlockable } from './filters/sieve.js'

/** The tools in each group, as they are named to the client. */
export const GROUPS = {
  reading: [
    'list_folders',
    'list_messages',
    'search_messages',
    'get_message',
    'get_attachment',
    'list_drafts',
    'manage_filters',
    'list_filters',
    'get_filters',
  ],
  filing: ['add_label', 'remove_label', 'move_messages', 'set_flags', 'trash_messages'],
  writing: [
    'create_draft',
    'update_draft',
    'reply_draft',
    'forward_draft',
    'save_attachment',
    'delete_saved_attachments',
  ],
  sending: ['send_message', 'send_reply', 'send_forward', 'send_draft'],
  filters: ['propose_filter', 'apply_filter', 'reorder_filters', 'delete_filter', 'set_filter_status'],
} as const

export type Group = keyof typeof GROUPS

/** Tools that are always there: the way to the interface, and the update check. */
export const ALWAYS = new Set(['open_configuration', 'check_for_updates'])

/** Every tool a level can be set for, in a stable order. */
export const CONTROLLED: readonly string[] = Object.values(GROUPS).flat()

const GROUP_OF = new Map<string, Group>(
  (Object.entries(GROUPS) as Array<[Group, readonly string[]]>).flatMap(([group, tools]) =>
    tools.map((tool) => [tool, group] as const),
  ),
)

/** The tools that can ask first: the ones whose effect leaves this machine or outlives the session. */
export function canAsk(tool: string): boolean {
  const group = GROUP_OF.get(tool)
  return group === 'sending' || group === 'filters'
}

/** Groups whose tools change something. Read-only mode switches all of them off. */
const CHANGING: ReadonlySet<Group> = new Set(['filing', 'writing', 'sending', 'filters'])

/**
 * Tools that are off until the user switches them on: deleting a filter and
 * switching one on or off. Both were left out of #59 at first, and came in on
 * Tobi's word of 06.11.2026 that the user decides, with today's behaviour as
 * the default.
 */
const OFF_BY_DEFAULT: ReadonlySet<string> = new Set(['delete_filter', 'set_filter_status'])

export function defaultLevel(tool: string): Level {
  if (OFF_BY_DEFAULT.has(tool)) return 'off'
  return canAsk(tool) ? 'ask' : 'act'
}

/** Which levels a tool offers. */
export function levelsFor(tool: string): Level[] {
  return canAsk(tool) ? ['off', 'ask', 'act'] : ['off', 'act']
}

/** Where a tool's level comes from, so the interface and the answers can say. */
export type LevelSource = 'environment' | 'read-only' | 'interface' | 'default'

/** A configuration that cannot be honoured. The server refuses to start rather than guess. */
export class PermissionsError extends Error {}

const ENV_LISTS: Array<[string, Level]> = [
  ['PROTON_MCP_OFF', 'off'],
  ['PROTON_MCP_ASK_FIRST', 'ask'],
  ['PROTON_MCP_ACT_ON_ITS_OWN', 'act'],
]

/** Splits a list written with commas, spaces or both. */
function entries(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * Reads the three lists from the environment.
 *
 * A tool named on its own wins over a group it belongs to, so that "every
 * sending tool acts on its own, but send_forward asks" can be written as
 * exactly that. Every real contradiction is fatal: an unknown name, the same
 * tool or the same group in two lists, or `ask` for a tool that cannot ask. A
 * server that guessed would run with permissions nobody chose, and the place to
 * find out is the start, not the first send.
 */
export function levelsFromEnvironment(env: NodeJS.ProcessEnv = process.env): Map<string, Level> {
  const fromGroups = new Map<string, Level>()
  const fromTools = new Map<string, Level>()
  const groupNamedIn = new Map<string, string>()
  const toolNamedIn = new Map<string, string>()

  const check = (variable: string, level: Level, tool: string, how: string): void => {
    if (level === 'ask' && !canAsk(tool)) {
      throw new PermissionsError(
        `${variable} names ${how}, and ${tool} cannot ask first: only the sending tools and the filter ` +
          'tools that change something can. Use PROTON_MCP_OFF or PROTON_MCP_ACT_ON_ITS_OWN for it.',
      )
    }
  }

  for (const [variable, level] of ENV_LISTS) {
    for (const entry of entries(env[variable])) {
      if (entry in GROUPS) {
        const earlier = groupNamedIn.get(entry)
        if (earlier && earlier !== variable) {
          throw new PermissionsError(`The group ${entry} is named in both ${earlier} and ${variable}.`)
        }
        groupNamedIn.set(entry, variable)
        for (const tool of GROUPS[entry as Group]) {
          check(variable, level, tool, `the group ${entry}`)
          fromGroups.set(tool, level)
        }
        continue
      }
      if (!GROUP_OF.has(entry)) {
        const always = ALWAYS.has(entry) ? ' It is always available and has no level.' : ''
        throw new PermissionsError(
          `${variable} names "${entry}", which is neither a tool nor a group.${always} Groups are ` +
            `${Object.keys(GROUPS).join(', ')}.`,
        )
      }
      const earlier = toolNamedIn.get(entry)
      if (earlier && earlier !== variable) {
        throw new PermissionsError(
          `${entry} is named in both ${earlier} and ${variable}. Each tool may appear in one of them only.`,
        )
      }
      check(variable, level, entry, entry)
      toolNamedIn.set(entry, variable)
      fromTools.set(entry, level)
    }
  }
  return new Map([...fromGroups, ...fromTools])
}

/** The bounds from the environment, each one only when set. */
export function limitsFromEnvironment(env: NodeJS.ProcessEnv = process.env): SendLimits {
  const limits: SendLimits = {}
  const allowed = entries(env.PROTON_MCP_SEND_ALLOWED)
  if (allowed.length > 0) limits.allowed = allowed

  const max = env.PROTON_MCP_SEND_MAX_PER_HOUR?.trim()
  if (max) {
    const value = Number(max)
    if (!Number.isInteger(value) || value < 1) {
      throw new PermissionsError(
        `PROTON_MCP_SEND_MAX_PER_HOUR is "${max}", which is not a whole number of at least 1.`,
      )
    }
    limits.maxPerHour = value
  }

  const until = env.PROTON_MCP_ACT_UNTIL?.trim()
  if (until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(`${until}T00:00:00Z`))) {
      throw new PermissionsError(`PROTON_MCP_ACT_UNTIL is "${until}", which is not a day written YYYY-MM-DD.`)
    }
    limits.until = until
  }
  return limits
}

/**
 * What a filter may do beyond filing and flags, from PROTON_MCP_FILTER_ACTIONS,
 * or nothing when it is not set. An unknown name stops the start, like an
 * unknown tool: a typo must not quietly allow less, or more, than was meant.
 */
export function unlocksFromEnvironment(env: NodeJS.ProcessEnv = process.env): Unlockable[] | undefined {
  const raw = env.PROTON_MCP_FILTER_ACTIONS
  if (raw === undefined || raw.trim() === '') return undefined
  const named = entries(raw)
  if (named.length === 1 && named[0] === 'none') return []
  const unknown = named.find((entry) => !(UNLOCKABLE as readonly string[]).includes(entry))
  if (unknown) {
    throw new PermissionsError(
      `PROTON_MCP_FILTER_ACTIONS names "${unknown}", which is not an action a filter can be allowed. ` +
        `They are ${UNLOCKABLE.join(', ')}, or none.`,
    )
  }
  return [...new Set(named as Unlockable[])]
}

/** Whether a recipient address matches an entry of the permitted list. */
export function permitted(address: string, allowed: readonly string[]): boolean {
  const candidate = address.trim().toLowerCase()
  const domain = candidate.slice(candidate.lastIndexOf('@'))
  return allowed.some((entry) => {
    const rule = entry.trim().toLowerCase()
    return rule.startsWith('@') ? domain === rule : candidate === rule
  })
}

/** The local calendar day of a moment, YYYY-MM-DD, which is how the last day is written. */
function day(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export interface PermissionsOptions {
  env?: NodeJS.ProcessEnv
  /** The shared settings as they are now. Read on every question, never cached. */
  settings: () => StoredSettings
  /** PROTON_MCP_READ_ONLY. */
  readOnly: boolean
  clock?: () => number
}

/** Why a send that may act on its own still asks. Nothing means it may go. */
export type HoldBack = { reason: string } | undefined

export class Permissions {
  readonly #fromEnv: Map<string, Level>
  readonly #limitsFromEnv: SendLimits
  readonly #unlocksFromEnv: Unlockable[] | undefined
  readonly #settings: () => StoredSettings
  readonly #readOnly: boolean
  readonly #clock: () => number
  /** When each send without asking went out, for the hourly bound. This server only. */
  #sent: number[] = []

  constructor(options: PermissionsOptions) {
    const env = options.env ?? process.env
    this.#fromEnv = levelsFromEnvironment(env)
    this.#limitsFromEnv = limitsFromEnvironment(env)
    this.#unlocksFromEnv = unlocksFromEnvironment(env)
    this.#settings = options.settings
    this.#readOnly = options.readOnly
    this.#clock = options.clock ?? Date.now
  }

  /**
   * Where the level of a tool comes from.
   *
   * Read-only mode first: it is the strongest thing a user can say, and the
   * mail layer refuses every change under it anyway, so a level claiming
   * otherwise would only mislead.
   */
  source(tool: string): LevelSource {
    const group = GROUP_OF.get(tool)
    if (this.#readOnly && group && CHANGING.has(group)) return 'read-only'
    if (this.#fromEnv.has(tool)) return 'environment'
    if (this.#settings().levels?.[tool] !== undefined) return 'interface'
    return 'default'
  }

  /** The level in force for a tool right now. */
  level(tool: string): Level {
    if (ALWAYS.has(tool) || !GROUP_OF.has(tool)) return 'act'
    const group = GROUP_OF.get(tool)!
    if (this.#readOnly && CHANGING.has(group)) return 'off'
    const fromEnv = this.#fromEnv.get(tool)
    if (fromEnv) return fromEnv
    const chosen = this.#settings().levels?.[tool]
    if (chosen && levelsFor(tool).includes(chosen)) return chosen
    return defaultLevel(tool)
  }

  /** The bounds in force: each one from the environment when set there, else from the interface. */
  limits(): SendLimits {
    const stored = this.#settings().limits ?? {}
    const limits: SendLimits = {}
    const allowed = this.#limitsFromEnv.allowed ?? stored.allowed
    const maxPerHour = this.#limitsFromEnv.maxPerHour ?? stored.maxPerHour
    const until = this.#limitsFromEnv.until ?? stored.until
    if (allowed) limits.allowed = allowed
    if (maxPerHour !== undefined) limits.maxPerHour = maxPerHour
    if (until) limits.until = until
    return limits
  }

  /** Which bounds the environment fixed, so the interface shows them as fixed. */
  limitsFixed(): { allowed: boolean; maxPerHour: boolean; until: boolean } {
    return {
      allowed: this.#limitsFromEnv.allowed !== undefined,
      maxPerHour: this.#limitsFromEnv.maxPerHour !== undefined,
      until: this.#limitsFromEnv.until !== undefined,
    }
  }

  /**
   * What a filter may do beyond filing and flags: from the environment when
   * set there, else from the interface. Nothing by default. The extension has
   * the same switches in its popup, and an action needs both.
   */
  unlocks(): ReadonlySet<Unlockable> {
    if (this.#readOnly) return NO_UNLOCKS
    const chosen = this.#unlocksFromEnv ?? this.#settings().filterActions ?? []
    return new Set(UNLOCKABLE.filter((action) => chosen.includes(action)))
  }

  /** Whether the environment fixed what filters may do, so the interface shows it as fixed. */
  unlocksFixed(): boolean {
    return this.#unlocksFromEnv !== undefined
  }

  /** Where to change what filters may do, for answers that refuse. */
  unlocksWhere(): string {
    return this.#unlocksFromEnv !== undefined
      ? 'set in the environment of this server (PROTON_MCP_FILTER_ACTIONS)'
      : 'on the Permissions page of the local interface'
  }

  /** Every tool whose level departs from the default, for the status line and the overview. */
  departures(): Array<{ tool: string; level: Level; source: LevelSource }> {
    return CONTROLLED.filter((tool) => this.level(tool) !== defaultLevel(tool)).map((tool) => ({
      tool,
      level: this.level(tool),
      source: this.source(tool),
    }))
  }

  /**
   * Whether a send at level `act` may go without asking, given its recipients.
   *
   * Returns the bound that holds it back, or nothing. Checked in the order a
   * person would care about: the last day, the recipients, then the count.
   */
  holdBack(recipients: readonly string[]): HoldBack {
    const limits = this.limits()
    const now = this.#clock()
    if (limits.until && day(new Date(now)) > limits.until) {
      return { reason: `sending without asking ended after ${limits.until}` }
    }
    if (limits.allowed) {
      const outside = recipients.filter((address) => !permitted(address, limits.allowed!))
      if (outside.length > 0) {
        return { reason: `not every recipient is on the permitted list (${outside.join(', ')})` }
      }
    }
    if (limits.maxPerHour !== undefined) {
      this.#sent = this.#sent.filter((at) => now - at < 3_600_000)
      if (this.#sent.length >= limits.maxPerHour) {
        return { reason: `${limits.maxPerHour} messages already went out without asking within the hour` }
      }
    }
    return undefined
  }

  /** Records a send that went out without asking, for the hourly bound. */
  recordSent(): void {
    this.#sent.push(this.#clock())
  }

  /** Where to change a tool's level, for answers that refuse or act on their own. */
  where(tool: string): string {
    switch (this.source(tool)) {
      case 'environment':
        return 'set in the environment of this server (PROTON_MCP_OFF, PROTON_MCP_ASK_FIRST or PROTON_MCP_ACT_ON_ITS_OWN)'
      case 'read-only':
        return 'set by PROTON_MCP_READ_ONLY'
      case 'interface':
        return 'set on the Permissions page of the local interface'
      default:
        return 'the default'
    }
  }
}
