import { describe, it, expect, beforeEach } from 'vitest'
import {
  canElicitForm,
  canElicitUrl,
  declaredCapabilities,
  setHandshakeCapabilities,
  _clearHandshakeCapabilities,
} from '../../src/tools/capabilities.js'

/**
 * Where the client's declaration is read from.
 *
 * These are unit tests and they cannot prove the important thing, which is that
 * the source they read exists on a real connection. That is
 * confirmation-over-the-wire.test.ts, and this file is deliberately the smaller
 * half: the previous version of this check had a full set of unit tests and was
 * wrong anyway, because every one of them handed it the shape it expected.
 */

const ENVELOPE_KEY = 'io.modelcontextprotocol/clientCapabilities'
const withEnvelope = (capabilities: unknown) => ({ mcpReq: { envelope: { [ENVELOPE_KEY]: capabilities } } })

beforeEach(() => {
  _clearHandshakeCapabilities()
})

describe('where the declaration comes from', () => {
  it('reads the per-request envelope when there is one', () => {
    expect(declaredCapabilities(withEnvelope({ elicitation: { form: {} } }))).toEqual({
      elicitation: { form: {} },
    })
  })

  it('falls back to the handshake, which is where this era carries it', () => {
    // The defect in v0.4.0 in one line: on the protocol revision this SDK
    // speaks there is no envelope at all, so a check that read only the
    // envelope refused every client.
    setHandshakeCapabilities(() => ({ elicitation: { form: {} } }))
    expect(canElicitForm({ mcpReq: {} })).toBe(true)
    expect(canElicitForm(undefined)).toBe(true)
  })

  it('prefers the envelope when both are there', () => {
    // The envelope belongs to this request; the handshake to the connection.
    // The more specific one wins.
    setHandshakeCapabilities(() => ({ elicitation: { url: {} } }))
    expect(canElicitForm(withEnvelope({ elicitation: { form: {} } }))).toBe(true)
    expect(canElicitUrl(withEnvelope({ elicitation: { form: {} } }))).toBe(false)
  })

  it('says nothing when a source throws, so the caller refuses', () => {
    setHandshakeCapabilities(() => {
      throw new Error('no connection state')
    })
    expect(declaredCapabilities({})).toBeUndefined()
    expect(canElicitForm({})).toBe(false)
  })

  it('says nothing when no source was ever registered', () => {
    expect(declaredCapabilities({})).toBeUndefined()
    expect(canElicitForm({})).toBe(false)
    expect(canElicitUrl({})).toBe(false)
  })
})

describe('reading a declaration', () => {
  it('accepts a named mode', () => {
    setHandshakeCapabilities(() => ({ elicitation: { form: {}, url: {} } }))
    expect(canElicitForm({})).toBe(true)
    expect(canElicitUrl({})).toBe(true)
  })

  it('treats a bare declaration as form and not as url', () => {
    // The SDK's own reading: before modes existed, a bare declaration meant
    // form. It never meant url, and guessing otherwise would send a mode the
    // client did not declare.
    setHandshakeCapabilities(() => ({ elicitation: {} }))
    expect(canElicitForm({})).toBe(true)
    expect(canElicitUrl({})).toBe(false)
  })

  it('refuses a mode that is absent or switched off', () => {
    setHandshakeCapabilities(() => ({ elicitation: { url: {}, form: false } }))
    expect(canElicitForm({})).toBe(false)
    expect(canElicitUrl({})).toBe(true)
  })

  it('refuses anything that is not a declaration at all', () => {
    for (const nonsense of [null, undefined, 'yes', 42, [], { elicitation: null }]) {
      setHandshakeCapabilities(() => nonsense)
      expect(canElicitForm({})).toBe(false)
      expect(canElicitUrl({})).toBe(false)
    }
  })
})
