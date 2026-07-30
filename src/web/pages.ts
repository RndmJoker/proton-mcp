/**
 * The HTML of the local interface.
 *
 * Rendered as strings rather than with a template engine: it keeps the
 * dependency count at zero for something that handles credentials, and there are
 * only a handful of pages.
 *
 * Everything that could come from outside goes through escapeHtml. The CSP would
 * already stop injected script from doing anything, but not from making a mess of
 * the page, and relying on a single layer is how holes happen.
 *
 * The look borrows Proton's palette so the interface does not feel foreign next
 * to the Bridge. It deliberately uses no Proton logo, wordmark or icon, and every
 * page states that this is not an official Proton project.
 */

import {
  EXPOSURE_LABELS,
  type StoreKind,
  type DiskExposure,
} from '../credentials/store.js'
import type { StoreAvailability } from '../credentials/availability.js'

/** Escapes text for use in HTML. Applied to everything, without exception. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Proton's palette, close enough to feel related and not copied.
 *
 * No logo and no wordmark: those are trademarks, and this is not their project.
 */
const STYLES = `
  :root {
    --violet: #6d4aff;
    --violet-dark: #5b35f0;
    --ink: #1b1340;
    --text: #22143f;
    --muted: #6b6483;
    --line: #e3e0ee;
    --surface: #ffffff;
    --page: #f5f4fa;
    --warn-bg: #fff8e6;
    --warn-line: #e8c56b;
    --bad-bg: #fdeaea;
    --bad-line: #e08585;
    --good-bg: #eaf7ef;
    --good-line: #7fc899;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--text);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .bar { background: var(--ink); color: #fff; padding: 14px 24px; }
  .bar strong { font-weight: 600; letter-spacing: 0.01em; }
  .bar .unofficial {
    display: inline-block;
    margin-left: 12px;
    padding: 2px 8px;
    border: 1px solid rgba(255,255,255,0.45);
    border-radius: 4px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  main { max-width: 780px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  p { margin: 8px 0; }
  .lead { color: var(--muted); margin-bottom: 24px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 20px;
    margin: 16px 0;
  }
  .disclaimer {
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
    border-radius: 10px;
    padding: 14px 18px;
    margin: 0 0 24px;
    font-size: 14px;
  }
  label { display: block; margin: 16px 0 4px; font-weight: 600; font-size: 14px; }
  input[type=text], input[type=password] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    font: inherit;
  }
  input:focus { outline: 2px solid var(--violet); border-color: var(--violet); }
  button {
    margin-top: 20px;
    background: var(--violet);
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 11px 20px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: var(--violet-dark); }
  /*
   * Actions that destroy something do not get the colour of the action you are
   * meant to take. Deleting the credentials file and signing out both belong
   * here: they are the right answer sometimes, never the obvious one.
   */
  button.danger {
    background: var(--surface);
    color: #8f2d2d;
    border: 1px solid var(--bad-line);
  }
  button.danger:hover { background: var(--bad-bg); }
  .hint { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .option { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 10px 0; }
  .option.unavailable { opacity: 0.62; }
  .option.chosen { border-color: var(--violet); box-shadow: 0 0 0 1px var(--violet); }
  .option header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .option h3 { font-size: 16px; margin: 0; }
  .tag {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .tag.exposure-none { background: var(--good-bg); border-color: var(--good-line); color: #2f6b46; }
  .tag.exposure-os-protected { background: var(--good-bg); border-color: var(--good-line); color: #2f6b46; }
  .tag.exposure-encrypted { background: var(--warn-bg); border-color: var(--warn-line); color: #7a5a12; }
  .tag.exposure-plaintext { background: var(--bad-bg); border-color: var(--bad-line); color: #8f2d2d; }
  .tag.suggested { background: #efeaff; border-color: var(--violet); color: var(--violet-dark); }
  .tag.chosen { background: var(--violet); border-color: var(--violet); color: #fff; }
  .pro, .con, .who { font-size: 14px; margin: 6px 0; }
  .pro::before { content: "Good: "; font-weight: 600; color: #2f6b46; }
  .con::before { content: "Cost: "; font-weight: 600; color: #8f2d2d; }
  .who::before { content: "Best for: "; font-weight: 600; color: var(--muted); }
  .blocked { font-size: 14px; margin: 6px 0; color: #8f2d2d; }
  .blocked::before { content: "Not available here: "; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  code { background: #efedf6; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  footer { color: var(--muted); font-size: 13px; margin: 32px 0 8px; }
  .error {
    background: var(--bad-bg);
    border: 1px solid var(--bad-line);
    border-radius: 10px;
    padding: 14px 18px;
    margin: 16px 0;
  }
  .notice {
    background: var(--good-bg);
    border: 1px solid var(--good-line);
    border-radius: 10px;
    padding: 14px 18px;
    margin: 16px 0;
  }
  a { color: var(--violet-dark); }
`

