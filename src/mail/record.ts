/**
 * One recipient added to every message this server sends (#18).
 *
 * Two uses, and the user picks by the mode: a blind copy to an archive address
 * keeps a record of everything the assistant sends somewhere the assistant
 * cannot reach or tidy up; a copy in Cc makes every send visible to a second
 * person. Both used to work only by trusting the assistant to add the address
 * itself, which is exactly the trust this project tries not to need.
 *
 * Added while the message is built, before its digest is taken, so the
 * address is part of what the question shows and part of what a yes is bound
 * to. Nothing the assistant passes can remove it, and an address it names
 * itself is not added a second time.
 *
 * The setting is a lever of its own: a field that quietly adds a recipient to
 * every message is what an attacker would most like to set. It comes from the
 * environment or from the interface, where the PIN guards it once one is set,
 * and the overview shows it whenever it is on.
 */

import type { Draft } from './compose.js'
import type { RecordCopy } from '../settings.js'

/** Why an address cannot be the copy recipient, or nothing when it can. */
export function recordProblem(address: string): string | undefined {
  const trimmed = address.trim()
  if (!trimmed) return 'The address for the copy is empty.'
  // Plain ASCII only, the same rule every recipient follows since #42: a
  // letter from another script can spell a familiar domain that belongs to
  // somebody else, and this address receives every message.
  if (!/^[\x21-\x7e]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(trimmed) || /[<>"(),;:\\[\]]/.test(trimmed)) {
    return (
      `"${trimmed}" is not a plain address. The copy goes to every message sent, so only an ` +
      'address written in plain ASCII, like archive@example.com, is accepted. A domain written ' +
      'with other letters can be given in its xn-- form.'
    )
  }
  return undefined
}

/** A configuration that cannot be honoured. The server refuses to start rather than guess. */
export class RecordError extends Error {}

/** The copy from the environment, or nothing when it is not set there. */
export function recordFromEnvironment(env: NodeJS.ProcessEnv = process.env): RecordCopy | undefined {
  const address = env.PROTON_MCP_COPY_TO?.trim()
  const mode = env.PROTON_MCP_COPY_AS?.trim().toLowerCase()
  if (!address) {
    if (mode) throw new RecordError('PROTON_MCP_COPY_AS is set, but PROTON_MCP_COPY_TO names no address.')
    return undefined
  }
  const problem = recordProblem(address)
  if (problem) throw new RecordError(`PROTON_MCP_COPY_TO: ${problem}`)
  if (mode && mode !== 'cc' && mode !== 'bcc') {
    throw new RecordError(`PROTON_MCP_COPY_AS is "${mode}". It has to be cc or bcc.`)
  }
  return { address, mode: mode === 'cc' ? 'cc' : 'bcc' }
}

/**
 * The draft with the copy recipient in it, marked as configured.
 *
 * An address already among the recipients is not added again, in whichever
 * field the assistant put it. The mark stays either way, so the question can
 * say that the address is there because of the setting.
 */
export function withRecord(draft: Draft, record: RecordCopy | undefined): Draft {
  if (!record) return draft
  const wanted = record.address.trim().toLowerCase()
  const present = [...draft.to, ...draft.cc, ...draft.bcc].some(
    (recipient) => recipient.address.trim().toLowerCase() === wanted,
  )
  const marked: Draft = { ...draft, record: { address: record.address.trim(), mode: record.mode } }
  if (present) return marked
  return record.mode === 'cc'
    ? { ...marked, cc: [...draft.cc, { address: record.address.trim() }] }
    : { ...marked, bcc: [...draft.bcc, { address: record.address.trim() }] }
}
