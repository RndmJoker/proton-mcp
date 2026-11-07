/**
 * Proton's own interface for filters, called from inside the signed-in Proton
 * page (#59).
 *
 * The calls are the ones Proton's web app makes when a filter is saved, taken
 * from Proton's public source code (WebClients): mail/v4/filters to read and
 * write, mail/v4/filters/check to have Proton read a script before it is saved,
 * core/v4/addresses to see which account the page belongs to. They run in the
 * page, so the browser adds the page's own session cookie, and the extension
 * never sees or keeps a password or a token.
 *
 * The interface is not documented for other programs. Proton can change it at
 * any time, and then this file is where to look. The requests identify as the
 * web app because Proton refuses anything else, which is why the decision on
 * 05.11.2026 calls this a grey area. Tobi chose it over operating the page
 * like a person, which breaks with every redesign.
 *
 * Kept free of browser globals: the page's fetch, location and storage are
 * handed in, so the tests can stand in for them.
 */

import type { ProtonFilter } from '../../src/browser/messages.js'

export interface PageEnvironment {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  location: { origin: string; hostname: string; pathname: string }
  storage: { getItem(key: string): string | null }
}

export type ApiError = 'signed-out' | 'app-version' | 'proton-error' | 'not-found' | 'busy' | 'in-progress' | 'internal'

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError; message: string }

/** What Proton returns for a filter. Only the fields used here. */
interface RawFilter {
  ID: string
  Name: string
  Status: number
  Priority: number
  Version: number
  Sieve?: string | null
}

/** Proton's version of its filter grammar that every script here is written in. */
export const FILTER_VERSION = 2

const STATUS_ENABLED = 1
const CODE_SUCCESS = new Set([1000, 1001])
const CODE_APP_VERSION_BAD = 5003
const CODE_NOT_FOUND = 2501

/** The account slot in the address: /u/0/ for the first account signed in, /u/1/ for the second. */
export function localId(pathname: string): string {
  return /^\/u\/(\d+)(?:\/|$)/.exec(pathname)?.[1] ?? '0'
}

/**
 * The session id Proton's web app sends with every request, from where the app
 * keeps it: a JSON object under ps-<slot> in the page's local storage.
 */
export function sessionUid(env: PageEnvironment): string | undefined {
  const raw = env.storage.getItem(`ps-${localId(env.location.pathname)}`)
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as { UID?: unknown }
    return typeof value.UID === 'string' && value.UID.length > 0 ? value.UID : undefined
  } catch {
    return undefined
  }
}

/** Which of Proton's apps the page is, as the app names itself to the interface. */
export function clientId(hostname: string): 'web-mail' | 'web-account' {
  return hostname === 'account.proton.me' ? 'web-account' : 'web-mail'
}

export class ProtonApi {
  #version: string | undefined

  constructor(private readonly env: PageEnvironment) {}

  /** The version of the web app in this page, from the file Proton's build writes next to it. */
  async #appVersion(): Promise<string | undefined> {
    if (this.#version) return this.#version
    try {
      const response = await this.env.fetch(`${this.env.location.origin}/assets/version.json`, { cache: 'no-store', credentials: 'omit' })
      const data = (await response.json()) as { version?: unknown }
      if (typeof data.version === 'string' && /^[0-9][0-9A-Za-z.+-]*$/.test(data.version)) this.#version = data.version
    } catch {
      // Answered below as an app version Proton does not accept.
    }
    return this.#version
  }

