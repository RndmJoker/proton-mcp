import { describe, it, expect } from 'vitest'
import {
  digestOf,
  clientCanConfirm,
  confirmationAnswer,
  confirmationRequest,
  describeForConfirmation,
  pendingSend,
  CONFIRM_KEY,
} from '../../src/tools/confirm.js'
import type { Draft } from '../../src/mail/compose.js'

/**
 * The confirmation is the project's one real security boundary, so these tests
 * are written from the attacker's side: what would a message that a model just
 * read have to achieve to get something sent that the user did not agree to?
 *
 * One caveat, learned the hard way. The `clientCanConfirm` group below hands
 * the check a context carrying a per-request envelope, which is what protocol
 * revision 2026-07-28 delivers. On the revision this SDK actually speaks there
 * is no envelope, and for one release the check read nothing else and refused
 * every client while all of these tests stayed green. What proves the check
 * works is confirmation-over-the-wire.test.ts, which drives a real handshake.
 * These stay because the envelope path is still a path; they are just not the
 * evidence they look like.
 */

function draft(over: Partial<Draft> = {}): Draft {
  return {
    from: { address: 'me@example.com' },
    to: [{ address: 'you@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Subject',
    text: 'Body',
    messageId: '<one@example.com>',
    ...over,
  }
}

const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
const ctxWith = (capabilities: unknown, rest: Record<string, unknown> = {}) => ({
  mcpReq: { envelope: { [CAPABILITIES_KEY]: capabilities }, ...rest },
})

describe('digestOf', () => {
  it('changes when a recipient is added', () => {
    // The attack this exists for: confirm a message to one address, then send
    // the same text to another.
    const before = digestOf(draft())
    const after = digestOf(draft({ cc: [{ address: 'attacker@example.com' }] }))
    expect(after).not.toBe(before)
  })

  it('changes when a blind copy is added', () => {
    // The quietest version of the same attack: a recipient nobody sees.
    expect(digestOf(draft({ bcc: [{ address: 'quiet@example.com' }] }))).not.toBe(
      digestOf(draft()),
    )
  })

  it('changes when the text or the subject changes', () => {
    expect(digestOf(draft({ text: 'Something else' }))).not.toBe(digestOf(draft()))
    expect(digestOf(draft({ subject: 'Something else' }))).not.toBe(digestOf(draft()))
  })

  it('changes when the sender changes', () => {
    expect(digestOf(draft({ from: { address: 'someone@example.com' } }))).not.toBe(
      digestOf(draft()),
    )
  })

  it('changes when a different message is carried along', () => {
    expect(
      digestOf(draft({ attachedMessage: { filename: 'other.eml', raw: Buffer.from('x') } })),
    ).not.toBe(digestOf(draft()))
  })

  it('does not change for things a recipient would never see', () => {
    // Two calls that describe the same message must not be told apart, or the
    // second round would refuse a confirmation that was perfectly good.
    expect(digestOf(draft({ messageId: '<two@example.com>' }))).toBe(digestOf(draft()))
    expect(digestOf(draft({ references: ['<a@example.com>'] }))).toBe(digestOf(draft()))
  })

  it('ignores the order recipients were written in', () => {
    const a = draft({ to: [{ address: 'a@example.com' }, { address: 'b@example.com' }] })
    const b = draft({ to: [{ address: 'b@example.com' }, { address: 'a@example.com' }] })
    expect(digestOf(a)).toBe(digestOf(b))
  })
})

describe('clientCanConfirm', () => {
  it('accepts a declared form capability', () => {
    expect(clientCanConfirm(ctxWith({ elicitation: { form: {} } }))).toBe(true)
  })

  it('accepts a bare declaration, which is the older way of saying form', () => {
    expect(clientCanConfirm(ctxWith({ elicitation: {} }))).toBe(true)
  })

  it('refuses a client that only declared url elicitation', () => {
    // URL elicitation cannot carry a yes or no, so it is not a confirmation.
    expect(clientCanConfirm(ctxWith({ elicitation: { url: {} } }))).toBe(false)
  })

  it('refuses a client that declared nothing at all', () => {
    expect(clientCanConfirm(ctxWith({}))).toBe(false)
    expect(clientCanConfirm(ctxWith(undefined))).toBe(false)
    expect(clientCanConfirm({})).toBe(false)
    expect(clientCanConfirm(undefined)).toBe(false)
  })
})

describe('confirmationAnswer', () => {
  const withResponse = (response: unknown) => ({
    mcpReq: { inputResponses: { [CONFIRM_KEY]: response } },
  })

  it('reads an explicit yes', () => {
    expect(
      confirmationAnswer(withResponse({ action: 'accept', content: { confirm: true } })),
    ).toBe('yes')
  })

  it('treats everything that is not an explicit true as a no', () => {
    // Every one of these has been a real bug somewhere: a missing field, a
    // string, a decline read as an accept.
    for (const response of [
      { action: 'accept', content: { confirm: false } },
      { action: 'accept', content: { confirm: 'true' } },
      { action: 'accept', content: {} },
      { action: 'decline' },
      { action: 'cancel' },
      {},
    ]) {
      expect(confirmationAnswer(withResponse(response))).toBe('no')
    }
  })

  it('reports a missing answer as missing rather than as a yes', () => {
    expect(confirmationAnswer({ mcpReq: {} })).toBe('missing')
    expect(confirmationAnswer({})).toBe('missing')
  })

  it('ignores an answer filed under some other key', () => {
    expect(
      confirmationAnswer({
        mcpReq: { inputResponses: { somethingElse: { action: 'accept', content: { confirm: true } } } },
      }),
    ).toBe('no')
  })
})

describe('describeForConfirmation', () => {
  it('shows every recipient, separated, and says what a blind copy is', () => {
    const text = describeForConfirmation(
      draft({
        cc: [{ address: 'copy@example.com' }],
        bcc: [{ address: 'quiet@example.com' }],
      }),
      'This message',
    )
    expect(text).toContain('To:  you@example.com')
    expect(text).toContain('Cc:  copy@example.com')
    expect(text).toContain('Bcc: quiet@example.com')
    expect(text).toContain('hidden from the other recipients')
    expect(text).toContain('me@example.com')
    expect(text).toContain('Subject: Subject')
  })

  it('carries no part of the message itself', () => {
    // It used to show the first lines. That was right when the confirmation was
    // the only thing anyone saw, and wrong once it grew past what a dialog can
    // display: measured at 74 lines for a newsletter-shaped message, the button
    // sat below the bottom of the window and the send could not be confirmed at
    // all. The body moved to a page with room for it; what stays here is who it
    // goes to and where to read it.
    const text = describeForConfirmation(
      draft({ text: 'First line\nSecond line' }),
      'This',
      'http://127.0.0.1:7345/pending/abc',
    )
    expect(text).not.toContain('First line')
    expect(text).toContain('http://127.0.0.1:7345/pending/abc')
    // What must never move: who it goes to.
    expect(text).toContain('you@example.com')
  })

  it('says that sending cannot be undone', () => {
    expect(describeForConfirmation(draft(), 'This')).toContain('cannot be undone')
  })
})

describe('confirmationRequest', () => {
  it('asks for an explicit boolean and carries the sealed state', () => {
    const request = confirmationRequest(draft(), 'This message', 'sealed-state')
    expect(request.requestState).toBe('sealed-state')
    const embedded = request.inputRequests?.[CONFIRM_KEY] as
      | { method?: string; params?: { message?: string; requestedSchema?: Record<string, unknown> } }
      | undefined
    expect(embedded?.method).toBe('elicitation/create')
    expect(embedded?.params?.message).toContain('you@example.com')
    expect(embedded?.params?.requestedSchema?.required).toEqual(['confirm'])
  })
})

describe('pendingSend', () => {
  it('reads a verified state', () => {
    const ctx = { mcpReq: { requestState: () => ({ tool: 'send_message', digest: 'abc' }) } }
    expect(pendingSend(ctx)).toEqual({ tool: 'send_message', digest: 'abc' })
  })

  it('treats a missing or malformed state as no state at all', () => {
    // Which means the first round runs again and the user is asked. Failing
    // towards asking is the only safe direction here.
    expect(pendingSend({ mcpReq: {} })).toBeUndefined()
    expect(pendingSend({ mcpReq: { requestState: () => undefined } })).toBeUndefined()
    expect(pendingSend({ mcpReq: { requestState: () => 'a string' } })).toBeUndefined()
    expect(pendingSend({ mcpReq: { requestState: () => ({ tool: 'x' }) } })).toBeUndefined()
    expect(pendingSend(undefined)).toBeUndefined()
  })
})
