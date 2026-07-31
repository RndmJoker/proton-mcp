/**
 * The sections shown once somebody is signed in.
 *
 * One page each, rather than one long page with headings. The split is not
 * cosmetic: it decides what is on screen without being asked for. Mailbox names
 * had that treatment already, for reasons written at mailboxSection, and the
 * same reasoning applies more weakly to everything else here. A page is also a
 * place to put a setting, and the settings that limit what the agent may do are
 * arriving next.
 *
 * The counterpart is pages.ts, which holds what comes before signing in.
 */

import {
  layout,
  escapeHtml,
  formatDuration,
  errorBanner,
  noticeBanner,
  type Section,
  type DisclaimerState,
} from './layout.js'
import type { StoreKind } from '../credentials/store.js'

/** What every section needs to draw itself. */
interface Common {
  token: string
  error?: string
  notice?: string
  /**
   * Required rather than optional on purpose. Forgetting it would make the
   * notice quietly disappear, and a legal statement is not something to lose by
   * omission.
   */
  disclaimer: DisclaimerState
}

/** A wall-clock time, local to whoever is looking at the page. */
function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString()
}

/** A row of the definition tables that carry most of the state here. */
function row(key: string, value: string, raw = false): string {
  return `<tr><th>${escapeHtml(key)}</th><td>${raw ? value : escapeHtml(value)}</td></tr>`
}

function frame(section: Section, title: string, data: Common, body: string): string {
  return layout({
    title,
    section,
    token: data.token,
    disclaimer: data.disclaimer,
    body: `${errorBanner(data.error)}${noticeBanner(data.notice)}${body}`,
  })
}

export interface OverviewData extends Common {
  connected: boolean
  address?: string
  storeTitle?: string
  readOnly: boolean
  webPort: number
  uptimeMs: number
  mailboxCount?: number
  messageCount?: number
  unseenCount?: number
  bridgeHost: string
  bridgeImapPort: number
  bridgeSmtpPort: number
}

/**
 * The first page, and the only one that answers "is this working".
 *
 * It carries state and no controls. Every button lives in the section it belongs
 * to, so that a page somebody opens to check something cannot be the page where
 * they change it by accident.
 */
export function overviewSection(data: OverviewData): string {
  const connection = data.connected
    ? '<span class="state good">connected</span>'
    : '<span class="state bad">not connected</span>'

  const rows = [
    row('Connection', connection, true),
    row('Address', data.address ?? 'not signed in'),
    row('Credentials kept in', data.storeTitle ?? 'nowhere yet'),
    row('Mode', data.readOnly ? 'read-only, nothing can be changed or sent' : 'read and write'),
    row('Bridge IMAP', `${data.bridgeHost}:${data.bridgeImapPort}`),
    row('Bridge SMTP', `${data.bridgeHost}:${data.bridgeSmtpPort}`),
    row('This interface', `127.0.0.1:${data.webPort}`),
    row('Server running for', formatDuration(data.uptimeMs)),
  ]

  const counters: string[] = []
  if (data.mailboxCount !== undefined) counters.push(row('Mailboxes', String(data.mailboxCount)))
  if (data.messageCount !== undefined) {
    const unseen = data.unseenCount === undefined ? '' : ` (${data.unseenCount} unread)`
    counters.push(row('Messages in inbox', `${data.messageCount}${unseen}`))
  }

  return frame(
    'overview',
    'Overview',
    data,
    `<h1>Overview</h1>
<p class="lead">What this server currently knows. No message content is shown anywhere in this
interface: it is for configuration and state, not a mail client.</p>

<div class="card"><table>${rows.join('\n')}</table></div>
${counters.length > 0 ? `<h2>Mailbox counts</h2>\n<div class="card"><table>${counters.join('\n')}</table></div>` : ''}`,
  )
}

export interface BridgeData extends Common {
  csrfSettings: string
  csrfTest: string
  bridgeHost: string
  bridgeImapPort: number
  bridgeSmtpPort: number
  /** True when the port came from the environment and cannot be changed here. */
  portsLocked: boolean
  certificate?: {
    fingerprint: string
    subject: string
    firstSeen: string
  }
}

/** Ports, the pinned certificate, and the button that tries the Bridge. */
export function bridgeSection(data: BridgeData): string {
  const ports = data.portsLocked
    ? `<p class="hint">The ports come from the environment (<code>BRIDGE_IMAP_PORT</code> or
    <code>BRIDGE_SMTP_PORT</code>), so they are not changed here. An explicit setting stays
    explicit.</p>`
    : `<form method="post" action="/settings?token=${escapeHtml(data.token)}">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfSettings)}">
  <label for="imapPort">IMAP port</label>
  <input id="imapPort" name="imapPort" type="text" inputmode="numeric"
         value="${escapeHtml(String(data.bridgeImapPort))}">
  <label for="smtpPort">SMTP port</label>
  <input id="smtpPort" name="smtpPort" type="text" inputmode="numeric"
         value="${escapeHtml(String(data.bridgeSmtpPort))}">
  <p class="hint">The Bridge lets you change these, so a wrong value here looks exactly like a Bridge
  that is not running. You find the real ones in the Bridge under settings. The host is not
  changeable here on purpose: it would be a field that sends your Bridge password to another
  machine.</p>
  <button type="submit">Save ports</button>
</form>`

  const certificate = data.certificate
    ? `<div class="card">
<table>
${row('Fingerprint (SHA-256)', `<code>${escapeHtml(data.certificate.fingerprint)}</code>`, true)}
${row('Subject', data.certificate.subject)}
${row('First seen', data.certificate.firstSeen.slice(0, 10))}
</table>
<p class="hint">The Bridge signs its own certificate, so it was recorded on first use and is checked
against that record every time. If it ever changes, the server refuses to connect rather than hand
your password to whatever is answering on that port.</p>
</div>`
    : `<div class="card"><p class="hint">Nothing recorded yet. The certificate is read and pinned on the
first connection to the Bridge.</p></div>`

  return frame(
    'bridge',
    'Bridge',
    data,
    `<h1>Bridge</h1>
<p class="lead">Where the Proton Mail Bridge is reached, and the certificate this server holds it
to. The host stays at <code>${escapeHtml(data.bridgeHost)}</code> and cannot be changed here.</p>

<h2>Connection test</h2>
<div class="card">
<form method="post" action="/test-connection?token=${escapeHtml(data.token)}">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfTest)}">
  <p>Checks that the Bridge answers on the ports below and accepts the stored credentials.</p>
  <button type="submit">Test the connection</button>
</form>
</div>

<h2>Ports</h2>
<div class="card">${ports}</div>

<h2>Certificate</h2>
${certificate}`,
  )
}

