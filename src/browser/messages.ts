/**
 * What the server, the connector and the browser extension may say to each other
 * (#59).
 *
 * Three programs pass messages along: this server asks, the connector Chrome
 * starts relays, and the extension does the work in the signed-in Proton page.
 * Each of them checks every message against the fixed list below and drops
 * anything else, so a program that reaches one of the channels can ask for
 * nothing beyond these five things. Unknown fields are refused rather than
 * ignored: a field nobody reads today is one somebody may read tomorrow.
 *
 * The limits here are about shape, not about what is allowed. Whether a script
 * may be saved is decided by src/filters/sieve.ts, in this server and again in
 * the extension.
 *
 * Nothing from Node in here: the extension imports this file as well.
 */

/** The name Chrome knows the connector by. It has to match the host manifest. */
export const HOST_NAME = 'com.rndmjoker.proton_mcp'

/**
 * The id of the extension, fixed by the public key in its manifest.
 *
 * Chrome starts the connector only for the extensions its manifest names, and
 * the connector checks the origin Chrome hands it once more.
 */
export const EXTENSION_ID = 'nfmconelbflppeoolebhcckbmffiokkd'

/** Raised whenever a message changes shape, so an old connector and a new server notice each other. */
export const PROTOCOL_VERSION = 1

export interface FilterProposal {
  name: string
  sieve: string
  /** The id of the filter this one replaces. Absent for a new filter. */
  replaces?: string
  /**
   * Whether to apply it to the mail already there once it is saved. With a
   * question, this only ticks the box in the window, and the user decides.
   */
  apply?: boolean
}

/** One move of a filter in Proton's order: the filter and the position it ends up at, from 1. */
export interface FilterMoveRequest {
  id: string
  position: number
}

export type BrowserRequest =
  | { kind: 'status' }
  | { kind: 'list_filters'; account: string }
  | {
      kind: 'propose_filter'
      account: string
      proposal: FilterProposal
      confirm: boolean
      /** Whether applying to the mail already there may be offered at all: apply_filter is not switched off. */
      applyAllowed: boolean
    }
  | { kind: 'apply_filter'; account: string; filterId: string; confirm: boolean }
  | { kind: 'reorder_filters'; account: string; moves: FilterMoveRequest[]; confirm: boolean }

export interface ProtonFilter {
  id: string
  name: string
  enabled: boolean
  /** Proton runs filters in this order, lowest first. */
  order: number
  version: number
  sieve: string
}

export type BrowserErrorCode =
  | 'no-proton-tab'
  | 'signed-out'
  | 'wrong-account'
  | 'refused'
  | 'proton-error'
  | 'app-version'
  | 'not-found'
  | 'busy'
  | 'timeout'
  | 'internal'
  | 'unknown-request'

const ERROR_CODES: ReadonlySet<string> = new Set<BrowserErrorCode>([
  'no-proton-tab',
  'signed-out',
  'wrong-account',
  'refused',
  'proton-error',
  'app-version',
  'not-found',
  'busy',
  'timeout',
  'internal',
  'unknown-request',
])

/** An action waiting in the extension's queue because Proton was busy with an earlier one. */
export interface QueuedAction {
  action: 'save' | 'apply' | 'reorder'
  name: string
  /** When it was queued, in milliseconds since 1970. */
  since: number
  attempts: number
}

/** A change the extension made or was asked to make, as its popup lists them. */
export interface RecentChange {
  at: number
  name: string
  outcome: 'added' | 'replaced' | 'applied' | 'reordered' | 'rejected' | 'failed' | 'queued' | 'cancelled'
  how: 'confirmed' | 'without asking'
  detail?: string
}

const OUTCOMES: ReadonlySet<string> = new Set(['added', 'replaced', 'applied', 'reordered', 'rejected', 'failed', 'queued', 'cancelled'])

export type BrowserResponse =
  | { ok: true; kind: 'status'; extensionVersion: string; protonTabs: number }
  | { ok: true; kind: 'list_filters'; filters: ProtonFilter[]; queue?: QueuedAction[]; recent?: RecentChange[] }
  | {
      ok: true
      kind: 'propose_filter'
      outcome: 'shown' | 'added' | 'replaced' | 'queued'
      filterId?: string
      /** With a proposal to apply as well and no question: what became of applying it. */
      apply?: 'done' | 'queued' | 'failed' | 'shown'
    }
  | { ok: true; kind: 'apply_filter'; outcome: 'shown' | 'applied' | 'queued' }
  | { ok: true; kind: 'reorder_filters'; outcome: 'shown' | 'reordered' | 'queued' }
  | { ok: false; error: BrowserErrorCode; message: string }

