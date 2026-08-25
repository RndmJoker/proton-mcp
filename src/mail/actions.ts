/**
 * Moving messages, read state and trash.
 *
 * Measured against the Bridge on 31.07.2026, and almost every guard in this
 * file exists because a measurement contradicted the obvious expectation:
 *
 * 1. **`MOVE` reports a refusal as the return value `false`, not as an error.**
 *    Into a mailbox that does not exist it returns `false` and changes nothing.
 *    Code that ignores the return value reports success for an operation that
 *    never happened. That is the opposite of `COPY`, which reports success and
 *    does nothing (see labels.ts), so neither call can be trusted the same way.
 * 2. **`MOVE` out of "All Mail" returns `false` and changes nothing.** This is
 *    the important one: "All Mail" is where resolveMessageId looks when no
 *    mailbox is named, so the obvious implementation would fail silently in the
 *    ordinary case. Moving needs the folder the message really sits in, which
 *    is why this module has its own lookup.
 * 3. **`MOVE` into a label is not a move.** The label is applied and the message
 *    stays in its folder, exactly as a `COPY` there would. Refused here, with a
 *    pointer at add_label, because a tool called "move" must not quietly do
 *    something else.
 * 4. **A move takes about 15 seconds to settle**, and during that window the
 *    Bridge shows the message in both places. Nothing here verifies its own
 *    result, and the answers say so.
 * 5. **Flag changes are immediate and hold**, unlike everything else in this
 *    file. \Seen and \Flagged were correct straight away and unchanged 20
 *    seconds later, so setting flags gets no delay warning.
 *
 * Nothing in this module deletes. There is no expunge here and no tool that
 * removes a message for good: trash is a move to the Trash mailbox, and Proton
 * keeps it in "All Mail", which the measurement confirmed.
 */

import type { Connection, Mailbox } from '../bridge/connection.js'
import { BridgeError } from '../bridge/errors.js'
import { normaliseMessageId, findByMessageId, ALL_MAIL, TRASH } from './ids.js'
import { LABEL_PREFIX } from './labels.js'

/**
 * How many messages one call may touch.
 *
 * A bound rather than a preference: every message costs a lookup and a write,
 * and a model that miscounts should not be able to reorganise a mailbox in one
 * call before anyone can read the answer.
 */
export const MAX_BATCH = 50

/** Views rather than places. A message cannot be moved into one of these. */
const VIRTUAL = new Set([ALL_MAIL, 'Starred'])

/** Refuses every write while the server runs read-only. */
function assertWritable(readOnly: boolean, what: string): void {
  if (readOnly) {
    throw new BridgeError(
      `The server is running read-only, so ${what} is refused. ` +
        'This is set by PROTON_MCP_READ_ONLY and the web interface reports it as the current mode.',
    )
  }
}

/**
 * Checks that a destination is a place a message can actually be moved to.
 *
 * Deliberately does not list the folders that do exist. A failure message
 * naming them would put the account's folder structure into the answer without
 * anyone asking for it, and folder names alone can name a bank or an employer.
 * list_folders is where that belongs.
 */
export function assertMoveTarget(target: string, mailboxes: Mailbox[]): string {
  const path = target.trim()
  if (!path) throw new BridgeError('An empty mailbox name cannot be used as a destination.')

  if (path.startsWith(LABEL_PREFIX) || path === 'Labels') {
    throw new BridgeError(
      `"${path}" is a label, not a folder. Measured against the Bridge: moving a message into a ` +
        'label applies the label and leaves the message in its folder, so this would not move ' +
        'anything. Use add_label to apply a label, and name a folder here.',
    )
  }

  if (VIRTUAL.has(path)) {
    throw new BridgeError(
      `"${path}" is a view of other mailboxes rather than a place to put a message. ` +
        (path === 'Starred'
          ? 'Use set_flags with starred to star a message.'
          : `"${ALL_MAIL}" holds every message already, whatever folder it is in.`),
    )
  }

  const box = mailboxes.find((b) => b.path === path)
  if (!box) {
    throw new BridgeError(
      `There is no mailbox "${path}". Use list_folders to see the available paths; user folders ` +
        'live below "Folders/". Note that the Bridge accepts a move into a mailbox that is not ' +
        'there without moving anything, so this is checked before the call rather than after it.',
    )
  }
  if (!box.selectable) {
    throw new BridgeError(
      `"${path}" is the container the folders live in, not a folder itself. It cannot hold ` +
        'messages. Name one of the folders below it.',
    )
  }
  return path
}

