/**
 * Turning failures into answers a model can act on.
 *
 * Shared by every tool, so the same situation always produces the same advice.
 *
 * A missing sign-in is handled separately, in withSignIn: it is the one failure
 * with a remedy the server can offer rather than merely describe. Naming that
 * remedy matters. Told only that credentials are missing, a model's next move is
 * to ask the user for their password in the conversation, which is precisely what
 * the web interface exists to prevent.
 */

import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server'
import { BridgeError, type BridgeRemedy } from '../bridge/errors.js'
import { NotSignedInError } from '../bridge/connection.js'
import {
  clientCanShowUrl,
  priorAttempt,
  retryNote,
  signInElicitation,
  signInFailure,
  type MissingCredentials,
} from './sign-in-required.js'

/**
 * Where to sign in. Supplied by the server, which owns the web interface.
 *
 * A function rather than a value: the address only exists once the interface has
 * started, and the interface may fail to start without that stopping the tools.
 */
let signInHint: (() => string | undefined) | undefined

export function setSignInHint(hint: () => string | undefined): void {
  signInHint = hint
}

/**
 * Whether the stored credentials are merely locked.
 *
 * Separate from the address because it is a different question with a different
 * answer for the user. Missing credentials mean fetching the Bridge password;
 * locked ones mean typing the master password the user chose themselves.
 * Telling somebody to do the first when they need the second is how an
 * encrypted file ends up being thrown away.
 *
 * Absent means not locked, which is the safe direction: the sign-in message
 * names both the address and the password, so it is merely more than needed
 * rather than wrong.
 */
let lockedCheck: (() => Promise<boolean>) | undefined

export function setLockedCheck(check: () => Promise<boolean>): void {
  lockedCheck = check
}

/** For tests, which must not inherit a hint from another test. */
export function _clearSignInHint(): void {
  signInHint = undefined
  lockedCheck = undefined
}

/** The sign-in address, when the interface is running. */
export function signInUrl(): string | undefined {
  return signInHint?.()
}

/**
 * Where a message waiting for confirmation can be read.
 *
 * Built from the same address as the sign-in hint, which already carries the
 * access token: the interface refuses anything without it, so a link that
 * dropped the token would lead to a refusal page rather than to the message.
 *
 * Returns nothing when no interface is running. The confirmation then says so
 * rather than offering a link that goes nowhere, because a question asked with
 * less behind it than usual should say as much.
 */
export function previewUrl(digest: string): string | undefined {
  const base = signInHint?.()
  if (!base) return undefined
  try {
    const url = new URL(base)
    url.pathname = `/pending/${digest}`
    return url.toString()
  } catch {
    return undefined
  }
}

/** Which of the two situations the caller is in. */
export async function missingCredentials(): Promise<MissingCredentials> {
  try {
    return (await lockedCheck?.()) === true ? 'locked' : 'not-signed-in'
  } catch {
    // A store that cannot be asked is not a reason to answer nothing at all.
    return 'not-signed-in'
  }
}

/**
 * What to tell the user, for the failures they can do something about.
 *
 * The message from errors.ts says what happened. This says who has to act, and
 * it is written for a model that will otherwise either try again in a loop or
 * invent a remedy of its own. Two things it has to get across every time:
 *
 * - **The Bridge is a desktop application nobody here can start.** A model that
 *   does not know this will keep retrying, or offer to start it.
 * - **A rejected password is not a reason to ask for one in the chat.** The
 *   Bridge generates a new password whenever an account is re-added, so this is
 *   an ordinary event rather than a sign that something is broken.
 */
function remedyFor(remedy: BridgeRemedy, url: string | undefined): string | undefined {
  const page = url ? `\n\nThe configuration page is at ${url}` : ''

  switch (remedy) {
    case 'unreachable':
      return (
        'Tell the user that Proton Mail Bridge does not appear to be reachable, and that they ' +
        'have to start and unlock it themselves: it is a desktop application, and this server ' +
        'can neither start it nor unlock it. Do not retry in a loop. If they say it is running, ' +
        'the ports are the next thing to check, and those can be corrected on the configuration ' +
        `page under Bridge.${page}`
      )
    case 'credentials':
      return (
        'Tell the user that the Bridge refused the stored password and that they need to enter ' +
        'the current one. The Bridge shows it in the application under the account. Do not ask ' +
        `for it in this conversation: the configuration page exists so that it never has to be.${page}`
      )
    case 'not-ready':
      return (
        'Tell the user the Bridge is reachable but not ready yet, which is what starting up and ' +
        'being locked both look like. It passes once they have unlocked it. Waiting a moment and ' +
        'trying once more is reasonable; repeating it without telling them is not.'
      )
    default:
      return undefined
  }
}

/**
 * Describes a failure, and for the ones with a remedy says who has to act.
 *
 * Uses the SDK's own CallToolResult rather than a hand-written shape. Inventing a
 * type here cost me several attempts: the SDK resolves tool handlers against a
 * set of overloads, and any mismatch is reported against the input schema instead
 * of the return value, which sends you looking in entirely the wrong place.
 */
export function describeFailure(error: unknown, context: string): CallToolResult {
  // A missing sign-in is rethrown rather than described, so that withSignIn can
  // take the user through the page. Handling it here would swallow it before the
  // elicitation is ever attempted. That was a real bug, hence this comment.
  if (error instanceof NotSignedInError) throw error

  if (error instanceof BridgeError) {
    const advice = remedyFor(error.remedy, signInUrl())
    const text = advice ? `${error.message}\n\n${advice}` : error.message
    return { content: [{ type: 'text', text }], isError: true }
  }

  return {
    content: [{ type: 'text', text: `Unexpected error while ${context}: ${String(error)}` }],
    isError: true,
  }
}

/**
 * Runs a tool's work, and on a missing sign-in asks the client to take the user
 * to the page.
 *
 * One place for the whole sequence, because every tool needs it and repeating it
 * five times is how the paths drift apart.
 *
 * There is no retry loop in here, and that is the shape of the protocol rather
 * than an omission. The handler returns an input-required result and the call
 * comes back around as a fresh invocation once the client has done its part, so
 * the retry is the `work()` at the top of this function on that second pass. A
 * second pass that still finds no credentials answers with the address in plain
 * text instead of asking again, because asking twice is a loop the user cannot
 * get out of.
 */
export async function withSignIn(
  ctx: unknown,
  // The work may itself want a round trip through the client. Sending does:
  // it asks for a confirmation the same way this asks for a sign-in.
  work: () => Promise<CallToolResult | InputRequiredResult>,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof NotSignedInError)) throw error

    const url = signInUrl()
    const attempt = priorAttempt(ctx)
    const state = await missingCredentials()

    // Already been round once: report it rather than start over.
    if (attempt !== 'none') return signInFailure(url, retryNote(attempt, state), state)

    // Nowhere to send them, or a client that cannot show a link. Either way the
    // address in the answer text is the best available move.
    if (!url || !clientCanShowUrl(ctx)) return signInFailure(url, undefined, state)

    return signInElicitation(url, state)
  }
}
