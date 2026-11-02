import { describe, it, expect } from 'vitest'
import { plainFileName, forwardedFileName } from '../../src/mime/filenames.js'

/**
 * A name from a message is chosen by its sender. Each test pins one part of
 * the rule, so that removing that part turns exactly one test red.
 */

describe('plainFileName', () => {
  it('keeps letters of every script', () => {
    expect(plainFileName('notiz-\u00fcber-br\u00fccken.txt', 'x')).toBe('notiz-\u00fcber-br\u00fccken.txt')
    expect(plainFileName('\u0441\u0447\u0451\u0442 2026.pdf', 'x')).toBe('\u0441\u0447\u0451\u0442 2026.pdf')
  })

  it('replaces everything that is not a letter, a digit or a plain separator', () => {
    // Path separators, what Windows forbids in a name, a control character and
    // U+202E, which would make "txt.exe" read as "exe.txt".
    expect(plainFileName('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(plainFileName('line\u0000break', 'x')).toBe('line_break')
    expect(plainFileName('invoice\u202etxt.exe', 'x')).toBe('invoice_txt.exe')
    expect(plainFileName('zero\u200bwidth', 'x')).toBe('zero_width')
  })

  it('never starts with a dot, so nothing turns into a hidden file or a step upwards', () => {
    expect(plainFileName('.bashrc', 'x')).toBe('bashrc')
    const climbed = plainFileName('../../etc/passwd', 'x')
    expect(climbed.startsWith('.')).toBe(false)
    expect(climbed).not.toContain('/')
  })

  it('drops the dots and spaces at the end that Windows strips without asking', () => {
    expect(plainFileName('report.pdf. . ', 'x')).toBe('report.pdf')
  })

  it('does not hand out a device name Windows reserves', () => {
    expect(plainFileName('CON', 'x')).toBe('_CON')
    expect(plainFileName('nul.txt', 'x')).toBe('_nul.txt')
    expect(plainFileName('com1.log', 'x')).toBe('_com1.log')
    expect(plainFileName('console.txt', 'x')).toBe('console.txt')
  })

  it('falls back when nothing usable is left', () => {
    expect(plainFileName('...', 'attachment-3')).toBe('attachment-3')
    expect(plainFileName('', 'attachment-3')).toBe('attachment-3')
  })

  it('composes a decomposed letter, so the same word is the same name', () => {
    expect(plainFileName('u\u0308ber.txt', 'x')).toBe('\u00fcber.txt')
  })

  it('keeps the extension when a long name is shortened', () => {
    const name = plainFileName(`${'a'.repeat(200)}.pdf`, 'x', 100)
    expect(name.length).toBe(100)
    expect(name.endsWith('.pdf')).toBe(true)
  })

  it('counts characters rather than UTF-16 units, so no letter is cut in half', () => {
    // U+10400 is a letter outside the basic plane, two units long in UTF-16.
    const name = plainFileName('\u{10400}'.repeat(150), 'x', 100)
    expect(Array.from(name)).toHaveLength(100)
    expect(name).toBe('\u{10400}'.repeat(100))
  })
})

describe('forwardedFileName', () => {
  it('names the original after its subject, umlauts included', () => {
    expect(forwardedFileName('MCP-Test 3: Mit Anhang und Umlauten \u00e4\u00f6\u00fc\u00df')).toBe(
      'MCP-Test 3_ Mit Anhang und Umlauten \u00e4\u00f6\u00fc\u00df.eml',
    )
  })

  it('has a name for an original without a subject', () => {
    expect(forwardedFileName(undefined)).toBe('message.eml')
    expect(forwardedFileName('   ')).toBe('message.eml')
  })
})