/** The statement that this is not Proton's software. On every page. */
const DISCLAIMER =
  'This is <strong>proton-mcp</strong>, an unofficial open source tool. It is not made by, ' +
  'affiliated with or endorsed by Proton AG. "Proton" and "Proton Mail" are their trademarks. ' +
  'This interface only talks to the Proton Mail Bridge running on your own machine.'

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} - proton-mcp</title>
<style>${STYLES}</style>
</head>
<body>
<div class="bar"><strong>proton-mcp</strong><span class="unofficial">unofficial</span></div>
<main>
<div class="disclaimer">${DISCLAIMER}</div>
${body}
<footer>Running locally on 127.0.0.1. Not reachable from anywhere else.</footer>
</main>
</body>
</html>
`
}

function exposureTag(exposure: DiskExposure): string {
  return `<span class="tag exposure-${exposure}">${escapeHtml(EXPOSURE_LABELS[exposure])}</span>`
}

/** One storage option, with both sides of the judgement. */
function storeOption(
  store: StoreAvailability,
  suggested: boolean,
  chosen: boolean,
  csrf: string,
  token: string,
): string {
  // The chosen option gets no button: pressing it again would do nothing, and a
  // live button next to the word "selected" invites the doubt this is meant to
  // remove.
  const button =
    store.available && !chosen
      ? `<form method="post" action="/choose-store?token=${escapeHtml(token)}">
         <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
         <input type="hidden" name="kind" value="${escapeHtml(store.kind)}">
         <button type="submit">Use this</button>
       </form>`
      : ''

  const classes = ['option']
  if (!store.available) classes.push('unavailable')
  if (chosen) classes.push('chosen')

  return `<div class="${classes.join(' ')}">
  <header>
    <h3>${escapeHtml(store.title)}</h3>
    ${exposureTag(store.exposure)}
    <span class="tag">prompts: ${escapeHtml(store.prompts)}</span>
    ${chosen ? '<span class="tag chosen">selected</span>' : ''}
    ${suggested && !chosen ? '<span class="tag suggested">suggested</span>' : ''}
  </header>
  <p class="hint">${escapeHtml(store.summary)}</p>
  <p class="pro">${escapeHtml(store.benefit)}</p>
  <p class="con">${escapeHtml(store.cost)}</p>
  <p class="who">${escapeHtml(store.bestFor)}</p>
  ${store.reason ? `<p class="blocked">${escapeHtml(store.reason)}</p>` : ''}
  ${button}
</div>`
}

export interface LoginPageData {
  token: string
  csrf: string
  /**
   * CSRF token for picking a store, bound to that action alone.
   *
   * Separate from `csrf` because the check binds a token to the path it is
   * posted to. Reusing the sign-in token here made every "Use this" button
   * answer 404, which is what kept the encrypted file from being selectable at
   * all.
   */
  csrfChooseStore: string
  stores: StoreAvailability[]
  suggested: StoreKind
  suggestionReason: string
  /** What the user picked, if they picked anything. Falls back to the suggestion. */
  chosen?: StoreKind
  /** Shown when a previous attempt failed. */
  error?: string
  /** Prefilled address, so a failed attempt does not lose it. */
  address?: string
}

/**
 * The extra fields the encrypted file needs.
 *
 * Only rendered for that one store, because it is the only one with a secret of
 * its own. Two fields rather than one: a mistyped master password that nothing
 * anywhere can recover is worth one extra line of typing.
 */
function masterPasswordFields(): string {
  return `  <label for="master">Master password for the encrypted file</label>
  <input id="master" name="master" type="password" autocomplete="new-password">
  <p class="hint">Chosen by you, and asked for again every time this server starts. It is not stored
  anywhere: <strong>if you forget it, the saved Bridge password is gone</strong> and you have to
  fetch it from the Bridge again.</p>

  <label for="masterRepeat">Repeat the master password</label>
  <input id="masterRepeat" name="masterRepeat" type="password" autocomplete="new-password">
`
}

export function loginPage(data: LoginPageData): string {
  const effective = data.chosen ?? data.suggested
  const options = data.stores
    .map((store) =>
      storeOption(
        store,
        store.kind === data.suggested,
        store.kind === effective,
        data.csrfChooseStore,
        data.token,
      ),
    )
    .join('\n')

  const chosenTitle = data.stores.find((s) => s.kind === effective)?.title ?? effective

  return layout(
    'Sign in',
    `<h1>Connect to Proton Mail Bridge</h1>