/**
 * Finds the folder a message actually sits in.
 *
 * Not resolveMessageId, and that is the whole point. resolveMessageId answers
 * "where can I read this", and its fallback is "All Mail", which holds
 * everything. Measured: a MOVE issued from inside "All Mail" returns false and
 * changes nothing, so for a move that answer is worse than useless.
 *
 * `hint` is worth passing. Without it this walks the mailboxes a message can
 * live in and searches each one, which is a request per mailbox. Listings name
 * the mailbox they came from, so a caller almost always has it.
 */
export async function findHomeFolder(
  connection: Connection,
  rawId: string,
  hint?: string,
): Promise<{ messageId: string; path: string; uid: number }> {
  const messageId = normaliseMessageId(rawId)

  const lookIn = async (path: string): Promise<number | undefined> => {
    const found = await connection
      .withMailbox(path, async (client, status) => {
        // The Bridge answers a fetch on an empty mailbox with BAD.
        if (status.messages === 0) return undefined
        // findByMessageId rather than a search written out here. It makes the
        // second attempt without the angle brackets and verifies every hit of
        // it, which real mail needs: an identifier is not always bracketed, and
        // the incident behind that fallback was "marking 67 messages left that
        // one behind" - marking goes through setFlags to this function, so the
        // path the incident happened in was the one without the fallback.
        return findByMessageId(client, messageId)
      })
      .catch(() => undefined)
    return found
  }

  if (hint && !VIRTUAL.has(hint) && !hint.startsWith(LABEL_PREFIX)) {
    const uid = await lookIn(hint)
    if (uid !== undefined) return { messageId, path: hint, uid }
  }

  const mailboxes = await connection.listMailboxes()
  // A message lives in exactly one folder. Labels and the two views are not
  // folders, so searching them would only produce a location a move cannot use.
  const candidates = mailboxes
    .filter((b) => b.selectable && b.kind !== 'label' && !VIRTUAL.has(b.path))
    .map((b) => b.path)
    // The common ones first, so the usual case stops early.
    .sort((a, b) => rank(a) - rank(b))

  for (const path of candidates) {
    if (path === hint) continue
    const uid = await lookIn(path)
    if (uid !== undefined) return { messageId, path, uid }
  }

  throw new BridgeError(
    `No folder holds a message with the id ${messageId}. It may have been deleted, or the id may ` +
      'be incomplete. Identifiers come from list_messages or search_messages and have to be ' +
      'passed on unchanged.',
  )
}

/** Where to look first. Ordinary reading happens in the top few. */
function rank(path: string): number {
  const order = ['INBOX', 'Archive', 'Sent', 'Drafts', 'Spam', 'Trash']
  const known = order.indexOf(path)
  if (known >= 0) return known
  // User folders before the remaining system ones.
  return path.startsWith('Folders/') ? 10 : 20
}

/** What happened to one message of a batch. */
export interface MessageOutcome {
  messageId: string
  ok: boolean
  /** The folder it came from, when it was found. */
  from?: string
  /** Why it did not work, in a form the caller can act on. */
  reason?: string
}

export interface BatchResult {
  outcomes: MessageOutcome[]
  succeeded: number
  failed: number
}

function summarise(outcomes: MessageOutcome[]): BatchResult {
  const succeeded = outcomes.filter((o) => o.ok).length
  return { outcomes, succeeded, failed: outcomes.length - succeeded }
}

function assertBatch(ids: string[]): void {
  if (ids.length === 0) throw new BridgeError('No message id was given, so there is nothing to do.')
  if (ids.length > MAX_BATCH) {
    throw new BridgeError(
      `${ids.length} messages were given, and at most ${MAX_BATCH} are accepted in one call. ` +
        'Split the work into several calls, so that a mistake stays small enough to read.',
    )
  }
}

