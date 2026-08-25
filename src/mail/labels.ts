/**
 * Applying and removing labels.
 *
 * The first thing in this server that writes to a mailbox. Everything here
 * follows from four measurements against the Bridge:
 *
 * 1. `COPY` into a mailbox under `Labels/` applies the label. The message stays
 *    in its folder and no second message appears: "All Mail" holds every message
 *    exactly once and its count did not change.
 * 2. The same `COPY` into a mailbox under `Folders/` **moves** the message
 *    instead. One command, two meanings, told apart by the prefix alone.
 * 3. A label is removed with `\Deleted` plus `EXPUNGE` inside the label mailbox.
 *    The message keeps its folder, keeps its other labels and does not go to
 *    trash.
 * 4. **A copy into a mailbox that does not exist reports success and does
 *    nothing.** No error, no TRYCREATE, and the destination is not created
 *    either. There is nothing to react to afterwards, so the label has to be
 *    verified to exist before the call, not after it.
 *
 * Point 2 and point 3 together are why this module refuses to touch anything
 * outside `Labels/`. Removing a label is an EXPUNGE, and an EXPUNGE aimed at a
 * folder deletes mail. That guard is the most important line in this file.
 */

import type { Connection } from '../bridge/connection.js'
import { BridgeError } from '../bridge/errors.js'
import { normaliseMessageId, findByMessageId, resolveMessageId } from './ids.js'

/** The prefix Proton exposes labels under. Anything else is not a label. */
export const LABEL_PREFIX = 'Labels/'

/**
 * Brings a label name into its full path.
 *
 * Callers say "Test1" or "Labels/Test1" and mean the same thing. What they must
 * not be able to say is a path that leaves the label namespace, so this rejects
 * rather than repairs anything else.
 */
export function labelPath(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new BridgeError('An empty label name cannot be used.')

  const full = trimmed.startsWith(LABEL_PREFIX) ? trimmed : `${LABEL_PREFIX}${trimmed}`
  const bare = full.slice(LABEL_PREFIX.length)

  if (!bare) {
    throw new BridgeError(
      `"${name}" names the label container itself rather than a label. Pass the label name, for example "Work".`,
    )
  }
  // A nested path would let a caller aim at a folder from inside what looks
  // like a label name. Labels have no hierarchy in Proton, so nothing is lost.
  if (bare.includes('/')) {
    throw new BridgeError(
      `"${name}" is not a label name. Labels have no sub-levels; pass a single name such as "Work".`,
    )
  }
  return full
}

/** Guard for every write in this module. Nothing outside Labels/ is touched. */
function assertLabelMailbox(path: string): void {
  if (!path.startsWith(LABEL_PREFIX) || path.slice(LABEL_PREFIX.length).includes('/')) {
    throw new BridgeError(
      `Refusing to operate on "${path}". This code only ever touches mailboxes under ${LABEL_PREFIX}, ` +
        'because removing a label expunges messages and doing that to a folder would delete mail.',
    )
  }
}

/** The labels that exist, as full paths. */
export async function listLabels(connection: Connection): Promise<string[]> {
  const boxes = await connection.listMailboxes()
  return boxes.filter((b) => b.kind === 'label' && b.selectable).map((b) => b.path)
}

/**
 * Checks that a label exists, and says what to do when it does not.
 *
 * Not a nicety. Measurement 4 above means a missing label produces a successful
 * copy that changes nothing, so without this check the tool would report having
 * applied a label that was never applied.
 */
async function requireLabel(connection: Connection, path: string): Promise<void> {
  const labels = await listLabels(connection)
  if (labels.includes(path)) return

  const names = labels.map((l) => l.slice(LABEL_PREFIX.length))
  throw new BridgeError(
    `There is no label "${path.slice(LABEL_PREFIX.length)}". ` +
      (names.length
        ? `The labels of this account are: ${names.join(', ')}.`
        : 'This account has no labels yet.') +
      ' Labels have to be created in Proton itself; this server does not create them, ' +
      'and the Bridge accepts a copy into a label that does not exist without applying anything.',
  )
}

/** Refuses every write while the server runs read-only. */
function assertWritable(readOnly: boolean, what: string): void {
  if (readOnly) {
    throw new BridgeError(
      `The server is running read-only, so ${what} is refused. ` +
        'This is set by PROTON_MCP_READ_ONLY and the web interface reports it as the current mode.',
    )
  }
}

export interface LabelChange {
  messageId: string
  label: string
  /** The mailbox the message was found in, for the answer. */
  path: string
}

/**
 * Applies a label to a message.
 *
 * The result is deliberately not verified afterwards. Measured: right after a
 * write the Bridge reports an intermediate state, and a check run immediately
 * describes something that is not the outcome.
 */
export async function addLabel(
  connection: Connection,
  readOnly: boolean,
  messageId: string,
  label: string,
  hint?: string,
): Promise<LabelChange> {
  assertWritable(readOnly, 'applying a label')
  const path = labelPath(label)
  assertLabelMailbox(path)
  await requireLabel(connection, path)

  const id = normaliseMessageId(messageId)
  const resolved = await resolveMessageId(connection, id, hint)

  await connection.withMailbox(resolved.path, async (client) => {
    await client.messageCopy(String(resolved.uid), path, { uid: true })
  })

  return { messageId: resolved.messageId, label: path, path: resolved.path }
}

/**
 * Removes a label from a message.
 *
 * The message is looked up **inside the label mailbox**, not through the
 * ordinary resolver. A label is a mailbox of its own with its own uids, so a uid
 * from anywhere else would address a different message here, and this operation
 * expunges what it addresses.
 */
export async function removeLabel(
  connection: Connection,
  readOnly: boolean,
  messageId: string,
  label: string,
): Promise<LabelChange & { wasApplied: boolean }> {
  assertWritable(readOnly, 'removing a label')
  const path = labelPath(label)
  assertLabelMailbox(path)
  await requireLabel(connection, path)

  const id = normaliseMessageId(messageId)

  const wasApplied = await connection.withMailbox(path, async (client, status) => {
    // The Bridge answers FETCH on an empty mailbox with BAD, and a search there
    // is pointless anyway.
    if (status.messages === 0) return false

    // findByMessageId rather than a search written out here: it makes the
    // second attempt without the angle brackets and verifies every hit of it.
    // Real mail carries unbracketed identifiers, and without the fallback this
    // reported wasApplied: false for a label that was applied - which reads as
    // "it was not set" rather than "it was not found".
    const uid = await findByMessageId(client, id)
    if (uid === undefined) return false

    // Guarded again, immediately before the expunge. The path cannot have
    // changed between the check above and here, but this is the line that
    // deletes, and it should not depend on a check twenty lines away.
    assertLabelMailbox(status.path)
    await client.messageDelete(String(uid), { uid: true })
    return true
  })

  return { messageId: id, label: path, path, wasApplied }
}
