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
    expect(e.message).toContain('probably not running')
    // The port belongs in the text because a wrong port is the second most
    // common cause.
    expect(e.message).toContain('127.0.0.1:1143')
    expect(e.message).toContain('BRIDGE_IMAP_PORT')
  })

  it('names the lock as a possible cause on timeout', () => {
    expect(explainError({ code: 'ETIMEDOUT' }, '127.0.0.1', 1143).message).toContain('unlocked')
  })

  it('points out that the Bridge runs locally when the name does not resolve', () => {
    const e = explainError({ code: 'ENOTFOUND' }, 'bridge.example.com', 1143)
    expect(e.message).toContain('127.0.0.1')
  })

  it('explains a rejected login with the confused password', () => {
    const e = explainError({ responseText: 'AUTHENTICATIONFAILED' }, '127.0.0.1', 1143)
    expect(e.message).toContain('not the password of your Proton account')
  })

  it('recognises the rejected login in the message as well as the response text', () => {
    const e = explainError(new Error('LOGIN failed: Invalid credentials'), '127.0.0.1', 1143)
    expect(e.message).toContain('not the password of your Proton account')
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
