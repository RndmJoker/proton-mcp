/**
 * What a tool does when nobody has signed in.
 *
 * The point is narrow and worth stating plainly: a model told only that
 * credentials are missing will ask the user to type their Bridge password into
 * the chat, where it lands in a transcript. So the answer always names the local
 * page instead, and says not to ask.
 *
 * Two ways of getting the user there:
 *
 * 1. **URL elicitation**, which the specification provides for exactly this
 *    case. The client shows the address, the user signs in, and the tool call
 *    is retried.
 * 2. **A plain failure naming the address**, for clients that cannot elicit.
 *
 * ## Why this is a returned value and not a call
 *
 * The obvious-looking route, `ctx.mcpReq.elicitInput({mode:'url'})`, cannot work
 * here. Protocol revision 2026-07-28 has no server-to-client request channel at
 * all, and `serveStdio` marks its server instance as that era at construction.
 * The push API therefore throws on every call this server will ever serve. That
 * is why the earlier attempt at this never elicited anything and always fell
 * back to the text.
 *
 * The replacement is a value the handler RETURNS: `inputRequired(...)` with an
 * embedded URL elicitation. The client fulfils it and calls the tool again, so
 * the retry is an ordinary second invocation rather than a loop inside the
 * handler.
 *
 * The SDK's shim fulfils such a return on a 2025-era connection as well, and it
 * does so under `serveStdio` too. An earlier note here said otherwise, on the
 * strength of a measurement that must have been taken against a different
 * serving mode; re-measured on 31.07.2026 against SDK 2.0.0, `serveStdio` pins
 * one instance for the life of the connection, the returned request reaches the
 * client as an `elicitation/create`, and the answer comes back. The text answer
 * below is therefore the fallback for a client that declares nothing, not for
 * every client. See clientCanShowUrl.
 *
 * ## No requestState
 *
 * `inputRequired` also accepts an opaque `requestState` that travels through the
 * client and comes back. We do not use it. Whether someone is signed in is
 * answered by asking the session, which is the truth; a claim carried back
 * through the client would be attacker-controlled input that we would then have
 * to integrity-protect for no gain. The embedded request alone satisfies the
 * protocol's at-least-one rule.
 */

import { inputRequired, inputResponse } from '@modelcontextprotocol/server'
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server'
import { canElicitUrl } from './capabilities.js'

/**
 * The key our embedded elicitation is filed under.
 *
 * Also how a retry is recognised: a response under this key means the client has
 * already taken the user to the page once.
 */
export const SIGN_IN_KEY = 'protonMcpSignIn'

const MESSAGE =
  'proton-mcp is not signed in to Proton Mail Bridge yet. Open the configuration page and enter ' +
  'the Proton address together with the Bridge password, which is the one the Bridge generates ' +
  'and not the Proton account password.'

/**
 * The other reason a tool finds no credentials: they are on disk, encrypted.
 *
 * A separate message because the remedy is a different one, and the message
 * above sends the user to the wrong place entirely. Nothing has to be looked up
 * in the Bridge and no address has to be typed: the Bridge password is already
 * stored, and the one thing missing is the master password that decrypts it,
 * which is asked for once per start and never kept.
 *
 * Telling somebody to fetch their Bridge password when all they need is the
 * password they chose themselves is the kind of wrong advice that ends with the
 * encrypted file being thrown away.
 */
const LOCKED_MESSAGE =
  'proton-mcp has credentials stored, in an encrypted file that is not open yet. It needs the ' +
  'master password that was chosen when they were saved. Nothing else is missing: the Bridge ' +
  'password is already on disk, and no address has to be entered again.'

/** Which of the two situations a caller is in. */
export type MissingCredentials = 'not-signed-in' | 'locked'

function messageFor(state: MissingCredentials): string {
  return state === 'locked' ? LOCKED_MESSAGE : MESSAGE
}

/** The parts of the tool context this module reads. */
interface SignInContext {
  mcpReq?: {
    /** Present when the client is retrying after fulfilling our request. */
    inputResponses?: Record<string, unknown>
  }
}