/** Generous bounds on shape. The real limits on names and scripts are in sieve.ts. */
export const LIMITS = {
  account: 320,
  name: 1_000,
  /** Above the longest script sieve.ts takes, so a stored filter just over it can still be read. */
  sieve: 60_000,
  id: 256,
  message: 4_000,
  version: 64,
  filters: 1_000,
  moves: 50,
  queue: 100,
  recent: 50,
} as const

/** Proton's ids: base64 with - and _ and = padding. */
const FILTER_ID = /^[A-Za-z0-9_=-]+$/

type Plain = Record<string, unknown>

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

/** True when the object has exactly these keys, the optional ones allowed to be missing. */
function hasOnly(value: Plain, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}

function isText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0)
}

function isFilterId(value: unknown): value is string {
  return isText(value, LIMITS.id) && FILTER_ID.test(value)
}

function isAccount(value: unknown): value is string {
  return isText(value, LIMITS.account) && value.includes('@') && !/[\s<>"]/.test(value)
}

function parseMoves(value: unknown): FilterMoveRequest[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.moves) return undefined
  const moves: FilterMoveRequest[] = []
  for (const move of value) {
    if (!isPlain(move) || !hasOnly(move, ['id', 'position'])) return undefined
    if (!isFilterId(move.id) || !Number.isInteger(move.position) || (move.position as number) < 1 || (move.position as number) > 10_000) {
      return undefined
    }
    moves.push({ id: move.id, position: move.position as number })
  }
  return moves
}

/** A request as one of the five kinds, or nothing when it is anything else. */
export function parseRequest(value: unknown): BrowserRequest | undefined {
  if (!isPlain(value)) return undefined
  switch (value.kind) {
    case 'status':
      return hasOnly(value, ['kind']) ? { kind: 'status' } : undefined
    case 'list_filters':
      return hasOnly(value, ['kind', 'account']) && isAccount(value.account)
        ? { kind: 'list_filters', account: value.account }
        : undefined
    case 'propose_filter': {
      if (!hasOnly(value, ['kind', 'account', 'proposal', 'confirm', 'applyAllowed'])) return undefined
      if (!isAccount(value.account) || typeof value.confirm !== 'boolean' || typeof value.applyAllowed !== 'boolean') return undefined
      const proposal = value.proposal
      if (!isPlain(proposal) || !hasOnly(proposal, ['name', 'sieve'], ['replaces', 'apply'])) return undefined
      if (!isText(proposal.name, LIMITS.name) || !isText(proposal.sieve, LIMITS.sieve)) return undefined
      if (proposal.replaces !== undefined && !isFilterId(proposal.replaces)) return undefined
      if (proposal.apply !== undefined && typeof proposal.apply !== 'boolean') return undefined
      return {
        kind: 'propose_filter',
        account: value.account,
        confirm: value.confirm,
        applyAllowed: value.applyAllowed,
        proposal: {
          name: proposal.name,
          sieve: proposal.sieve,
          ...(proposal.replaces !== undefined ? { replaces: proposal.replaces } : {}),
          ...(proposal.apply !== undefined ? { apply: proposal.apply } : {}),
        },
      }
    }
    case 'apply_filter':
      if (!hasOnly(value, ['kind', 'account', 'filterId', 'confirm'])) return undefined
      if (!isAccount(value.account) || !isFilterId(value.filterId) || typeof value.confirm !== 'boolean') return undefined
      return { kind: 'apply_filter', account: value.account, filterId: value.filterId, confirm: value.confirm }
    case 'reorder_filters': {
      if (!hasOnly(value, ['kind', 'account', 'moves', 'confirm'])) return undefined
      if (!isAccount(value.account) || typeof value.confirm !== 'boolean') return undefined
      const moves = parseMoves(value.moves)
      return moves ? { kind: 'reorder_filters', account: value.account, moves, confirm: value.confirm } : undefined
    }
    default:
      return undefined
  }
}

function parseFilter(value: unknown): ProtonFilter | undefined {
  if (!isPlain(value) || !hasOnly(value, ['id', 'name', 'enabled', 'order', 'version', 'sieve'])) return undefined
  if (!isFilterId(value.id) || !isText(value.name, LIMITS.name, true) || typeof value.enabled !== 'boolean') return undefined
  if (!Number.isInteger(value.order) || !Number.isInteger(value.version)) return undefined
  if (!isText(value.sieve, LIMITS.sieve, true)) return undefined
  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    order: value.order as number,
    version: value.version as number,
    sieve: value.sieve,
  }
}

