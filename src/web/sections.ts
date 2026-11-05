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
  pinField,
  type Section,
  type DisclaimerState,
} from './layout.js'
import type { StoreKind } from '../credentials/store.js'

/** What every section needs to draw itself. */
interface Common {
  /** True while a PIN is set: then every form that changes something asks for it. */
  pinRequired?: boolean
  error?: string
  notice?: string
  /**
   * Required rather than optional on purpose. Forgetting it would make the
   * notice quietly disappear, and a legal statement is not something to lose by
   * omission.
   */
  disclaimer: DisclaimerState
}

/**
 * A wall-clock time in the locale and timezone of the machine running the
 * server, because the page is rendered there and carries no script to adjust
 * it. Same thing for anyone at that machine, which is the ordinary case; read
 * from a phone in another timezone it is the server's clock, not the reader's.
 */
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
    disclaimer: data.disclaimer,
    body: `${errorBanner(data.error)}${noticeBanner(data.notice)}${body}`,
  })
}

/** One running server, as the overview lists it. Never a password. */
export interface ServerSummary {
  pid: number
  version: string
  startedAt: number
  signedIn: boolean
  address?: string
  storeTitle?: string
  /** True for the server that shows this page. */
  servesInterface: boolean
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
  /** Every server running on this machine, this one included. */
  servers?: ServerSummary[]
  /** Tools whose level differs from the default, with that level in words. */
  departures?: Array<{ tool: string; level: string }>
  /** The recipient added to every message sent, when one is. */
  record?: { address: string; mode: 'cc' | 'bcc' }
}

/**
 * The running servers, one row each.
 *
 * Every client session starts its own server, and all of them share this page.
 * A sign-in kept only in the memory of the server that shows the page ("this
 * session only" or an encrypted file still being open) does not reach the
 * others, and this table is where that becomes visible rather than puzzling.
 */
function serverTable(servers: ServerSummary[] | undefined): string {
  if (!servers || servers.length === 0) return ''
  const rows = servers
    .map((server) => {
      const who = server.signedIn
        ? `signed in as ${escapeHtml(server.address ?? 'unknown')}` +
          (server.storeTitle ? `, kept in ${escapeHtml(server.storeTitle)}` : '')
        : 'not signed in'
      const mark = server.servesInterface ? ' <span class="state good">shows this page</span>' : ''
      return (
        `<tr><td><code>${server.pid}</code>${mark}</td><td>${who}</td>` +
        `<td>${escapeHtml(server.version)}</td><td>${escapeHtml(formatTime(server.startedAt))}</td></tr>`
      )
    })
    .join('\n')
  return `<h2>Running servers (${servers.length})</h2>
<div class="card"><table>
<tr><th>Process</th><th>Sign-in</th><th>Version</th><th>Started</th></tr>
${rows}
</table>
<p class="hint">Each assistant session starts its own server, and all of them share this page and
its settings. A password kept in the system keyring or in a file reaches every one of them. One kept
for this session only, or in an encrypted file opened here, stays with the server that shows this
page.</p></div>`
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
    row(
      'Changes here',
      data.pinRequired
        ? '<span class="state good">need the PIN</span>'
        : '<span class="state bad">anything on this machine can make them, the assistant included</span>',
      true,
    ),
    row(
      'Assistant permissions',
      !data.departures || data.departures.length === 0
        ? 'as by default: sending asks first, everything else acts'
        : data.departures.map((d) => `${d.tool}: ${d.level}`).join(', '),
    ),
    row(
      'Copy of everything sent',
      data.record
        ? `<span class="state bad">${escapeHtml(data.record.address)} (${data.record.mode === 'cc' ? 'Cc' : 'Bcc'})</span>`
        : 'none',
      true,
    ),
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
${counters.length > 0 ? `<h2>Mailbox counts</h2>\n<div class="card"><table>${counters.join('\n')}</table></div>` : ''}
${serverTable(data.servers)}`,
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
    : `<form method="post" action="/settings">
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
  ${pinField(data.pinRequired === true)}
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
<form method="post" action="/test-connection">
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
<form method="post" action="/sign-out">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfSignOut)}">
  <p>Removes the stored credentials from wherever they are kept, everywhere at once, and
  disconnects. Every running server signs out with it.</p>
  ${pinField(data.pinRequired === true)}
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

/** One tool as the permissions page shows it. */
export interface ToolLevelView {
  tool: string
  group: string
  level: 'off' | 'ask' | 'act'
  /** The levels this tool offers. Only the sending tools and proposing a filter can ask. */
  options: Array<'off' | 'ask' | 'act'>
  /** Set in the environment or by read-only mode, and so not changeable here. */
  fixed: boolean
  /** Where the level comes from, in words. */
  source: string
  /** True when the level differs from the default. */
  departs?: boolean
}