  async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
    const uid = sessionUid(this.env)
    if (!uid) return { ok: false, error: 'signed-out', message: 'The Proton page is not signed in.' }
    const version = await this.#appVersion()
    if (!version) {
      return { ok: false, error: 'app-version', message: "The version of Proton's web app could not be read from the page." }
    }
    let response: Response
    try {
      // An absolute address: a relative one resolves against the document's
      // base URL, which a page can change with a <base> element.
      response = await this.env.fetch(`${this.env.location.origin}/api/${path}`, {
        method,
        credentials: 'include',
        headers: {
          'x-pm-uid': uid,
          'x-pm-appversion': `${clientId(this.env.location.hostname)}@${version}`,
          Accept: 'application/vnd.protonmail.v1+json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (error) {
      return { ok: false, error: 'internal', message: `Proton could not be reached: ${String(error)}` }
    }
    let data: Record<string, unknown> = {}
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch {
      // Some failures come without a body; the status says enough.
    }
    const code = typeof data.Code === 'number' ? data.Code : undefined
    const said =
      typeof data.Error === 'string' ? data.Error : `HTTP ${response.status}${code !== undefined ? `, code ${code}` : ''}`
    if (response.status === 401) return { ok: false, error: 'signed-out', message: 'The Proton session has expired.' }
    if (code === CODE_APP_VERSION_BAD || response.status === 505) return { ok: false, error: 'app-version', message: said }
    if (response.status === 403) {
      return { ok: false, error: 'proton-error', message: `Proton wants the password again before this change: ${said}` }
    }
    if (response.status === 429) return { ok: false, error: 'busy', message: 'Proton asks to slow down. Try again in a minute.' }
    // Proton is still at an earlier action, measured on 06.11.2026 after
    // applying a filter. Not a refusal: the queue waits this out.
    if (response.status === 409 || /another action is (currently )?in progress/i.test(said)) {
      return { ok: false, error: 'in-progress', message: said }
    }
    if (code === CODE_NOT_FOUND || response.status === 404) return { ok: false, error: 'not-found', message: said }
    // 202 means Proton took the request on and works on it in the background.
    // Applying a filter answers this way, measured on 06.11.2026: the first
    // version asked for code 1000 here as well and called an application
    // that Proton had accepted a failure.
    if (response.status === 202) return { ok: true, value: data as T }
    if (!response.ok || code === undefined || !CODE_SUCCESS.has(code)) return { ok: false, error: 'proton-error', message: said }
    return { ok: true, value: data as T }
  }

  /** Every address of the account the page is signed in to, in lower case. */
  async addresses(): Promise<ApiResult<string[]>> {
    const result = await this.call<{ Addresses?: Array<{ Email?: unknown }> }>('GET', 'core/v4/addresses')
    if (!result.ok) return result
    const emails = (result.value.Addresses ?? [])
      .map((address) => (typeof address.Email === 'string' ? address.Email.toLowerCase() : undefined))
      .filter((email): email is string => email !== undefined)
    return { ok: true, value: emails }
  }

  async filters(): Promise<ApiResult<ProtonFilter[]>> {
    const result = await this.call<{ Filters?: RawFilter[] }>('GET', 'mail/v4/filters')
    if (!result.ok) return result
    const filters = (result.value.Filters ?? []).map(
      (filter): ProtonFilter => ({
        id: filter.ID,
        name: filter.Name ?? '',
        enabled: filter.Status === STATUS_ENABLED,
        order: filter.Priority ?? 0,
        version: filter.Version ?? 0,
        sieve: filter.Sieve ?? '',
      }),
    )
    return { ok: true, value: filters }
  }

  /**
   * Proton's own reading of a script. Every issue it names keeps the script
   * from being saved, as in Proton's own editor. Lines are counted from 0
   * there and from 1 here.
   */
  async check(sieve: string): Promise<ApiResult<string[]>> {
    const result = await this.call<{ Issues?: Array<{ from?: { line?: number }; message?: string }> }>(
      'PUT',
      'mail/v4/filters/check',
      { Version: FILTER_VERSION, Sieve: sieve },
    )
    if (!result.ok) return result
    const issues = (result.value.Issues ?? []).map((issue) => {
      const line = typeof issue.from?.line === 'number' ? `line ${issue.from.line + 1}` : 'somewhere'
      return issue.message ? `${line}: ${issue.message}` : line
    })
    return { ok: true, value: issues }
  }

  /** Adds a filter, switched on, and returns its new id. */
  async add(name: string, sieve: string): Promise<ApiResult<string>> {
    const result = await this.call<{ Filter?: { ID?: unknown } }>('POST', 'mail/v4/filters', {
      ID: '',
      Name: name,
      Status: STATUS_ENABLED,
      Version: FILTER_VERSION,
      Sieve: sieve,
    })
    if (!result.ok) return result
    const id = result.value.Filter?.ID
    return { ok: true, value: typeof id === 'string' ? id : '' }
  }

  /**
   * Runs a saved filter over the mail already there, with the request Proton's
   * own settings send for "Apply filter to existing emails". Proton works
   * through the mail in the background and reports nothing more.
   */
  async apply(filterId: string): Promise<ApiResult<void>> {
    const result = await this.call('POST', 'mail/v4/messages/apply-filters', {
      SearchContext: null,
      Version: null,
      Sieve: null,
      AllFilters: 0,
      FilterIDs: [filterId],
      AllowList: 0,
      BlockList: 0,
      SpamList: 0,
    })
    return result.ok ? { ok: true, value: undefined } : result
  }

  /**
   * Sets the order Proton runs the filters in, given as every id in the new
   * order, the way Proton's own settings send it after a drag.
   */
  async order(ids: string[]): Promise<ApiResult<void>> {
    const result = await this.call('PUT', 'mail/v4/filters/order', { FilterIDs: ids })
    return result.ok ? { ok: true, value: undefined } : result
  }

  /** Deletes a filter for good, as Proton's own settings do (WebClients, deleteFilter). */
  async delete(filterId: string): Promise<ApiResult<void>> {
    const result = await this.call('DELETE', `mail/v4/filters/${encodeURIComponent(filterId)}`)
    return result.ok ? { ok: true, value: undefined } : result
  }

  /** Switches a filter on or off, as Proton's own settings do (WebClients, toggleEnable). */
  async setStatus(filterId: string, enabled: boolean): Promise<ApiResult<void>> {
    const result = await this.call('PUT', `mail/v4/filters/${encodeURIComponent(filterId)}/${enabled ? 'enable' : 'disable'}`)
    return result.ok ? { ok: true, value: undefined } : result
  }

  /**
   * Replaces a filter's name and script. Its status is passed back as it is
   * stored, so a change can never switch a filter off, as in Proton's own
   * assistant.
   */
  async update(filter: ProtonFilter, name: string, sieve: string): Promise<ApiResult<void>> {
    const result = await this.call('PUT', `mail/v4/filters/${encodeURIComponent(filter.id)}`, {
      ID: filter.id,
      Name: name,
      Status: filter.enabled ? STATUS_ENABLED : 0,
      Version: FILTER_VERSION,
      Sieve: sieve,
    })
    return result.ok ? { ok: true, value: undefined } : result
  }
}