<p class="lead">Enter the credentials the Bridge generated for your account. This page runs on your
own machine and the password is never sent anywhere else.</p>

${data.error ? `<div class="error">${escapeHtml(data.error)}</div>` : ''}

<div class="card">
<form method="post" action="/sign-in?token=${escapeHtml(data.token)}">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrf)}">
  <label for="address">Proton address</label>
  <input id="address" name="address" type="text" autocomplete="off" spellcheck="false"
         value="${escapeHtml(data.address ?? '')}" placeholder="you@example.com">
  <p class="hint">The address as it appears in the Bridge.</p>

  <label for="password">Bridge password</label>
  <input id="password" name="password" type="password" autocomplete="off">
  <p class="hint"><strong>Not your Proton account password.</strong> The Bridge generates a separate
  one per account. You find it in the Bridge application under the account, or by running
  <code>protonmail-bridge --cli</code> and then <code>info</code>.</p>

${effective === 'encrypted-file' ? masterPasswordFields() : ''}
  <p class="hint">Will be kept in: <strong>${escapeHtml(chosenTitle)}</strong>. Change that below
  before connecting.</p>

  <button type="submit">Connect</button>
</form>
</div>

<h2>Where should the password be kept?</h2>
<p class="lead">${escapeHtml(data.suggestionReason)}</p>
${options}`,
  )
}

export interface UnlockPageData {
  token: string
  csrf: string
  /** CSRF token for throwing the file away, bound to that action alone. */
  csrfDiscard: string
  path: string
  error?: string
}

/**
 * Asked for when an encrypted credentials file exists but is not open yet.
 *
 * The counterpart to the sign-in form, and the reason the encrypted option is
 * usable at all: after a restart the Bridge password is still on disk, so the
 * only thing missing is the one password that decrypts it.
 *
 * It also offers the way out. Someone who forgot their master password cannot
 * be left on a page that only accepts the thing they do not have.
 */
export function unlockPage(data: UnlockPageData): string {
  return layout(
    'Unlock',
    `<h1>Unlock the stored credentials</h1>
<p class="lead">Your Bridge password is saved in an encrypted file. Enter the master password you
chose for it and the server can connect again.</p>

${data.error ? `<div class="error">${escapeHtml(data.error)}</div>` : ''}

<div class="card">
<form method="post" action="/unlock?token=${escapeHtml(data.token)}">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrf)}">
  <label for="master">Master password</label>
  <input id="master" name="master" type="password" autocomplete="current-password" autofocus>
  <p class="hint">The file is at <code>${escapeHtml(data.path)}</code>. Nothing but this password
  can open it, not even this server.</p>
  <button type="submit">Unlock</button>
</form>
</div>

<div class="card">
<h2>Forgot the master password?</h2>
<p>Then the file cannot be opened, by anyone. Throwing it away is the only way forward. You will
have to look your Bridge password up in the Bridge again and sign in from scratch.</p>
<form method="post" action="/discard-encrypted?token=${escapeHtml(data.token)}">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfDiscard)}">
  <button type="submit" class="danger">Delete the file and start over</button>
</form>
</div>`,
  )
}

/** Renders a duration the way a person would say it. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** A wall-clock time, local to whoever is looking at the page. */
function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString()
}

export interface StatusPageData {
  token: string
  /** CSRF token for the sign-out form, bound to that action alone. */
  csrfSignOut: string
  /** CSRF token for changing the ports. */
  csrfSettings: string
  /** CSRF token for the connection test. */
  csrfTest: string
  connected: boolean
  address?: string
  storeKind?: StoreKind
  storeTitle?: string
  mailboxCount?: number
  messageCount?: number
  unseenCount?: number
  bridgeHost: string
  bridgeImapPort: number
  bridgeSmtpPort: number
  /** True when the port came from the environment and cannot be changed here. */
  portsLocked: boolean
  readOnly: boolean
  webPort: number
  /** How long this process has been running. */
  uptimeMs: number
  certificate?: {
    fingerprint: string
    subject: string
    firstSeen: string
  }
  /** Calls in progress, so a slow search is visibly a slow search. */
  running: Array<{ tool: string; forMs: number }>
  /** Finished calls, newest first. */
  recent: Array<{ tool: string; at: number; durationMs: number; outcome: 'ok' | 'failed' }>
  error?: string
  /** Shown after something worked, so the page is not silent on success. */
  notice?: string
}

/** The table of what the server has been doing. */
function activitySection(data: StatusPageData): string {
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

  return `<h2>Activity</h2>