/** The bounds on sending without asking, each with whether the environment fixed it. */
export interface LimitsView {
  allowed: string[]
  maxPerHour?: number
  until?: string
  fixed: { allowed: boolean; maxPerHour: boolean; until: boolean }
}

/** The recipient added to every message sent, as the page shows it. */
export interface RecordView {
  address?: string
  mode?: 'cc' | 'bcc'
  /** Set in the environment, and so not changeable here. */
  fixed: boolean
}

export interface PermissionsData extends Common {
  csrfPin: string
  csrfLevels?: string
  csrfLimits?: string
  csrfRecord?: string
  tools?: ToolLevelView[]
  limits?: LimitsView
  record?: RecordView
}

/** The copy of everything sent: who gets it, and the form to change it. */
function recordForm(data: PermissionsData): string {
  const record = data.record
  if (!record) return ''
  const now = record.address
    ? `<p>Every message sent through this server also goes to <code>${escapeHtml(record.address)}</code>
as ${record.mode === 'cc' ? 'Cc, visible to every recipient' : 'Bcc, invisible to the other recipients'}.</p>`
    : '<p>No copy is added.</p>'
  if (record.fixed) {
    return `<h2>A copy of everything sent</h2>
<div class="card">${now}<p class="hint">Set in the environment (<code>PROTON_MCP_COPY_TO</code>), so it is
not changed here.</p></div>`
  }
  return `<h2>A copy of everything sent</h2>
<div class="card">
${now}
<form method="post" action="/permissions/record">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfRecord ?? '')}">
  <label for="copyTo">Address</label>
  <input id="copyTo" name="address" type="text" autocomplete="off" spellcheck="false"
         value="${escapeHtml(record.address ?? '')}" placeholder="archive@example.com">
  <label for="copyAs">As</label>
  <select id="copyAs" name="mode">
    <option value="bcc"${record.mode !== 'cc' ? ' selected' : ''}>Bcc: a record the recipients do not see</option>
    <option value="cc"${record.mode === 'cc' ? ' selected' : ''}>Cc: visible to every recipient</option>
  </select>
  <p class="hint">Added to every message every sending tool sends, before the question is asked, so it is
  part of what you confirm, and the question names it as coming from this setting. Nothing the
  assistant passes removes it. Leave the address empty to add nothing.</p>
  ${pinField(data.pinRequired === true)}
  <button type="submit">Save the copy</button>
</form>
</div>`
}

const LEVEL_NAMES: Record<'off' | 'ask' | 'act', string> = {
  off: 'off',
  ask: 'ask first',
  act: 'act on its own',
}

/** The table of tools with a choice for each, or the fixed value where the environment decided. */
function levelTable(data: PermissionsData): string {
  if (!data.tools || data.tools.length === 0) return ''
  const rows = data.tools
    .map((tool) => {
      const choice = tool.fixed
        ? `<strong>${escapeHtml(LEVEL_NAMES[tool.level])}</strong> <span class="hint">(${escapeHtml(tool.source)})</span>`
        : `<select name="level:${escapeHtml(tool.tool)}" aria-label="${escapeHtml(tool.tool)}">` +
          tool.options
            .map(
              (option) =>
                `<option value="${option}"${option === tool.level ? ' selected' : ''}>${escapeHtml(LEVEL_NAMES[option])}</option>`,
            )
            .join('') +
          '</select>'
      return `<tr><td><code>${escapeHtml(tool.tool)}</code></td><td>${escapeHtml(tool.group)}</td><td>${choice}</td></tr>`
    })
    .join('\n')

  const autonomous = data.tools.filter(
    (tool) => tool.level === 'act' && tool.options.includes('ask'),
  )
  const cost = autonomous.length
    ? `<div class="error"><strong>${autonomous.map((t) => escapeHtml(t.tool)).join(', ')}
${autonomous.length === 1 ? 'acts' : 'act'} without asking.</strong> Your private mail, text written by
strangers and a way out are then together with no person in between: a single message can ask for
your mailbox to be forwarded, and nobody would see it happen. Bound it below where you can.
${data.pinRequired ? '' : '<br><strong>No PIN is set</strong>, so the assistant could also have switched this on itself.'}</div>`
    : ''

  return `<h2>What the assistant may do</h2>
<div class="card">
${cost}
<form method="post" action="/permissions/levels">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfLevels ?? '')}">
  <table>
  <tr><th>Tool</th><th>Group</th><th>Level</th></tr>
  ${rows}
  </table>
  <p class="hint"><strong>off</strong> takes a tool away from the assistant entirely.
  <strong>ask first</strong> makes it ask you through your client before acting, which every sending
  tool does by default. <strong>act on its own</strong> lets it go ahead. A level set in the server's
  environment wins over this page and is shown here as fixed.</p>
  ${pinField(data.pinRequired === true)}
  <button type="submit">Save the levels</button>
</form>
</div>`
}

