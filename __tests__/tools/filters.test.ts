import { describe, it, expect } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  ANSWER,
  DESCRIPTION,
  FILTER_PAGE,
  SIEVE_GUIDE,
  registerFilterTool,
} from '../../src/tools/filters.js'

/**
 * The tool that answers filter requests without touching a filter.
 *
 * Its whole value is in what it says, so that is what is checked: that it
 * admits what this server cannot do, names the two pages an assistant needs,
 * and asks for the user's agreement before anything is looked at or saved. And
 * that it stays what it claims to be, a tool that reads and changes nothing.
 */

interface Registered {
  name: string
  config: { annotations?: Record<string, unknown> }
  handler: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }>
}

function register(): Registered {
  let registered: Registered | undefined
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Registered['handler']) => {
      registered = { name, config, handler }
    },
  } as unknown as McpServer
  registerFilterTool(server)
  return registered!
}

describe('the tool as registered', () => {
  it('is called manage_filters and announces that it only reads', () => {
    const tool = register()
    expect(tool.name).toBe('manage_filters')
    expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
  })

  it('answers without a connection, a sign-in or an argument', async () => {
    // registerFilterTool is handed nothing but the server, so there is no
    // connection it could reach. The call itself needs nothing either, which
    // is what lets it answer before anyone has signed in.
    const result = await register().handler({}, {})
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: ANSWER }])
  })
})

describe('what the description promises', () => {
  it('is found by the words a user would use', () => {
    for (const word of ['filters', 'rules', 'sorting incoming mail', 'Sieve']) {
      expect(DESCRIPTION).toContain(word)
    }
  })

  it('says up front that filters are out of reach here', () => {
    expect(DESCRIPTION).toContain('cannot be read or changed through this server')
  })
})

describe('what the answer tells an assistant', () => {
  it('admits that nothing about the filters is known here', () => {
    // Without this an assistant tends to fill the gap with rules it imagines
    // the user has.
    expect(ANSWER).toContain('Filters cannot be read or changed through this server')
    expect(ANSWER).toContain("Nothing about the user's filters is known here")
  })

  it("names the filter page and the Sieve documentation, both on Proton's own domains", () => {
    expect(ANSWER).toContain(FILTER_PAGE)
    expect(ANSWER).toContain(SIEVE_GUIDE)

    const page = new URL(FILTER_PAGE)
    expect(page.protocol).toBe('https:')
    expect(page.hostname).toBe('account.proton.me')
    expect(page.pathname).toBe('/u/0/mail/filters')

    const guide = new URL(SIEVE_GUIDE)
    expect(guide.protocol).toBe('https:')
    expect(guide.hostname).toBe('proton.me')
  })

  it("asks for the user's agreement before looking and before saving", () => {
    expect(ANSWER).toContain('Ask the user first whether you may look at their filters')
    expect(ANSWER).toContain('save only after they agree to it')
  })

  it('sends every change through Sieve, with the labels Proton shows', () => {
    expect(ANSWER).toContain('Edit Sieve')
    expect(ANSWER).toContain('Add sieve filter')
    expect(ANSWER).toContain('The labels follow the language of the account')
  })

  it('names each action that deletes, refuses, answers or hides mail', () => {
    for (const action of ['discard', 'expire', 'reject', 'vacation', 'Trash or Spam']) {
      expect(ANSWER).toContain(action)
    }
  })

  it('keeps the spam check and leaves deleting a filter to the user', () => {
    expect(ANSWER).toContain('Keep the spam check')
    expect(ANSWER).toContain("Deleting or turning off a filter is the user's decision")
  })

  it('has a way that works without a browser tool', () => {
    expect(ANSWER).toContain('Without a browser tool')
  })

  it("points existing messages at this server's own tools", () => {
    // A filter only acts on mail that arrives. What is already there is
    // sorted with tools this server has, and they have to be named exactly.
    for (const tool of ['search_messages', 'move_messages', 'add_label']) {
      expect(ANSWER).toContain(tool)
    }
  })
})
