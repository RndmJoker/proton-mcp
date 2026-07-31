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
  /** See sections.ts: required so that it cannot be lost by omission. */
  disclaimer: DisclaimerState
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

  return layout({
    title: 'Sign in',
    section: 'none',
    token: data.token,
    disclaimer: data.disclaimer,
    body: `<h1>Connect to Proton Mail Bridge</h1>
<p class="lead">Enter the credentials the Bridge generated for your account. This page runs on your
own machine and the password is never sent anywhere else.</p>

${errorBanner(data.error)}

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
