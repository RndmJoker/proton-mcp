import { describe, it, expect } from 'vitest'
import { assertSendableMarkup, readMarkup } from '../../src/mail/markup.js'
import { styleNotesOf, readableBody, type Draft } from '../../src/mail/compose.js'
import { describeForConfirmation } from '../../src/tools/confirm.js'
import { BridgeError } from '../../src/bridge/errors.js'

/**
 * How much markup a message may carry, and what happens when it carries more.
 *
 * The old rule refused a set of properties outright, which was wrong in both
 * directions at once. `display: inline-block` is what lets a link fill its own
 * padding, which is what makes a button clickable, and it hides nothing: every
 * message paid for a danger that was not there. Meanwhile the reason given for
 * the refusal did not hold either, because the confirmation read markup without
 * applying it and showed hidden text anyway.
 *
 * What changed is that the preview renders now. Text hidden by CSS really does
 * disappear from it. So the answer is no longer to refuse the property but to
 * report it: the caller says which level it needs, the confirmation warns, the
 * preview lists every use, and the person decides.
 */

const draft = (html: string, over: Partial<Draft> = {}): Draft => ({
  from: { address: 'me@example.com' },
  to: [{ address: 'you@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Subject',
  text: readableBody({ html } as Draft),
  messageId: '<one@example.com>',
  html,
  ...over,
})

const BUTTON =
  '<a href="https://example.com" style="display:inline-block;padding:12px 24px;' +
  'background:#6d4aff;color:#fff;border-radius:8px">To the repository</a>'

describe('the standard level', () => {
  it('is what applies when nobody says otherwise', () => {
    // A default that has to be asked for is not a default. Every path that
    // composes markup ends up here unless it names the wider one.
    expect(() => assertSendableMarkup(BUTTON)).toThrow(BridgeError)
    expect(styleNotesOf(draft('<p style="color:red">x</p>'))).toEqual([])
  })

  it('permits everything an ordinary formatted message uses', () => {
    const ordinary =
      '<h1 style="color:#333">Title</h1>' +
      '<p style="font-size:15px;line-height:1.6;margin:12px 0">Text</p>' +
      '<table style="border-collapse:collapse;width:100%"><tr>' +
      '<td style="padding:8px;border:1px solid #ccc;text-align:left">Cell</td></tr></table>' +
      '<img src="https://example.com/x.png" alt="A picture" width="400" height="200">'
    expect(() => assertSendableMarkup(ordinary)).not.toThrow()
  })

  it('refuses a button, and says where to get one', () => {
    // The refusal that started this. It has to name the way forward, or the
    // caller writes a worse message instead of a different one.
    try {
      assertSendableMarkup(BUTTON)
      throw new Error('should have been refused')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('display')
      expect(message).toContain('extended')
    }
  })
})

describe('the extended level', () => {
  it('permits the button and reports what it used', () => {
    const reading = assertSendableMarkup(BUTTON, 'extended')
    expect(reading.styleNotes).toHaveLength(1)
    expect(reading.styleNotes[0]).toMatchObject({
      property: 'display',
      value: 'inline-block',
      element: 'a',
      hides: false,
    })
  })

  it('tells apart a property that hides from one that does not', () => {
    // One property, two very different things to tell somebody about. This
    // distinction is the whole argument for reporting rather than refusing.
    const notes = readMarkup(
      '<p style="display:inline-block">a</p><p style="display:none">b</p>',
      'extended',
    ).styleNotes
    expect(notes.map((n) => n.hides)).toEqual([false, true])
  })

  it('recognises the ways of putting something out of sight', () => {
    const cases: Array<[string, boolean]> = [
      ['display:none', true],
      ['display:block', false],
      ['visibility:hidden', true],
      ['visibility:visible', false],
      ['opacity:0', true],
      ['opacity:0.05', true],
      ['opacity:0.9', false],
      ['position:absolute', true],
      ['position:relative', false],
      ['max-height:0', true],
      ['max-height:400px', false],
      ['text-indent:-9999px', true],
      ['text-indent:2em', false],
      ['font-size:0', true],
      ['width:0', true],
    ]
    for (const [style, expected] of cases) {
      const notes = readMarkup(`<p style="${style}">x</p>`, 'extended').styleNotes
      expect(notes[0]?.hides, style).toBe(expected)
    }
  })

  it('still refuses what is not a style at all', () => {
    // The level widens which properties may be used. It does not turn off the
    // element rules, and a script is not formatting.
    expect(() => assertSendableMarkup('<p>x</p><script>bad()</script>', 'extended')).toThrow()
    expect(() => assertSendableMarkup('<p onclick="bad()">x</p>', 'extended')).toThrow()
    expect(() => assertSendableMarkup('<style>p{display:none}</style>', 'extended')).toThrow()
    expect(() =>
      assertSendableMarkup('<img src="data:image/png;base64,iVBORw0KGgo=">', 'extended'),
    ).toThrow()
  })
})

describe('what the person confirming is told', () => {
  const url = 'http://127.0.0.1:7345/pending/abc'

  it('says nothing extra for an ordinary message', () => {
    const shown = describeForConfirmation(draft('<p style="color:red">x</p>'), 'This', url)
    expect(shown).not.toContain('CAN HIDE CONTENT')
  })

  it('warns whenever the wider level was used at all', () => {
    // Not only when something was demonstrably hidden. Whether a value hides
    // anything depends on where it sits, and a warning clever enough to judge
    // that is one that will be wrong once, in the direction nobody wants.
    const shown = describeForConfirmation(
      draft(BUTTON, { markupLevel: 'extended' }),
      'This',
      url,
    )
    expect(shown).toContain('CAN HIDE CONTENT')
    expect(shown).toContain('None of them hides anything by itself')
    expect(shown).toContain('Open the preview')
  })

  it('says plainly when something really is out of sight', () => {
    const shown = describeForConfirmation(
      draft('<p style="display:none">secret</p><p>visible</p>', { markupLevel: 'extended' }),
      'This',
      url,
    )
    expect(shown).toContain('put something out of sight')
    expect(shown).toContain('1 of them')
  })

  it('stays short even with the warning in it', () => {
    // The warning must not undo the fix it sits inside. A dialog that cannot
    // be answered protects nobody, whatever it says.
    const many = Array.from(
      { length: 30 },
      (_, i) => `<p style="display:inline-block;opacity:0.${i % 9}">line ${i}</p>`,
    ).join('')
    const shown = describeForConfirmation(draft(many, { markupLevel: 'extended' }), 'This', url)
    expect(shown.split('\n').length).toBeLessThan(22)
  })
})

describe('attributes that make a message well made rather than dangerous', () => {
  /**
   * Leaving these out was a mistake rather than a policy, and it showed: an
   * assistant reported that role and class were refused and dropped them, which
   * quietly made the message worse for anyone using a screen reader.
   */
  it('permits role, which is how a layout table is written', () => {
    // Without role="presentation" a screen reader announces "table, three rows,
    // two columns" for something that only centres a button.
    expect(() =>
      assertSendableMarkup('<table role="presentation"><tr><td>x</td></tr></table>'),
    ).not.toThrow()
  })

  it('permits the whole aria family rather than a list that goes stale', () => {
    for (const attribute of ['aria-label', 'aria-hidden', 'aria-describedby', 'aria-live']) {
      expect(() =>
        assertSendableMarkup(`<a href="https://example.com" ${attribute}="x">link</a>`),
        attribute,
      ).not.toThrow()
    }
  })

  it('permits class and id, which do nothing here and harm nothing', () => {
    // A message may carry no style block, so neither can select anything. Some
    // clients hang their own rules on them.
    expect(() => assertSendableMarkup('<div class="wrapper" id="top">x</div>')).not.toThrow()
  })

  it('permits the old colour attributes that Outlook still needs', () => {
    expect(() =>
      assertSendableMarkup('<table bgcolor="#ffffff"><tr><td bgcolor="#6d4aff">x</td></tr></table>'),
    ).not.toThrow()
  })

  it('still refuses what carries behaviour or reaches out of the message', () => {
    // The distinction the list is drawn along: describing a document is fine,
    // running in it or restyling what is around it is not.
    expect(() => assertSendableMarkup('<style>p{color:red}</style>')).toThrow()
    expect(() => assertSendableMarkup('<p onclick="bad()">x</p>')).toThrow()
    expect(() => assertSendableMarkup('<p onmouseover="bad()">x</p>', 'extended')).toThrow()
  })

  it('says what is permitted when it refuses an attribute', () => {
    // A refusal without a way forward is how an assistant ends up removing
    // more than it had to.
    try {
      assertSendableMarkup('<p contenteditable="true">x</p>')
      throw new Error('should have been refused')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('role')
      expect(message).toContain('aria-*')
    }
  })
})