/** The optional bounds on sending without asking. */
function limitsForm(data: PermissionsData): string {
  const limits = data.limits
  if (!limits) return ''
  const fixedNote = (fixed: boolean) => (fixed ? ' <span class="hint">(set in the environment)</span>' : '')
  const allowed = limits.fixed.allowed
    ? `<p><code>${escapeHtml(limits.allowed.join(', ') || 'anyone')}</code>${fixedNote(true)}</p>`
    : `<textarea id="allowed" name="allowed" rows="4">${escapeHtml(limits.allowed.join('\n'))}</textarea>`
  const max = limits.fixed.maxPerHour
    ? `<p><code>${escapeHtml(String(limits.maxPerHour ?? 'no limit'))}</code>${fixedNote(true)}</p>`
    : `<input id="maxPerHour" name="maxPerHour" type="text" inputmode="numeric" value="${escapeHtml(limits.maxPerHour === undefined ? '' : String(limits.maxPerHour))}">`
  const until = limits.fixed.until
    ? `<p><code>${escapeHtml(limits.until ?? 'none')}</code>${fixedNote(true)}</p>`
    : `<input id="until" name="until" type="date" value="${escapeHtml(limits.until ?? '')}">`

  return `<h2>Bounds on sending without asking</h2>
<div class="card">
<form method="post" action="/permissions/limits">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfLimits ?? '')}">
  <label for="allowed">Permitted recipients</label>
  ${allowed}
  <p class="hint">One per line: a full address, or a domain written as <code>@example.com</code>. Empty
  means anyone. A message to anyone else asks first instead.</p>
  <label for="maxPerHour">At most this many per hour</label>
  ${max}
  <p class="hint">Counted per running server. Beyond it, sending asks first again. Empty means no limit.</p>
  <label for="until">Until this day</label>
  ${until}
  <p class="hint">After this day, sending asks first again until you set a new one. Empty means no end.</p>
  <p class="hint">Every bound is optional. A send outside one asks you instead of failing.</p>
  ${pinField(data.pinRequired === true)}
  <button type="submit">Save the bounds</button>
</form>
</div>`
}

/**
 * What the assistant may do, and who may change that.
 *
 * The PIN comes first on this page because everything else on it depends on
 * it. Without one, the settings here are only as safe as every program on this
 * machine, the assistant included: it can open this address with a browser
 * tool as easily as the user can. The page says so plainly instead of leaving
 * it to be discovered.
 */
export function permissionsSection(data: PermissionsData): string {
  const pin = data.pinRequired
    ? `<p>A PIN is set. Every change in this interface asks for it.</p>
<form method="post" action="/pin">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfPin)}">
  <input type="hidden" name="action" value="change">
  ${pinField(true)}
  <label for="next">New PIN</label>
  <input id="next" name="next" type="password" autocomplete="new-password">
  <label for="nextRepeat">New PIN again</label>
  <input id="nextRepeat" name="nextRepeat" type="password" autocomplete="new-password">
  <button type="submit">Change the PIN</button>
</form>
<form method="post" action="/pin">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfPin)}">
  <input type="hidden" name="action" value="remove">
  ${pinField(true)}
  <button type="submit" class="danger">Remove the PIN</button>
</form>`
    : `<div class="error">No PIN is set. Anything running on this machine can change the settings
here, and so can an assistant with a browser tool, which may then allow itself more than you meant
to.</div>
<form method="post" action="/pin">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfPin)}">
  <input type="hidden" name="action" value="set">
  <label for="next">PIN</label>
  <input id="next" name="next" type="password" autocomplete="new-password">
  <label for="nextRepeat">PIN again</label>
  <input id="nextRepeat" name="nextRepeat" type="password" autocomplete="new-password">
  <p class="hint">At least 6 characters. It is stored only as a salted hash and never shown to the
  assistant. Type it only into a tab you are using yourself: a tab an assistant is driving at that
  moment can read what is typed into it. A forgotten PIN is removed by deleting the line
  <code>"pin"</code> from the settings file.</p>
  <button type="submit">Set the PIN</button>
</form>`

  return frame(
    'permissions',
    'Permissions',
    data,
    `<h1>Permissions</h1>
<p class="lead">What an assistant may do through this server, and who may change that. Settings
made here apply to every running server at once.</p>

<h2>PIN</h2>
<div class="card">${pin}</div>
${levelTable(data)}
${limitsForm(data)}
${recordForm(data)}`,
  )
}