/**
 * Whether the client said it can show a URL.
 *
 * Asked in advance rather than attempted and caught, because there is nothing to
 * catch: an embedded request the client never declared support for is refused by
 * the SDK *after* the handler returns. The caller would get that refusal instead
 * of an address, so an undeclared capability means the text answer.
 *
 * The paragraph that used to stand here claimed, as a measurement, that only the
 * request's own envelope could be consulted and that a handshake declaration was
 * unavailable under `serveStdio`. That was wrong, and it was wrong in the
 * expensive direction: on this SDK the envelope does not exist at all, so the
 * check answered no for every client and the elicitation never once fired. Where
 * the declaration now comes from is in capabilities.ts.
 */
export function clientCanShowUrl(ctx: unknown): boolean {
  return canElicitUrl(ctx)
}

/** The failure used when elicitation is unavailable, declined or fruitless. */
export function signInFailure(
  url: string | undefined,
  note?: string,
  state: MissingCredentials = 'not-signed-in',
): CallToolResult {
  const message = messageFor(state)
  const head = note ? `${note}\n\n${message}` : message

  if (!url) {
    // No page to send anyone to. For a locked file that is a dead end worth
    // naming as one: the master password can only be entered there.
    const text =
      state === 'locked'
        ? `${head}\n\nThe configuration page is not running, so the file cannot be unlocked right ` +
          'now. It failed to start, most likely because its port was in use; setting ' +
          'PROTON_MCP_WEB_PORT to a free port and restarting is the way out. Do not ask for the ' +
          'master password in this conversation.'
        : `${head}\n\nThe configuration page is not running. Set BRIDGE_USER and BRIDGE_PASS in ` +
          'the environment instead. Do not ask for the password in this conversation.'
    return { content: [{ type: 'text', text }], isError: true }
  }

  const instruction =
    state === 'locked'
      ? 'Tell the user to open it and enter their master password there. Do not ask for the ' +
        'master password in this conversation: it is the one thing that can decrypt the stored ' +
        'credentials, and it has no business in a transcript.'
      : 'Tell the user to open it and sign in there. Do not ask for the password in this ' +
        'conversation.'

  return {
    content: [{ type: 'text', text: `${head}\n\nOpen ${url}\n\n${instruction}` }],
    isError: true,
  }
}

/**
 * Asks the client to take the user to the sign-in page.
 *
 * Returned from the handler, not sent. See the note at the top of this file for
 * why that is the only thing that can work here.
 */
export function signInElicitation(
  url: string,
  state: MissingCredentials = 'not-signed-in',
): InputRequiredResult {
  return inputRequired({
    inputRequests: {
      [SIGN_IN_KEY]: inputRequired.elicitUrl({ message: messageFor(state), url }),
    },
  })
}

/** What came back from a previous round, if this call is a retry. */
export type PriorAttempt = 'none' | 'accepted' | 'refused'

/**
 * Whether the client has already been through the sign-in page for this call.
 *
 * "accepted" means the user was shown the page and said they were done, so a
 * still-missing sign-in is a real failure rather than a reason to ask again.
 * Asking twice in a row would be a loop the user cannot escape.
 */
export function priorAttempt(ctx: unknown): PriorAttempt {
  const responses = (ctx as SignInContext)?.mcpReq?.inputResponses
  if (!responses) return 'none'
  const view = inputResponse(responses, SIGN_IN_KEY)
  if (view.kind === 'missing') return 'none'
  if (view.kind === 'elicit' && view.action === 'accept') return 'accepted'
  return 'refused'
}

/** The note explaining a retry that still found no credentials. */
export function retryNote(
  attempt: PriorAttempt,
  state: MissingCredentials = 'not-signed-in',
): string | undefined {
  if (attempt === 'accepted') {
    if (state === 'locked') {
      return 'The page was opened but the credentials are still locked, so the master password was not entered.'
    }
    return 'The sign-in page was opened but no credentials arrived, so the sign-in was not completed.'
  }
  if (attempt === 'refused') {
    return 'The request to open the sign-in page was declined or cancelled.'
  }
  return undefined
}
