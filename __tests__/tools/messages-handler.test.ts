import { describe, it, expect } from 'vitest'
import { registerMessageTools } from '../../src/tools/messages.js'
import type { Connection } from '../../src/bridge/connection.js'
import type { McpServer } from '@modelcontextprotocol/server'

/**
 * The translation from tool arguments into search criteria.
 *
 * This layer had no test, and that is where two arguments quietly meant the
 * opposite of their names: `unreadOnly: false` was passed on negated, so it
 * became `seen: true` and searched read messages only, while the same argument
 * one tool over in `list_messages` treats a falsy value as no filter at all.
 * `starredOnly: false` searched for messages that are explicitly not starred.
 *
 * `buildQuery` was tested and correct throughout - `seen: false` does mean
 * unread there. The defect sat between the schema and it, which is why these
 * tests go through the registered handler and read the query that arrives at
 * IMAP, rather than calling `buildQuery` directly.
 */

type Handler = (
  args: Record<string, unknown>,
  ctx: unknown,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>

/**
 * Registers the message tools against a connection that records the IMAP search
 * it is asked for.
 *
 * The search returns no hits, so nothing beyond the query is exercised. That is
 * deliberate: what the criteria become is the subject, and a handler that also
 * formatted results would need a mailbox full of fixtures to say the same
 * thing.
 */
function captureSearch(): { handler: Handler; query: () => Record<string, unknown> | undefined } {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => {
      handlers.set(name, fn)
    },
  } as unknown as McpServer

  let query: Record<string, unknown> | undefined

  const connection = {
    withMailbox: async (
      path: string,
      operation: (
        client: { search: (q: Record<string, unknown>) => Promise<number[]> },
        status: { path: string; messages: number },
      ) => Promise<unknown>,
    ) =>
      operation(
        {
          search: async (q) => {
            query = q
            return []
          },
        },
        { path, messages: 1 },
      ),
  } as unknown as Connection

  registerMessageTools(server, connection)

  const handler = handlers.get('search_messages')
  if (!handler) throw new Error('search_messages did not register itself')
  return { handler, query: () => query }
}

describe('search_messages turns arguments into criteria', () => {
  it('does not filter by read state when unreadOnly is false', async () => {
    // The bug: this used to become seen: true, which is read messages only.
    const { handler, query } = captureSearch()
    await handler({ text: 'invoice', unreadOnly: false }, {})
    expect(query()).toEqual({ text: 'invoice' })
  })

  it('filters to unread when unreadOnly is true', async () => {
    const { handler, query } = captureSearch()
    await handler({ text: 'invoice', unreadOnly: true }, {})
    expect(query()).toEqual({ text: 'invoice', seen: false })
  })

  it('does not filter by star when starredOnly is false', async () => {
    // The bug: this used to become flagged: false, which is unstarred only.
    const { handler, query } = captureSearch()
    await handler({ text: 'invoice', starredOnly: false }, {})
    expect(query()).toEqual({ text: 'invoice' })
  })

  it('filters to starred when starredOnly is true', async () => {
    const { handler, query } = captureSearch()
    await handler({ text: 'invoice', starredOnly: true }, {})
    expect(query()).toEqual({ text: 'invoice', flagged: true })
  })

  it('means the same by an omitted argument as by a false one', async () => {
    // The property that was broken: agreement with list_messages, where a falsy
    // value has always been no filter.
    const omitted = captureSearch()
    await omitted.handler({ text: 'invoice' }, {})
    const explicit = captureSearch()
    await explicit.handler({ text: 'invoice', unreadOnly: false, starredOnly: false }, {})
    expect(explicit.query()).toEqual(omitted.query())
  })

  it('sends a date range as the sender date, not the delivery date', async () => {
    // sentSince and sentBefore compare the Date header, which is what the
    // results show and sort by. since and before would compare INTERNALDATE,
    // the moment the server received the message, and that can be rewritten
    // when a message is copied between mailboxes.
    const { handler, query } = captureSearch()
    await handler({ text: 'invoice', since: '2026-07-01', before: '2026-07-31' }, {})
    const sent = query()
    expect(sent).toHaveProperty('sentSince')
    expect(sent).toHaveProperty('sentBefore')
    expect(sent).not.toHaveProperty('since')
    expect(sent).not.toHaveProperty('before')
  })
})
