import { describe, it, expect } from 'vitest'
import { INSTRUCTIONS } from '../../src/tools/guidance.js'
import { assertSendableMarkup } from '../../src/mail/markup.js'

/**
 * What the server tells a model about itself, checked against what it does.
 *
 * These exist because of a real cost. The writing guide said images "may point
 * at a full address or at a file carried inside the message", and elsewhere
 * that a message cannot be given a file from this machine. Both sentences were
 * true, and together they read as a riddle: how does a file get inside a
 * message if no file can be taken from this machine? An assistant resolved it
 * the cautious way, concluded that images were unavailable, and wrote a plainer
 * message than it needed to. Nobody noticed until the message arrived.
 *
 * A guide is an interface. Nothing else here ships a claim about behaviour
 * without a test underneath it, and prose is the part a model actually reads.
 */

describe('the instructions sent with every connection', () => {
  it('stay short enough to be worth sending every time', () => {
    // Paid for on every session whether anyone needs them or not. Past a
    // certain size they stop being read, which is the failure they exist to
    // prevent.
    expect(INSTRUCTIONS.length).toBeLessThan(2000)
  })

  it('name the four things that go wrong quietly', () => {
    expect(INSTRUCTIONS).toContain('Nothing is sent without a person agreeing')
    expect(INSTRUCTIONS).toContain('either plain text or markup, never both')
    expect(INSTRUCTIONS).toContain('Writes need time to settle')
    expect(INSTRUCTIONS).toContain('Nothing here deletes for good')
  })

  it('point at the guides rather than repeating them', () => {
    expect(INSTRUCTIONS).toContain('proton-mcp://guide/writing')
    expect(INSTRUCTIONS).toContain('proton-mcp://guide/bridge')
  })
})

/**
 * The examples the writing guide gives, checked against the markup rules.
 *
 * This is the part that would have caught the mistake. A guide claiming
 * something is permitted while the code refuses it is worse than no guide: the
 * model tries it, gets a refusal, and learns to distrust the rest of it.
 */
describe('what the guide says about images matches what is permitted', () => {
  const permitted: Array<[string, string]> = [
    ['a plain web address', '<img src="https://example.com/logo.png" alt="Logo">'],
    ['an animated GIF', '<img src="https://example.com/spinner.gif" alt="Loading">'],
    [
      'a sized and styled image',
      '<img src="https://example.com/x.png" width="400" height="120" style="border-radius:8px">',
    ],
    [
      'an image inside a link, which is how a button is made',
      '<a href="https://example.com"><img src="https://example.com/b.png" alt="To the repository"></a>',
    ],
    ['a cid reference, which a forwarded message can carry', '<img src="cid:logo@example.com">'],
  ]

  for (const [what, html] of permitted) {
    it(`permits ${what}`, () => {
      expect(() => assertSendableMarkup(html)).not.toThrow()
    })
  }

  it('refuses a data address, as the guide says', () => {
    // The one refusal on images, and the guide states it as one: it would
    // carry a whole file inside the markup, where nothing lists it.
    expect(() => assertSendableMarkup('<img src="data:image/png;base64,iVBORw0KGgo=">')).toThrow()
  })
})
