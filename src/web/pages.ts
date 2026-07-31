/**
 * The pages that come before anybody is signed in.
 *
 * Rendered as strings rather than with a template engine: it keeps the
 * dependency count at zero for something that handles credentials, and there are
 * only a handful of pages.
 *
 * Everything that could come from outside goes through escapeHtml. The CSP would
 * already stop injected script from doing anything, but not from making a mess of
 * the page, and relying on a single layer is how holes happen.
 *
 * These three carry no navigation. There is nothing to navigate to yet, and a
 * rail full of links that all lead back here would suggest otherwise. The
 * sections that appear afterwards are in sections.ts, the frame they share in
 * layout.ts.
 */

import { layout, escapeHtml, errorBanner, type DisclaimerState } from './layout.js'
import {
  EXPOSURE_LABELS,
  type StoreKind,
  type DiskExposure,
} from '../credentials/store.js'
import type { StoreAvailability } from '../credentials/availability.js'

export { escapeHtml, formatDuration } from './layout.js'

function exposureTag(exposure: DiskExposure): string {
  return `<span class="tag exposure-${exposure}">${escapeHtml(EXPOSURE_LABELS[exposure])}</span>`
}

/**
 * One storage option, as a radio inside the sign-in form.
 *
 * It used to be a form of its own that posted the choice and re-rendered the
 * page. That worked and read badly: picking one of four options reloaded
 * everything, and a page that flashes on every click feels like something went
 * wrong. Now the choice travels with the credentials in one submission, and
 * nothing happens until Connect is pressed.
 *
 * The whole card is the label, so the click target is the card rather than a
 * small circle. The radio itself stays a real radio: keyboard and screen readers
 * get the ordinary control, and the styling is a ring around the card.
 */
function storeOption(store: StoreAvailability, suggested: boolean, chosen: boolean): string {
  const classes = ['option']
  if (!store.available) classes.push('unavailable')

  const id = `store-${store.kind}`
  return `<label class="${classes.join(' ')}" for="${id}">
  <input type="radio" name="store" id="${id}" value="${escapeHtml(store.kind)}"
         ${chosen ? 'checked' : ''} ${store.available ? '' : 'disabled'}>
  <div class="option-body">
    <header>
      <h3>${escapeHtml(store.title)}</h3>
      ${exposureTag(store.exposure)}
      <span class="tag">prompts: ${escapeHtml(store.prompts)}</span>
      ${suggested ? '<span class="tag suggested">suggested</span>' : ''}
    </header>
    <p class="hint">${escapeHtml(store.summary)}</p>
    <p class="pro">${escapeHtml(store.benefit)}</p>
    <p class="con">${escapeHtml(store.cost)}</p>
    <p class="who">${escapeHtml(store.bestFor)}</p>
    ${store.reason ? `<p class="blocked">${escapeHtml(store.reason)}</p>` : ''}
  </div>
</label>`
}

/**
 * The warning shown when the plain file is picked.
 *
 * The card already states the cost in one line, and one line is easy to read
 * past when it sits between three other options. This one is in the way, which
 * is the point: it is the only option that leaves a usable password where
 * anything that can read your files can read it.
 *
 * It is not a refusal. The choice stays available and the warning closes, both
 * because the trade is sometimes the right one and because nobody is served by
 * a tool that decides for them. Shown and closed entirely in CSS, since there is
 * no JavaScript here to open a dialog with.
 */
function plainFileWarning(): string {
  return `<div class="warning-layer">
  <label for="warning-seen" class="warning-backdrop" aria-hidden="true"></label>
  <div class="warning-box">
    <h3>The password will be readable</h3>
    <p>A plain file keeps your Bridge password as text. The file is created with mode
    <code>600</code>, so only your user account can read it, and that is the whole of the
    protection: <strong>anything running as you can read it too</strong>, including a program
    you did not mean to run.</p>
    <p class="hint">The other three options all avoid this. The encrypted file works everywhere
    the plain one does and asks for a master password once per start.</p>
    <label for="warning-seen" class="warning-close">I understand, keep this option</label>
  </div>
</div>`
}

