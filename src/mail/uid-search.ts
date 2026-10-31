/**
 * A UID SEARCH that tells a failure apart from an empty result.
 *
 * imapflow answers a search that matched nothing with an empty array, and a
 * search that failed with `false`: it catches the error, logs it and returns.
 * The logger is switched off here, so `false` is all that arrives. Read as
 * "nothing matched", a failed search makes a mailbox look empty and a message
 * look as though it did not exist, and the assistant goes on to act on an
 * answer that never came.
 */

import type { ImapFlow, SearchObject } from 'imapflow'
import { BridgeError } from '../bridge/errors.js'

/**
 * Runs the search and returns the matching UIDs, or throws when it failed.
 *
 * `what` names what was being looked for, so the refusal can say it.
 */
export async function searchUids(
  client: ImapFlow,
  query: SearchObject,
  what: string,
): Promise<number[]> {
  const hits = await client.search(query, { uid: true })
  if (Array.isArray(hits)) return hits
  throw new BridgeError(
    `The search for ${what} failed, so this says nothing about which messages match: it is not ` +
      'an empty result. The Bridge gave no reason. Try again, and if it fails again, check that ' +
      'the Bridge is running and unlocked.',
  )
}
