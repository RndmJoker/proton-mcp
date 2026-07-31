/**
 * What the client said it can do.
 *
 * One module, because two places ask the same question and one of them decides
 * whether a message may be sent. When they read different sources they give
 * different answers, and the answer that matters is the one that refuses.
 *
 * ## Why this exists at all
 *
 * The first version of both checks read the capabilities out of the request's
 * `_meta` envelope, under `io.modelcontextprotocol/clientCapabilities`. That key
 * belongs to protocol revision 2026-07-28. The SDK in use here does not speak
 * that revision at all: its newest is 2025-11-25, and on such a connection the
 * envelope is not merely empty but absent.
 *
 * So the check answered "this client cannot show a form" for every client that
 * ever connected, and every send was refused. Fail-closed, so nothing went out
 * without a confirmation. It also meant nothing went out at all.
 *
 * Measured on 31.07.2026 against `serveStdio` with SDK 2.0.0:
 *
 * | Source | On a 2025-11-25 connection |
 * | :--- | :--- |
 * | `ctx.mcpReq.envelope` | absent |
 * | `server.server.getClientCapabilities()` | the declaration, complete |
 *
 * And the round trip itself works: a returned `inputRequired` reaches the client
 * as an `elicitation/create`, the answer comes back, and the handler runs a
 * second time with it. Only the question of whether to try was broken.
 *
 * ## Both sources, not one
 *
 * The envelope is asked first and the handshake second, rather than replacing
 * one with the other. The envelope is per request and is what a 2026-era
 * connection carries; the handshake is per connection and is what this era has.
 * A server that has to guess which one exists is a server that breaks on the
 * next SDK release, in whichever direction it moves.
 */

/** Reserved `_meta` key carrying the capabilities on a 2026-era request. */
const ENVELOPE_KEY = 'io.modelcontextprotocol/clientCapabilities'

/**
 * The declaration made at handshake time.
 *
 * A function, and registered rather than imported: it belongs to the server
 * instance, which is built inside the connection factory and does not exist when
 * this module is loaded.
 */
let handshake: (() => unknown) | undefined

export function setHandshakeCapabilities(source: () => unknown): void {
  handshake = source
}

/** For tests, which must not inherit a source from another test. */
export function _clearHandshakeCapabilities(): void {
  handshake = undefined
}

interface CapabilityContext {
  mcpReq?: { envelope?: Record<string, unknown> }
}

/**
 * What this client declared, from whichever source has it.
 *
 * Typed as unknown on purpose. The client sent this, so its shape is a claim
 * rather than a guarantee, and every reader narrows it by hand.
 */
export function declaredCapabilities(ctx: unknown): unknown {
  const fromEnvelope = (ctx as CapabilityContext)?.mcpReq?.envelope?.[ENVELOPE_KEY]
  if (fromEnvelope !== undefined && fromEnvelope !== null) return fromEnvelope
  try {
    return handshake?.()
  } catch {
    // A source that throws is a source that says nothing, and saying nothing
    // means the caller refuses. That is the safe direction for every caller
    // this module has.
    return undefined
  }
}

/** Whether a declaration names a member, treating an empty object as present. */
function declares(capabilities: unknown, group: string, member: 'form' | 'url'): boolean {
  const entry = (capabilities as Record<string, unknown> | undefined)?.[group]
  if (entry === undefined || entry === null) return false
  const value = (entry as Record<string, unknown>)[member]
  if (value !== undefined && value !== null && value !== false) return true
  // A declaration with no modes at all is the pre-mode way of saying "form",
  // which is the SDK's own reading. It says nothing about url.
  return member === 'form' && Object.keys(entry as Record<string, unknown>).length === 0
}

/** Whether the client can show a form and give an answer back. */
export function canElicitForm(ctx: unknown): boolean {
  return declares(declaredCapabilities(ctx), 'elicitation', 'form')
}

/** Whether the client can put a URL in front of the user. */
export function canElicitUrl(ctx: unknown): boolean {
  return declares(declaredCapabilities(ctx), 'elicitation', 'url')
}