export interface LoginPageData {
  token: string
  csrf: string
  /** See sections.ts: required so that it cannot be lost by omission. */
  disclaimer: DisclaimerState
  /** Where the Bridge is expected, prefilled into the advanced block. */
  bridgeHost: string
  bridgeImapPort: number
  bridgeSmtpPort: number
  /** True when the ports came from the environment and are not ours to change. */
  portsLocked: boolean
  /** Opens the advanced block, for when the ports are what went wrong. */
  showAdvanced?: boolean
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
 * Always in the document now, and shown by CSS when that option is selected.
 * They used to be rendered only for that store, which meant selecting it had to
 * reload the page to make them appear.
 *
 * Two fields rather than one: a mistyped master password that nothing anywhere
 * can recover is worth one extra line of typing.
 *
 * They are not disabled while hidden, and that is deliberate. A hidden field
 * submits its value, so a master password typed and then abandoned by switching
 * options would still travel. The server ignores it for any other store, and
 * ignoring it there is the one place that decision belongs.
 */
function masterPasswordFields(): string {
  return `<div class="master-fields">
  <label for="master">Master password for the encrypted file</label>
  <input id="master" name="master" type="password" autocomplete="new-password">
  <p class="hint">Chosen by you, and asked for again every time this server starts. It is not stored
  anywhere: <strong>if you forget it, the saved Bridge password is gone</strong> and you have to
  fetch it from the Bridge again.</p>

  <label for="masterRepeat">Repeat the master password</label>
  <input id="masterRepeat" name="masterRepeat" type="password" autocomplete="new-password">
</div>`
}

/**
 * Where the Bridge is reached, folded away.
 *
 * Almost nobody needs it: the Bridge listens on 1143 and 1025 unless somebody
 * changed that in the Bridge itself. But a wrong port looks exactly like a
 * Bridge that is not running, and finding that out after signing in, in a
 * different section, is a poor way to spend an evening. So it is here, prefilled
 * with what the server will actually use, and closed.
 *
 * `<details>` rather than a scripted panel: it is the browser's own disclosure
 * element and needs nothing this page cannot have.
 *
 * **The host is shown and not editable, and that is deliberate.** A wrong port
 * means nothing works, which is obvious immediately. A wrong host means the
 * Bridge password is handed to another machine at the next connection, which is
 * obvious to nobody. Making it changeable is tracked in #19, where it will sit
 * behind a key that never travels through a tool call, so that changing it stays
 * a deliberate act by the person at the keyboard.
 */
function advancedSettings(data: LoginPageData): string {
  const portFields = data.portsLocked
    ? `<p class="hint">Both ports come from the environment
    (<code>BRIDGE_IMAP_PORT</code>, <code>BRIDGE_SMTP_PORT</code>), so they are not changed here.
    An explicit setting stays explicit.</p>
    <table>
      <tr><th>IMAP port</th><td>${escapeHtml(String(data.bridgeImapPort))}</td></tr>
      <tr><th>SMTP port</th><td>${escapeHtml(String(data.bridgeSmtpPort))}</td></tr>
    </table>`
    : `<label for="imapPort">IMAP port</label>
  <input id="imapPort" name="imapPort" type="text" inputmode="numeric"
         value="${escapeHtml(String(data.bridgeImapPort))}">

  <label for="smtpPort">SMTP port</label>
  <input id="smtpPort" name="smtpPort" type="text" inputmode="numeric"
         value="${escapeHtml(String(data.bridgeSmtpPort))}">
  <p class="hint">The defaults are what the Bridge uses unless you changed them in the Bridge
  itself, where you also find the real ones under its settings. They are saved along with the
  sign-in and can be changed later under Bridge.</p>`

  return `<details class="card advanced"${data.showAdvanced ? ' open' : ''}>
  <summary>Advanced: where the Bridge is reached</summary>

  <label for="bridgeHostShown">Address of the Bridge</label>
  <input id="bridgeHostShown" type="text" value="${escapeHtml(data.bridgeHost)}" disabled>
  <p class="hint">Set with <code>BRIDGE_HOST</code> and not editable here yet. A wrong port means
  nothing works and you notice at once; a wrong address means your Bridge password goes to another
  machine and nobody notices at all. Making it changeable in the browser is planned, behind a key
  that no assistant can reach.</p>

  ${portFields}
</details>`
}

/**
 * The sign-in form.
 *
 * One form for everything: the address, the password and where the password
 * goes. Nothing is submitted until Connect is pressed, so choosing among the
 * four options costs no round trip and the page does not move under the
 * pointer.
 *
 * Two things appear and disappear with the selection, both in CSS: the master
 * password fields for the encrypted file, and the warning for the plain file.
 * See the stylesheet for how, and for what happens in a browser too old to do
 * it.
 */
export function loginPage(data: LoginPageData): string {
  const effective = data.chosen ?? data.suggested
  const options = data.stores
    .map((store) => storeOption(store, store.kind === data.suggested, store.kind === effective))
    .join('\n')

  return layout({
    title: 'Sign in',
    section: 'none',
    token: data.token,
    disclaimer: data.disclaimer,
    body: `<h1>Connect to Proton Mail Bridge</h1>
<p class="lead">Enter the credentials the Bridge generated for your account. This page runs on your
own machine and the password is never sent anywhere else.</p>

${errorBanner(data.error)}

<form method="post" action="/sign-in?token=${escapeHtml(data.token)}" class="sign-in">
  <input type="hidden" name="csrf" value="${escapeHtml(data.csrf)}">
  <input type="checkbox" id="warning-seen" class="offscreen">

<div class="card">
  <label for="address">Proton address</label>
  <input id="address" name="address" type="text" autocomplete="off" spellcheck="false"
         value="${escapeHtml(data.address ?? '')}" placeholder="you@example.com">
  <p class="hint">The address as it appears in the Bridge.</p>

  <label for="password">Bridge password</label>
  <input id="password" name="password" type="password" autocomplete="off">
  <p class="hint"><strong>Not your Proton account password.</strong> The Bridge generates a separate
  one per account. You find it in the Bridge application under the account, or by running
  <code>protonmail-bridge --cli</code> and then <code>info</code>.</p>

${masterPasswordFields()}
</div>

<h2>Where should the password be kept?</h2>
<p class="lead">${escapeHtml(data.suggestionReason)}</p>
${options}

${advancedSettings(data)}

<div class="card">
  <button type="submit">Connect</button>
  <p class="hint">Nothing is sent until you press this. The Bridge is asked whether the credentials
  work before they are stored anywhere.</p>
</div>

${plainFileWarning()}
</form>`,
  })
}

export interface UnlockPageData {
  token: string
  csrf: string
  disclaimer: DisclaimerState
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
  return layout({
    title: 'Unlock',
    section: 'none',
    token: data.token,
    disclaimer: data.disclaimer,
    body: `<h1>Unlock the stored credentials</h1>
<p class="lead">Your Bridge password is saved in an encrypted file. Enter the master password you
chose for it and the server can connect again.</p>

${errorBanner(data.error)}

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
  })
}

/** Shown when a request is rejected. Deliberately says little. */
export function rejectionPage(): string {
  return layout({
    title: 'Not available',
    section: 'none',
    body: `<h1>Not available</h1>
<p>This request was refused. Either the link is wrong or it has expired.</p>
<p class="hint">The address for this interface is printed by the server when it asks you to sign in,
and it changes every time the server restarts.</p>`,
  })
}