/**
 * Moves messages into a folder.
 *
 * One message's failure does not stop the rest: a batch that gives up halfway
 * leaves the caller unable to say what happened, which is worse than a partial
 * result that is reported honestly.
 */
export async function moveMessages(
  connection: Connection,
  readOnly: boolean,
  messageIds: string[],
  target: string,
  hint?: string,
): Promise<BatchResult & { target: string }> {
  assertWritable(readOnly, 'moving messages')
  assertBatch(messageIds)

  const mailboxes = await connection.listMailboxes()
  const path = assertMoveTarget(target, mailboxes)

  const outcomes: MessageOutcome[] = []
  for (const raw of messageIds) {
    try {
      const home = await findHomeFolder(connection, raw, hint)
      if (home.path === path) {
        outcomes.push({
          messageId: home.messageId,
          ok: true,
          from: home.path,
          reason: 'was already there, nothing was moved',
        })
        continue
      }
      const accepted = await connection.withMailbox(home.path, async (client) =>
        client.messageMove(String(home.uid), path, { uid: true }),
      )
      // Measured: a refused move is a falsy return value, never an exception.
      // Treating the call as successful because it did not throw would report a
      // move that did not happen.
      if (!accepted) {
        outcomes.push({
          messageId: home.messageId,
          ok: false,
          from: home.path,
          reason: `the Bridge refused the move from "${home.path}" to "${path}" without giving a reason`,
        })
        continue
      }
      outcomes.push({ messageId: home.messageId, ok: true, from: home.path })
    } catch (error) {
      outcomes.push({
        messageId: raw,
        ok: false,
        reason: error instanceof BridgeError ? error.message : String(error),
      })
    }
  }

  return { ...summarise(outcomes), target: path }
}

/** Which flags a call wants changed. Absent means "leave alone". */
export interface FlagChanges {
  /** True marks as read, false as unread. */
  read?: boolean
  /** Proton shows this as the star. */
  starred?: boolean
}

/**
 * Sets read state and star.
 *
 * Unlike everything else here this needs no settling time: measured, the flags
 * were correct immediately and unchanged twenty seconds later.
 */
export async function setFlags(
  connection: Connection,
  readOnly: boolean,
  messageIds: string[],
  changes: FlagChanges,
  hint?: string,
): Promise<BatchResult> {
  assertWritable(readOnly, 'changing the read state or the star')
  assertBatch(messageIds)

  if (changes.read === undefined && changes.starred === undefined) {
    throw new BridgeError(
      'Neither the read state nor the star was given, so there is nothing to change.',
    )
  }

  const add: string[] = []
  const remove: string[] = []
  if (changes.read !== undefined) (changes.read ? add : remove).push('\\Seen')
  if (changes.starred !== undefined) (changes.starred ? add : remove).push('\\Flagged')

  const outcomes: MessageOutcome[] = []
  for (const raw of messageIds) {
    try {
      // Flags belong to a mailbox, so this needs the folder as well: setting a
      // flag on the "All Mail" copy would leave the folder's own view alone.
      const home = await findHomeFolder(connection, raw, hint)
      await connection.withMailbox(home.path, async (client) => {
        const uid = String(home.uid)
        if (add.length) await client.messageFlagsAdd(uid, add, { uid: true })
        if (remove.length) await client.messageFlagsRemove(uid, remove, { uid: true })
      })
      outcomes.push({ messageId: home.messageId, ok: true, from: home.path })
    } catch (error) {
      outcomes.push({
        messageId: raw,
        ok: false,
        reason: error instanceof BridgeError ? error.message : String(error),
      })
    }
  }

  return summarise(outcomes)
}



/**
 * Moves messages to the trash.
 *
 * A move and nothing else. There is no permanent deletion in this server, on
 * purpose: a wrong decision by a model has to stay reversible, and measured,
 * a message in the trash is still in "All Mail" and can be moved back out.
 */
export async function trashMessages(
  connection: Connection,
  readOnly: boolean,
  messageIds: string[],
  hint?: string,
): Promise<BatchResult & { target: string }> {
  return moveMessages(connection, readOnly, messageIds, TRASH, hint)
}