<div class="card">${running}</div>
<div class="card">
${recent}
<p class="hint">Tool names and timings only. What was searched for, which message was read and which
mailbox was opened are deliberately not recorded: that would turn this page into a log of your mail
habits.</p>
</div>`
}

export function statusPage(data: StatusPageData): string {
  const rows: Array<[string, string]> = [
    ['Connection', data.connected ? 'connected' : 'not connected'],
    ['Address', data.address ?? 'not signed in'],
    ['Credentials kept in', data.storeTitle ?? 'nowhere yet'],
    ['Bridge IMAP', `${data.bridgeHost}:${data.bridgeImapPort}`],
    ['Bridge SMTP', `${data.bridgeHost}:${data.bridgeSmtpPort}`],
    ['Mode', data.readOnly ? 'read-only, nothing can be changed or sent' : 'read and write'],
    ['This interface', `127.0.0.1:${data.webPort}`],
    ['Server running for', formatDuration(data.uptimeMs)],
  ]
  if (data.mailboxCount !== undefined) rows.push(['Mailboxes', String(data.mailboxCount)])
  if (data.messageCount !== undefined) {
    const unseen = data.unseenCount === undefined ? '' : ` (${data.unseenCount} unread)`
    rows.push(['Messages in inbox', `${data.messageCount}${unseen}`])
  }

  const table = rows
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('\n')

  const certificate = data.certificate
    ? `<h2>Bridge certificate</h2>
<div class="card">
<table>
<tr><th>Fingerprint (SHA-256)</th><td><code>${escapeHtml(data.certificate.fingerprint)}</code></td></tr>
<tr><th>Subject</th><td>${escapeHtml(data.certificate.subject)}</td></tr>
<tr><th>First seen</th><td>${escapeHtml(data.certificate.firstSeen.slice(0, 10))}</td></tr>
</table>
<p class="hint">The Bridge signs its own certificate, so it was recorded on first use and is checked
against that record every time. If it ever changes, the server refuses to connect rather than hand
your password to whatever is answering on that port.</p>
</div>`
    : `<h2>Bridge certificate</h2>
<div class="card"><p class="hint">Nothing recorded yet. The certificate is read and pinned on the
first connection to the Bridge.</p></div>`

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

  return layout(
    'Status',
    `<h1>Status</h1>
<p class="lead">What this server currently knows. No message content is shown here: this interface is
for configuration and state, not a mail client.</p>
${data.error ? `<div class="error">${escapeHtml(data.error)}</div>` : ''}
${data.notice ? `<div class="notice">${escapeHtml(data.notice)}</div>` : ''}
<div class="card"><table>${table}</table></div>

<div class="card">
<form method="post" action="/test-connection?token=${escapeHtml(data.token)}">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrfTest)}">
  <p>Checks that the Bridge answers on the ports above and accepts the stored credentials.</p>
  <button type="submit">Test the connection</button>
</form>
</div>

${activitySection(data)}

<h2>Mailboxes</h2>
<div class="card">
<p>Folder and label names are shown only when you ask for them. They belong to the whole Proton
account rather than to one address, and a folder named after your bank, your employer or a government
office gives that away on its own, even when every message inside it stays invisible.</p>
<p><a href="/mailboxes?token=${escapeHtml(data.token)}">Show the folders and labels</a></p>
</div>

<h2>Bridge ports</h2>
<div class="card">${ports}</div>

${certificate}

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

export interface MailboxPageData {
  token: string
  mailboxes: Array<{ path: string; kind: 'system' | 'folder' | 'label'; selectable: boolean }>
  error?: string
}

/**
 * The folders and labels, on their own page.
 *
 * Its own page because of what these names are. They belong to the Proton
 * account, not the address that signed in, so this is the full structure of the
 * account even when the mail in it is invisible. Showing that as part of an
 * answer nobody asked for would hand it over unasked.
 */
export function mailboxPage(data: MailboxPageData): string {
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

  return layout(
    'Mailboxes',
    `<h1>Folders and labels</h1>
<p class="lead">Names only, never contents. Proton distinguishes folders, where a message lives in
exactly one, from labels, where it can carry any number.</p>
${data.error ? `<div class="error">${escapeHtml(data.error)}</div>` : ''}
${sections || '<div class="card"><p class="hint">No mailboxes were returned.</p></div>'}
<p><a href="/?token=${escapeHtml(data.token)}">Back to the status page</a></p>`,
  )
}

/** Shown when a request is rejected. Deliberately says little. */
export function rejectionPage(): string {
  return layout(
    'Not available',
    `<h1>Not available</h1>
<p>This request was refused. Either the link is wrong or it has expired.</p>
<p class="hint">The address for this interface is printed by the server when it asks you to sign in,
and it changes every time the server restarts.</p>`,
  )
}
