/**
 * What the parts of the extension may say to each other (#59).
 *
 * Three kinds of messages stay inside the extension: the background asks the
 * script in the Proton page to call Proton, the confirmation window asks for
 * its proposal and hands back the user's decision, and the popup asks how
 * things stand. Each receiver checks who sent a message before it reads it,
 * and then reads it only in one of the shapes below.
 *
 * Nothing on the Proton page can send any of these. The extension declares no
 * externally_connectable, so the page's own code cannot reach it, and the
 * script in the page listens only to the extension's background.
 */

import type { ProtonFilter, RecentChange } from '../../src/browser/messages.js'
import type { MovedFilter } from '../../src/filters/order.js'

/** The background's requests to the script in the Proton page. */
export type ContentOp =
  | { op: 'addresses' }
  | { op: 'filters' }
  | { op: 'check'; sieve: string }
  | { op: 'add'; account: string; name: string; sieve: string }
  | { op: 'update'; account: string; filter: ProtonFilter; name: string; sieve: string }
  | { op: 'apply'; account: string; filterId: string; sieve: string }
  | { op: 'order'; account: string; ids: string[] }

interface PendingBase {
  id: string
  account: string
  effects: string[]
  warnings: string[]
  createdAt: number
  /**
   * The tab the extension opened for this proposal. Only that tab may read it
   * and answer it: the same address opened anywhere else, by a person or by a
   * tool that drives the browser, gets nothing.
   */
  tabId?: number
}

/** A filter to save, new or replacing one. */
export interface PendingSave extends PendingBase {
  kind: 'save'
  name: string
  sieve: string
  /** The filter as it was stored when the change was proposed. */
  current?: ProtonFilter
  /** Whether the box to apply it to the mail already there starts ticked. */
  apply: boolean
  /** Whether the box is offered at all: not when apply_filter is switched off. */
  applyAllowed: boolean
}

/** A saved filter to run over the mail already there. */
export interface PendingApply extends PendingBase {
  kind: 'apply'
  /** The filter as it was stored when applying was asked for. */
  filter: ProtonFilter
}

/** A new order of the filters. */
export interface PendingReorder extends PendingBase {
  kind: 'reorder'
  /** The order as it was when the move was asked for; if it changed since, nothing is moved. */
  before: string[]
  after: string[]
  /** The names of every filter, by id, for showing the order. */
  names: Record<string, string>
  moved: MovedFilter[]
}

/** A proposal waiting in the confirmation window. Kept in session storage, which the Proton page cannot read. */
export type PendingProposal = PendingSave | PendingApply | PendingReorder

/** The confirmation window's and the popup's requests to the background. */
export type PageMessage =
  | { type: 'proposal'; id: string }
  | { type: 'decide'; id: string; accept: boolean; apply?: boolean }
  | { type: 'status' }
  | { type: 'reconnect' }
  | { type: 'cancel'; id: string }
  | { type: 'switches'; switches: Switches }

/**
 * The extension's own say on acting without its window, per action. All off
 * by default: then the window shows, whatever the server sends. A program
 * that read the connector's secret could otherwise skip the window. Decided
 * by Tobi on 06.11.2026.
 */
export interface Switches {
  save: boolean
  apply: boolean
  reorder: boolean
}

export const NO_SWITCHES: Switches = { save: false, apply: false, reorder: false }

export function parseSwitches(value: unknown): Switches | undefined {
  if (!isRecord(value)) return undefined
  const { save, apply, reorder } = value
  if (typeof save !== 'boolean' || typeof apply !== 'boolean' || typeof reorder !== 'boolean') return undefined
  if (Object.keys(value).length !== 3) return undefined
  return { save, apply, reorder }
}

/** What the extension has done, shown in its popup and passed to the server with the filters. */
export type Change = RecentChange

/** How long a proposal waits for a decision before it lapses. */
export const PROPOSAL_LIFETIME_MS = 30 * 60_000

const MAX_TEXT = 100_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFilter(value: unknown): value is ProtonFilter {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.order === 'number' &&
    typeof value.version === 'number' &&
    typeof value.sieve === 'string'
  )
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT
const account = (value: unknown): value is string => typeof value === 'string' && value.length <= 320 && value.includes('@')

export function parseContentOp(value: unknown): ContentOp | undefined {
  if (!isRecord(value)) return undefined
  switch (value.op) {
    case 'addresses':
    case 'filters':
      return { op: value.op }
    case 'check':
      return text(value.sieve) ? { op: 'check', sieve: value.sieve } : undefined
    case 'add':
      return account(value.account) && text(value.name) && text(value.sieve)
        ? { op: 'add', account: value.account, name: value.name, sieve: value.sieve }
        : undefined
    case 'update':
      return account(value.account) && isFilter(value.filter) && text(value.name) && text(value.sieve)
        ? { op: 'update', account: value.account, filter: value.filter, name: value.name, sieve: value.sieve }
        : undefined
    case 'apply':
      return account(value.account) && typeof value.filterId === 'string' && /^[A-Za-z0-9_=-]{1,256}$/.test(value.filterId) && text(value.sieve)
        ? { op: 'apply', account: value.account, filterId: value.filterId, sieve: value.sieve }
        : undefined
    case 'order':
      return account(value.account) &&
        Array.isArray(value.ids) &&
        value.ids.length <= 1_000 &&
        value.ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9_=-]{1,256}$/.test(id))
        ? { op: 'order', account: value.account, ids: value.ids as string[] }
        : undefined
    default:
      return undefined
  }
}

const PROPOSAL_ID = /^[0-9a-f-]{36}$/

export function parsePageMessage(value: unknown): PageMessage | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case 'proposal':
      return typeof value.id === 'string' && PROPOSAL_ID.test(value.id) ? { type: 'proposal', id: value.id } : undefined
    case 'decide':
      if (typeof value.id !== 'string' || !PROPOSAL_ID.test(value.id) || typeof value.accept !== 'boolean') return undefined
      if (value.apply !== undefined && typeof value.apply !== 'boolean') return undefined
      return { type: 'decide', id: value.id, accept: value.accept, ...(value.apply !== undefined ? { apply: value.apply } : {}) }
    case 'status':
    case 'reconnect':
      return { type: value.type }
    case 'cancel':
      return typeof value.id === 'string' && PROPOSAL_ID.test(value.id) ? { type: 'cancel', id: value.id } : undefined
    case 'switches': {
      const switches = parseSwitches(value.switches)
      return switches ? { type: 'switches', switches } : undefined
    }
    default:
      return undefined
  }
}
