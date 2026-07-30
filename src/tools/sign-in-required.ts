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
 * The SDK documents a shim that fulfils such a return on 2025-era connections
 * too, but not under `serveStdio`: measured against the live SDK it answers
 * "per-request legacy serving cannot receive server-to-client requests". Older
 * clients therefore get the text answer, which needs nothing from the client and
 * works everywhere. See clientCanShowUrl.
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

/**
 * The key our embedded elicitation is filed under.
 *
 * Also how a retry is recognised: a response under this key means the client has
 * already taken the user to the page once.
 */
export const SIGN_IN_KEY = 'protonMcpSignIn'

/** Where the client's declared capabilities live on a 2026-era request. */
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'

const MESSAGE =
  'proton-mcp is not signed in to Proton Mail Bridge yet. Open the configuration page and enter ' +
  'the Proton address together with the Bridge password, which is the one the Bridge generates ' +
  'and not the Proton account password.'

/** The parts of the tool context this module reads. */
interface SignInContext {
  mcpReq?: {
    /** Reserved `_meta` keys of the request, on the 2026-07-28 era. */
    envelope?: Record<string, unknown>
    /** Present when the client is retrying after fulfilling our request. */
    inputResponses?: Record<string, unknown>
  }
}

/**
 * Whether a capabilities object declares URL elicitation.
 *
 * The wire shape is `elicitation: { url: {} }`, a nested record rather than a
 * boolean. Measured against the live SDK, which answers a `url: true` with
 * "expected record, received boolean" and refuses the whole request. So this is
 * a presence check, matching the SDK's own gate, and not a comparison against
 * `true` that no real client would ever satisfy.
 *
 * Typed as unknown and narrowed by hand on purpose: the client sent this, so its
 * shape is a claim rather than a guarantee.
 */
function declaresUrlElicitation(capabilities: unknown): boolean {
  const elicitation = (capabilities as { elicitation?: unknown } | undefined)?.elicitation
  const url = (elicitation as { url?: unknown } | undefined)?.url
  return url !== undefined && url !== null && url !== false
}

/**
 * Whether the client said it can show a URL.
 *
 * Asked in advance rather than attempted and caught, because there is nothing to
 * catch: an embedded request the client never declared support for is refused by
 * the SDK *after* the handler returns. The caller would get that refusal instead
 * of an address, so an undeclared capability means the text answer.
 *
 * Only the request's own envelope is consulted, and that is a measured decision
 * rather than an oversight. An older client declares its capabilities once at
 * handshake time, so the obvious addition is to fall back to
 * `server.getClientCapabilities()`. Tried against the live SDK, it returns
 * undefined under `serveStdio`, and forcing the elicitation through anyway
 * yields the SDK's own verdict:
 *
 *   "per-request legacy serving cannot receive server-to-client requests"
 *
 * So there is no elicitation to be had on a 2025-era connection here at all. A
 * fallback would only ever turn a usable answer into that message, which is why
 * older clients get the address in plain text instead. That path works
 * everywhere and needs nothing from the client.
 */
export function clientCanShowUrl(ctx: unknown): boolean {
  return declaresUrlElicitation(
    (ctx as SignInContext)?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_KEY],
  )
}

/** The failure used when elicitation is unavailable, declined or fruitless. */
export function signInFailure(url: string | undefined, note?: string): CallToolResult {
  const head = note ? `${note}\n\n${MESSAGE}` : MESSAGE
  const text = url
    ? `${head}\n\nOpen ${url}\n\nTell the user to open it and sign in there. Do not ask for the ` +
      'password in this conversation.'
    : `${head}\n\nThe configuration page is not running. Set BRIDGE_USER and BRIDGE_PASS in the ` +
      'environment instead. Do not ask for the password in this conversation.'
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * Asks the client to take the user to the sign-in page.
 *
 * Returned from the handler, not sent. See the note at the top of this file for
 * why that is the only thing that can work here.
 */
export function signInElicitation(url: string): InputRequiredResult {
  return inputRequired({
    inputRequests: {
      [SIGN_IN_KEY]: inputRequired.elicitUrl({ message: MESSAGE, url }),
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
export function retryNote(attempt: PriorAttempt): string | undefined {
  if (attempt === 'accepted') {
    return 'The sign-in page was opened but no credentials arrived, so the sign-in was not completed.'
  }
  if (attempt === 'refused') {
    return 'The request to open the sign-in page was declined or cancelled.'
  }
  return undefined
}
