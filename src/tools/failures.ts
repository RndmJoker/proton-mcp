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
import { BridgeError } from '../bridge/errors.js'
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
 * Describes a failure.
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

  const text =
    error instanceof BridgeError
      ? error.message
      : `Unexpected error while ${context}: ${String(error)}`
  return { content: [{ type: 'text', text }], isError: true }
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
