import { describe, it, expect } from 'vitest'
import { isTransportFailure } from '../../src/bridge/connection.js'

/**
 * Decides whether a failure gets one retry on a fresh connection. Getting this
 * wrong in either direction is bad: retrying a rejected login doubles the wait
 * before the user sees the real reason, and not retrying a dropped socket makes
 * the server fail whenever the Bridge was restarted between two calls.
 */
describe('isTransportFailure', () => {
  it('recognises dropped connections by their code', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_STREAM_DESTROYED']) {
      expect(isTransportFailure({ code })).toBe(true)
    }
  })

  it('recognises them by their message when no code is set', () => {
    expect(isTransportFailure(new Error('socket closed unexpectedly'))).toBe(true)
    expect(isTransportFailure(new Error('Connection closed'))).toBe(true)
    expect(isTransportFailure(new Error('client is not connected'))).toBe(true)
  })

  it('does not retry a rejected login', () => {
    // It would fail again and only delay the explanation.
    expect(isTransportFailure({ responseText: 'AUTHENTICATIONFAILED' })).toBe(false)
    expect(isTransportFailure(new Error('Invalid credentials'))).toBe(false)
  })

  it('does not retry a missing mailbox', () => {
    expect(isTransportFailure(new Error('Mailbox does not exist'))).toBe(false)
  })

  it('does not retry the empty-mailbox quirk', () => {
    // The Bridge answers FETCH on an empty mailbox with this. Retrying would
    // not help, the count has to be checked beforehand instead.
    expect(isTransportFailure(new Error('no such message'))).toBe(false)
  })

  it('copes with a failure that has no structure', () => {
    expect(isTransportFailure(undefined)).toBe(false)
    expect(isTransportFailure('a string')).toBe(false)
    expect(isTransportFailure({})).toBe(false)
  })
})