export interface CredentialsData extends Common {
  csrfSignOut: string
  address?: string
  storeKind?: StoreKind
  storeTitle?: string
}

/** Where the Bridge password is kept, and the way to take it back out. */
export function credentialsSection(data: CredentialsData): string {
  return frame(
    'credentials',
    'Credentials',
    data,
    `<h1>Credentials</h1>
<p class="lead">The Bridge password this server signs in with, and where it is kept between
restarts.</p>

<div class="card"><table>
${row('Signed in as', data.address ?? 'not signed in')}
${row('Kept in', data.storeTitle ?? 'nowhere yet')}
</table></div>

<h2>Sign out</h2>
<div class="card">
<form method="post" action="/sign-out?token=${escapeHtml(data.token)}">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfSignOut)}">
  <p>Removes the stored credentials from wherever they are kept, everywhere at once, and
  disconnects.</p>
  <button type="submit" class="danger">Sign out and forget credentials</button>
</form>
</div>`,
  )
}

export interface ActivityData extends Common {
  /** Calls in progress, so a slow search is visibly a slow search. */
  running: Array<{ tool: string; forMs: number }>
  /** Finished calls, newest first. */
  recent: Array<{ tool: string; at: number; durationMs: number; outcome: 'ok' | 'failed' }>
}

/** What the server has been doing, in tool names and timings and nothing else. */
export function activitySection(data: ActivityData): string {
  const running =
    data.running.length === 0
      ? '<p class="hint">Nothing running right now.</p>'
      : `<table>
  <tr><th>In progress</th><th>Running for</th></tr>
  ${data.running
    .map(
      (call) =>
        `<tr><td><code>${escapeHtml(call.tool)}</code></td><td>${escapeHtml(formatDuration(call.forMs))}</td></tr>`,
    )
    .join('\n  ')}
</table>
<p class="hint">A full-text search over a large mailbox takes a few seconds. This is how you tell
that apart from a server that has stopped answering.</p>`

  const recent =
    data.recent.length === 0
      ? '<p class="hint">No tool has been called yet in this session.</p>'
      : `<table>
  <tr><th>Tool</th><th>When</th><th>Took</th><th>Result</th></tr>
  ${data.recent
    .map(
      (call) =>
        `<tr><td><code>${escapeHtml(call.tool)}</code></td><td>${escapeHtml(formatTime(call.at))}</td>` +
        `<td>${escapeHtml(formatDuration(call.durationMs))}</td>` +
        `<td>${call.outcome === 'ok' ? 'ok' : 'failed'}</td></tr>`,
    )
    .join('\n  ')}
</table>`

  return frame(
    'activity',
    'Activity',
    data,
    `<h1>Activity</h1>
<p class="lead">Which tools were called and how long they took. This is the record of what an
assistant did with the connection.</p>

<h2>Right now</h2>
<div class="card">${running}</div>

<h2>Finished calls</h2>
<div class="card">
${recent}
<p class="hint">Tool names and timings only. What was searched for, which message was read and which
mailbox was opened are deliberately not recorded: that would turn this page into a log of your mail
habits.</p>
</div>`,
  )
}

export interface MailboxData extends Common {
  mailboxes: Array<{ path: string; kind: 'system' | 'folder' | 'label'; selectable: boolean }>
}

/**
 * The folders and labels, on their own page.
 *
 * Its own page because of what these names are. They belong to the Proton
 * account, not the address that signed in, so this is the full structure of the
 * account even when the mail in it is invisible. Showing that as part of an
 * answer nobody asked for would hand it over unasked.
 */
export function mailboxSection(data: MailboxData): string {
  const groups: Array<['system' | 'folder' | 'label', string]> = [
    ['system', 'System mailboxes'],
    ['folder', 'Folders'],
    ['label', 'Labels'],
  ]

  const sections = groups
    .map(([kind, heading]) => {
      const part = data.mailboxes.filter((m) => m.kind === kind && m.selectable)
      if (part.length === 0) return ''
      return `<h2>${escapeHtml(heading)} (${part.length})</h2>
<div class="card"><table>
${part.map((m) => `<tr><td><code>${escapeHtml(m.path)}</code></td></tr>`).join('\n')}
</table></div>`
    })
    .filter(Boolean)
    .join('\n')

  return frame(
    'mailboxes',
    'Folders and labels',
    data,
    `<h1>Folders and labels</h1>
<p class="lead">Names only, never contents. Proton distinguishes folders, where a message lives in
exactly one, from labels, where it can carry any number.</p>
${sections || '<div class="card"><p class="hint">No mailboxes were returned.</p></div>'}`,
  )
}
