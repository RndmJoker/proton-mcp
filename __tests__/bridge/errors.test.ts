import { describe, it, expect } from 'vitest'
import { explainError, BridgeError } from '../../src/bridge/errors.js'

/**
 * For an MCP server the error message is part of the interface: it ends up in
 * the model's context. These tests therefore check more than the type, they
 * check that the message carries the decisive hint.
 */
describe('explainError', () => {
  it('explains a refused connection with the Bridge not running', () => {
    const e = explainError({ code: 'ECONNREFUSED' }, '127.0.0.1', 1143)
    expect(e).toBeInstanceOf(BridgeError)
    expect(e.message).toContain('most likely not running')
    // The port belongs in the text because a wrong port is the second most
    // common cause.
    expect(e.message).toContain('127.0.0.1:1143')
    // Nobody here can start it, and a model that does not know that retries.
    expect(e.message).toContain('neither start it nor unlock it')
    expect(e.remedy).toBe('unreachable')
  })

  it('names the lock as a possible cause on timeout', () => {
    expect(explainError({ code: 'ETIMEDOUT' }, '127.0.0.1', 1143).message).toContain('unlocked')
  })

  it('points out that the Bridge runs locally when the name does not resolve', () => {
    const e = explainError({ code: 'ENOTFOUND' }, 'bridge.example.com', 1143)
    expect(e.message).toContain('127.0.0.1')
  })

  it('explains a rejected login as a password that has moved on', () => {
    const e = explainError({ responseText: 'AUTHENTICATIONFAILED' }, '127.0.0.1', 1143)
    // The distinction that matters: it answered, so it is running. The stored
    // password is simply not the current one, which happens whenever an
    // account is added again.
    expect(e.message).toContain('answered and refused the login')
    expect(e.message).toContain('not the Proton account password')
    expect(e.remedy).toBe('credentials')
  })

  it('recognises the rejected login in the message as well as the response text', () => {
    const e = explainError(new Error('LOGIN failed: Invalid credentials'), '127.0.0.1', 1143)
    expect(e.message).toContain('answered and refused the login')
    expect(e.remedy).toBe('credentials')
  })

  it('marks a timeout as not ready rather than as unreachable', () => {
    // Different advice: unreachable means start it, not-ready means wait for
    // the person who is already unlocking it.
    expect(explainError({ code: 'ETIMEDOUT' }, '127.0.0.1', 1143).remedy).toBe('not-ready')
    expect(explainError({ code: 'ECONNRESET' }, '127.0.0.1', 1143).remedy).toBe('not-ready')
  })

  it('offers no remedy for a failure the interface cannot fix', () => {
    expect(explainError(new Error('self-signed certificate'), '127.0.0.1', 1143).remedy).toBe('none')
    expect(explainError(new Error('something unexpected'), '127.0.0.1', 1143).remedy).toBe('none')
  })

  it('explains a rejected certificate', () => {
    const e = explainError(new Error('self-signed certificate'), '127.0.0.1', 1143)
    expect(e.message).toContain('self-signed certificate')
  })

  it('passes unknown failures through instead of swallowing them', () => {
    const e = explainError(new Error('something unexpected'), '127.0.0.1', 1143)
    expect(e.message).toContain('something unexpected')
  })

  it('copes with a failure that has no structure at all', () => {
    expect(() => explainError('just a string', '127.0.0.1', 1143)).not.toThrow()
    expect(explainError(undefined, '127.0.0.1', 1143)).toBeInstanceOf(BridgeError)
  })

  it('keeps the original cause so nothing is lost', () => {
    const raw = new Error('original')
    expect(explainError(raw, '127.0.0.1', 1143).cause).toBe(raw)
  })
})
