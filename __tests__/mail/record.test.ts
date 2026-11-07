import { describe, it, expect } from 'vitest'
import { recordProblem, recordFromEnvironment, withRecord, RecordError } from '../../src/mail/record.js'
import type { Draft } from '../../src/mail/compose.js'

/**
 * The recipient added to every message sent (#18).
 *
 * It receives everything, so the address has to be exactly the one the user
 * meant: plain ASCII, nothing that could be read as two addresses. And it has
 * to be added in a way the assistant cannot undo, without appearing twice.
 */

const draft = (overrides: Partial<Draft> = {}): Draft =>
  ({
    from: { address: 'me@example.com' },
    to: [{ address: 'you@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Hello',
    text: 'Text',
    messageId: '<1@example.com>',
    ...overrides,
  }) as Draft

describe('the address', () => {
  it('accepts a plain address', () => {
    expect(recordProblem('archive@example.com')).toBeUndefined()
    expect(recordProblem('archive+mcp@mail.example.org')).toBeUndefined()
  })

  it('refuses letters from another script, which can spell a familiar domain', () => {
    const lookalike = `archive@ex${String.fromCodePoint(0x0430)}mple.com`
    expect(recordProblem(lookalike)).toContain('not a plain address')
  })

  it('refuses anything that could carry a second address or a header', () => {
    for (const bad of ['a@example.com, b@example.org', 'Name <a@example.com>', 'a@example', '', 'no-at-sign']) {
      expect(recordProblem(bad)).toBeDefined()
    }
  })
})

describe('the environment', () => {
  it('defaults to a blind copy', () => {
    expect(recordFromEnvironment({ PROTON_MCP_COPY_TO: 'archive@example.com' })).toEqual({
      address: 'archive@example.com',
      mode: 'bcc',
    })
  })

  it('takes cc when asked', () => {
    expect(
      recordFromEnvironment({ PROTON_MCP_COPY_TO: 'boss@example.com', PROTON_MCP_COPY_AS: 'CC' }),
    ).toEqual({ address: 'boss@example.com', mode: 'cc' })
  })

  it('refuses a mode without an address, an unknown mode and an unusable address', () => {
    expect(() => recordFromEnvironment({ PROTON_MCP_COPY_AS: 'bcc' })).toThrow(RecordError)
    expect(() => recordFromEnvironment({ PROTON_MCP_COPY_TO: 'a@example.com', PROTON_MCP_COPY_AS: 'to' })).toThrow(RecordError)
    expect(() => recordFromEnvironment({ PROTON_MCP_COPY_TO: 'a@example' })).toThrow(RecordError)
  })

  it('is absent when nothing is set', () => {
    expect(recordFromEnvironment({})).toBeUndefined()
  })
})

describe('adding it to a message', () => {
  it('adds a blind copy and marks it as configured', () => {
    const result = withRecord(draft(), { address: 'archive@example.com', mode: 'bcc' })
    expect(result.bcc).toEqual([{ address: 'archive@example.com' }])
    expect(result.cc).toEqual([])
    expect(result.record).toEqual({ address: 'archive@example.com', mode: 'bcc' })
  })

  it('adds a visible copy in Cc', () => {
    const result = withRecord(draft(), { address: 'boss@example.com', mode: 'cc' })
    expect(result.cc).toEqual([{ address: 'boss@example.com' }])
  })

  it('does not add an address the assistant named already, in any case', () => {
    const result = withRecord(draft({ to: [{ address: 'Archive@Example.com' }] }), {
      address: 'archive@example.com',
      mode: 'bcc',
    })
    expect(result.bcc).toEqual([])
    expect(result.to).toEqual([{ address: 'Archive@Example.com' }])
    expect(result.record).toBeDefined()
  })

  it('leaves a message alone when no copy is configured', () => {
    const original = draft()
    expect(withRecord(original, undefined)).toBe(original)
  })
})