/** An answer as one of the known shapes, or nothing when it is anything else. */
export function parseResponse(value: unknown): BrowserResponse | undefined {
  if (!isPlain(value)) return undefined
  if (value.ok === false) {
    if (!hasOnly(value, ['ok', 'error', 'message'])) return undefined
    if (typeof value.error !== 'string' || !ERROR_CODES.has(value.error)) return undefined
    if (!isText(value.message, LIMITS.message, true)) return undefined
    return { ok: false, error: value.error as BrowserErrorCode, message: value.message }
  }
  if (value.ok !== true) return undefined
  switch (value.kind) {
    case 'status':
      if (!hasOnly(value, ['ok', 'kind', 'extensionVersion', 'protonTabs'])) return undefined
      if (!isText(value.extensionVersion, LIMITS.version) || !Number.isInteger(value.protonTabs)) return undefined
      return { ok: true, kind: 'status', extensionVersion: value.extensionVersion, protonTabs: value.protonTabs as number }
    case 'list_filters': {
      if (!hasOnly(value, ['ok', 'kind', 'filters'], ['queue', 'recent']) || !Array.isArray(value.filters)) return undefined
      if (value.filters.length > LIMITS.filters) return undefined
      const filters: ProtonFilter[] = []
      for (const entry of value.filters) {
        const filter = parseFilter(entry)
        if (!filter) return undefined
        filters.push(filter)
      }
      const queue = value.queue === undefined ? [] : parseQueue(value.queue)
      const recent = value.recent === undefined ? [] : parseRecent(value.recent)
      if (!queue || !recent) return undefined
      return {
        ok: true,
        kind: 'list_filters',
        filters,
        ...(value.queue !== undefined ? { queue } : {}),
        ...(value.recent !== undefined ? { recent } : {}),
      }
    }
    case 'propose_filter': {
      if (!hasOnly(value, ['ok', 'kind', 'outcome'], ['filterId', 'apply'])) return undefined
      if (value.outcome !== 'shown' && value.outcome !== 'added' && value.outcome !== 'replaced' && value.outcome !== 'queued') {
        return undefined
      }
      if (value.filterId !== undefined && !isFilterId(value.filterId)) return undefined
      if (value.apply !== undefined && value.apply !== 'done' && value.apply !== 'queued' && value.apply !== 'failed' && value.apply !== 'shown') {
        return undefined
      }
      return {
        ok: true,
        kind: 'propose_filter',
        outcome: value.outcome,
        ...(value.filterId !== undefined ? { filterId: value.filterId } : {}),
        ...(value.apply !== undefined ? { apply: value.apply } : {}),
      }
    }
    case 'apply_filter':
      if (!hasOnly(value, ['ok', 'kind', 'outcome'])) return undefined
      if (value.outcome !== 'shown' && value.outcome !== 'applied' && value.outcome !== 'queued') return undefined
      return { ok: true, kind: 'apply_filter', outcome: value.outcome }
    case 'reorder_filters':
      if (!hasOnly(value, ['ok', 'kind', 'outcome'])) return undefined
      if (value.outcome !== 'shown' && value.outcome !== 'reordered' && value.outcome !== 'queued') return undefined
      return { ok: true, kind: 'reorder_filters', outcome: value.outcome }
    default:
      return undefined
  }
}

function parseQueue(value: unknown): QueuedAction[] | undefined {
  if (!Array.isArray(value) || value.length > LIMITS.queue) return undefined
  const queue: QueuedAction[] = []
  for (const entry of value) {
    if (!isPlain(entry) || !hasOnly(entry, ['action', 'name', 'since', 'attempts'])) return undefined
    if (entry.action !== 'save' && entry.action !== 'apply' && entry.action !== 'reorder') return undefined
    if (!isText(entry.name, LIMITS.name, true) || !Number.isInteger(entry.since) || !Number.isInteger(entry.attempts)) return undefined
    queue.push({ action: entry.action, name: entry.name, since: entry.since as number, attempts: entry.attempts as number })
  }
  return queue
}

function parseRecent(value: unknown): RecentChange[] | undefined {
  if (!Array.isArray(value) || value.length > LIMITS.recent) return undefined
  const recent: RecentChange[] = []
  for (const entry of value) {
    if (!isPlain(entry) || !hasOnly(entry, ['at', 'name', 'outcome', 'how'], ['detail'])) return undefined
    if (!Number.isInteger(entry.at) || !isText(entry.name, LIMITS.name, true)) return undefined
    if (typeof entry.outcome !== 'string' || !OUTCOMES.has(entry.outcome)) return undefined
    if (entry.how !== 'confirmed' && entry.how !== 'without asking') return undefined
    if (entry.detail !== undefined && !isText(entry.detail, LIMITS.message, true)) return undefined
    recent.push({
      at: entry.at as number,
      name: entry.name,
      outcome: entry.outcome as RecentChange['outcome'],
      how: entry.how,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    })
  }
  return recent
}

/** True for the ids the server and the connector put on a request: short and plain. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value)
}
