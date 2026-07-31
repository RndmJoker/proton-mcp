import { describe, it, expect, afterEach } from 'vitest'
import { isInputRequiredResult } from '@modelcontextprotocol/server'
import {
  signInFailure,
  signInElicitation,
  clientCanShowUrl,
  priorAttempt,
  retryNote,
  SIGN_IN_KEY,
} from '../../src/tools/sign-in-required.js'
import {
  withSignIn,
  setSignInHint,
  setLockedCheck,
  describeFailure,
  _clearSignInHint,
} from '../../src/tools/failures.js'
import { NotSignedInError } from '../../src/bridge/connection.js'
import { explainError } from '../../src/bridge/errors.js'
import { BridgeError } from '../../src/bridge/errors.js'

/**
 * How a missing sign-in is answered.
 *
 * The one rule underneath all of this: the answer must never invite the Bridge
 * password into the conversation. Everything else is about getting the user to
 * the local page as directly as the client allows.
 */

const url = 'http://127.0.0.1:7345/?token=abc'

afterEach(() => {
  _clearSignInHint()
})

/** A request context as the SDK builds it. */
function context(options: { urlElicitation?: boolean; responses?: Record<string, unknown> } = {}) {
  const mcpReq: Record<string, unknown> = {}
  if (options.urlElicitation !== undefined) {
    mcpReq.envelope = {
      'io.modelcontextprotocol/clientCapabilities': {
        elicitation: options.urlElicitation ? { url: {} } : {},
      },
    }
  }
  if (options.responses) mcpReq.inputResponses = options.responses
  return { mcpReq }
}

/** A context whose envelope carries exactly the given capabilities. */
function capabilities(declared: Record<string, unknown>) {
  return { mcpReq: { envelope: { 'io.modelcontextprotocol/clientCapabilities': declared } } }
}

const text = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '')

describe('signInFailure', () => {
  it('names the address to open', () => {
    expect(text(signInFailure(url))).toContain(url)
  })

  it('insists the password is not asked for in the conversation', () => {
    // The whole reason the web interface exists. Without this sentence a model
    // asks the user to type their password into the chat.
    expect(text(signInFailure(url))).toContain('Do not ask for the password in this conversation')
  })

  it('explains which password is meant', () => {
    expect(text(signInFailure(url))).toContain('not the Proton account password')
  })

  it('falls back to the environment when the page is not running', () => {
    const answer = text(signInFailure(undefined))
    expect(answer).toContain('BRIDGE_USER')
    expect(answer).toContain('Do not ask for the password')
  })

  it('is marked as an error', () => {
    expect(signInFailure(url).isError).toBe(true)
  })

  it('carries a note about what already happened', () => {
    const answer = text(signInFailure(url, 'The request was declined.'))
    expect(answer).toContain('The request was declined.')
    expect(answer).toContain(url)
  })
})

describe('signInElicitation', () => {
  it('builds an input-required result rather than sending a request', () => {
    // The push API (ctx.mcpReq.elicitInput) throws on every request this server
    // serves: protocol revision 2026-07-28 has no server-to-client request
    // channel, and serveStdio binds the instance to that era. A returned value
    // is the only thing that can work here.
    const result = signInElicitation(url)
    expect(isInputRequiredResult(result)).toBe(true)
  })

  it('embeds a url-mode elicitation carrying the address', () => {
    const result = signInElicitation(url)
    const embedded = result.inputRequests?.[SIGN_IN_KEY] as {
      method: string
      params: { mode: string; url: string; message: string }
    }
    expect(embedded.method).toBe('elicitation/create')
    expect(embedded.params.mode).toBe('url')
    expect(embedded.params.url).toBe(url)
    expect(embedded.params.message).toContain('Bridge password')
  })

  it('carries no requestState', () => {
    // Whether someone is signed in is answered by asking the session. A claim
    // routed back through the client would be attacker-controlled input that we
    // would have to integrity-protect for no gain.
    expect(signInElicitation(url).requestState).toBeUndefined()
  })
})

describe('clientCanShowUrl', () => {
  it('trusts the capability declared on the request', () => {
    expect(clientCanShowUrl(context({ urlElicitation: true }))).toBe(true)
  })

  it('refuses when the client declared it cannot', () => {
    expect(clientCanShowUrl(context({ urlElicitation: false }))).toBe(false)
  })

  it('refuses when nothing was declared at all', () => {
    // Not optimism: an embedded request the client never declared is refused by
    // the SDK after the handler returns, as a protocol error the caller never
    // sees. The address in plain text is better than that.
    expect(clientCanShowUrl(context())).toBe(false)
    expect(clientCanShowUrl({})).toBe(false)
    expect(clientCanShowUrl(undefined)).toBe(false)
  })

  it('requires the url entry, not merely elicitation support', () => {
    // A client can elicit forms without being able to show a URL, and a form is
    // the one thing a Bridge password must never go through.
    expect(clientCanShowUrl(capabilities({ elicitation: { form: {} } }))).toBe(false)
  })

  it('accepts the record shape the wire actually uses', () => {
    // Measured against the live SDK: a `url: true` is refused with "expected
    // record, received boolean", so checking for `true` would have matched no
    // real client at all.
    expect(clientCanShowUrl(capabilities({ elicitation: { url: {} } }))).toBe(true)
  })

  it('treats an explicit false as no', () => {
    expect(clientCanShowUrl(capabilities({ elicitation: { url: false } }))).toBe(false)
  })

  it('says no on a legacy connection, which carries no envelope', () => {
    // There is no elicitation to be had there: the SDK reports that per-request
    // legacy serving cannot send server-to-client requests at all. Saying yes
    // would replace a usable address with that message.
    expect(clientCanShowUrl({ mcpReq: {} })).toBe(false)
  })
})

describe('priorAttempt', () => {
  it('reports none on a first call', () => {
    expect(priorAttempt(context())).toBe('none')
    expect(priorAttempt(context({ responses: {} }))).toBe('none')
  })

  it('recognises a completed round', () => {
    expect(priorAttempt(context({ responses: { [SIGN_IN_KEY]: { action: 'accept' } } }))).toBe(
      'accepted',
    )
  })

  it('recognises a declined or cancelled round', () => {
    expect(priorAttempt(context({ responses: { [SIGN_IN_KEY]: { action: 'decline' } } }))).toBe(
      'refused',
    )
    expect(priorAttempt(context({ responses: { [SIGN_IN_KEY]: { action: 'cancel' } } }))).toBe(
      'refused',
    )
  })

  it('ignores responses filed under another key', () => {
    expect(priorAttempt(context({ responses: { somethingElse: { action: 'accept' } } }))).toBe(
      'none',
    )
  })

  it('explains each outcome differently', () => {
    expect(retryNote('accepted')).toContain('no credentials arrived')
    expect(retryNote('refused')).toContain('declined')
    expect(retryNote('none')).toBeUndefined()
  })
})

describe('withSignIn', () => {
  const missing = () => Promise.reject(new NotSignedInError('nothing to connect with'))

  it('passes a successful answer straight through', async () => {
    const answer = { content: [{ type: 'text' as const, text: 'done' }] }
    expect(await withSignIn(context({ urlElicitation: true }), async () => answer)).toBe(answer)
  })

  it('asks the client to open the page when it can', async () => {
    setSignInHint(() => url)
    const result = await withSignIn(context({ urlElicitation: true }), missing)
    expect(isInputRequiredResult(result)).toBe(true)
  })

  it('answers with the address when the client cannot show a link', async () => {
    setSignInHint(() => url)
    const result = await withSignIn(context({ urlElicitation: false }), missing)
    expect(isInputRequiredResult(result)).toBe(false)
    expect(text(result)).toContain(url)
  })

  it('answers with the environment hint when no page is running', async () => {
    // The interface failed to start, most likely over a port. Elicitation would
    // point at nothing.
    const result = await withSignIn(context({ urlElicitation: true }), missing)
    expect(isInputRequiredResult(result)).toBe(false)
    expect(text(result)).toContain('BRIDGE_USER')
  })

  it('does not ask twice after the user has been through the page', async () => {
    // Asking again would be a loop the user cannot get out of.
    setSignInHint(() => url)
    const result = await withSignIn(
      context({ urlElicitation: true, responses: { [SIGN_IN_KEY]: { action: 'accept' } } }),
      missing,
    )
    expect(isInputRequiredResult(result)).toBe(false)
    expect(text(result)).toContain('no credentials arrived')
  })

  it('does not ask again after the request was declined', async () => {
    setSignInHint(() => url)
    const result = await withSignIn(
      context({ urlElicitation: true, responses: { [SIGN_IN_KEY]: { action: 'decline' } } }),
      missing,
    )
    expect(isInputRequiredResult(result)).toBe(false)
    expect(text(result)).toContain('declined')
  })

  it('succeeds on the retry once credentials have arrived', async () => {
    // The retry is a fresh invocation, so the work simply runs again. This is
    // what the second pass looks like when the user did sign in.
    setSignInHint(() => url)
    const answer = { content: [{ type: 'text' as const, text: 'mailboxes' }] }
    const result = await withSignIn(
      context({ urlElicitation: true, responses: { [SIGN_IN_KEY]: { action: 'accept' } } }),
      async () => answer,
    )
    expect(result).toBe(answer)
  })

  it('leaves every other failure alone', async () => {
    // A missing mailbox is not a sign-in problem and must not be dressed up as one.
    const boom = new BridgeError('the mailbox does not exist')
    await expect(
      withSignIn(context({ urlElicitation: true }), () => Promise.reject(boom)),
    ).rejects.toBe(boom)
  })

  it('never invites the password into the conversation', async () => {
    setSignInHint(() => url)
    for (const ctx of [
      context({ urlElicitation: false }),
      context({ urlElicitation: true, responses: { [SIGN_IN_KEY]: { action: 'decline' } } }),
    ]) {
      const result = await withSignIn(ctx, missing)
      expect(JSON.stringify(result)).not.toMatch(/enter (it|the password) here/i)
      expect(text(result)).toContain('Do not ask for the password')
    }
  })
})


describe('credentials that are only locked', () => {
  /**
   * The situation: an encrypted file exists, the Bridge password is on disk,
   * and the one thing missing is the master password the user chose.
   *
   * The ordinary message sends them to the Bridge application to look up a
   * password they already stored. That is not merely unhelpful, it is the
   * advice that ends with somebody deleting the encrypted file to escape a
   * loop they were never in.
   */
  it('asks for the master password, not the Bridge password', async () => {
    setSignInHint(() => url)
    setLockedCheck(async () => true)

    const result = await withSignIn(context(), async () => {
      throw new NotSignedInError('nothing stored')
    })
    const answer = text(result)

    expect(answer).toContain('encrypted file that is not open yet')
    expect(answer).toContain('master password')
    expect(answer).toContain(url)
    // The wrong errand, in as many words.
    expect(answer).not.toContain('the one the Bridge generates')
    expect(answer).not.toContain('no address has to be entered again\n\nOpen undefined')
  })

  it('still refuses to have the master password typed into the chat', async () => {
    setSignInHint(() => url)
    setLockedCheck(async () => true)
    const result = await withSignIn(context(), async () => {
      throw new NotSignedInError('locked')
    })
    expect(text(result)).toContain('Do not ask for the master password in this conversation')
  })

  it('says the page is the only way in when it is not running', async () => {
    setLockedCheck(async () => true)
    const result = await withSignIn(context(), async () => {
      throw new NotSignedInError('locked')
    })
    const answer = text(result)
    // BRIDGE_USER and BRIDGE_PASS would be the wrong advice here: the stored
    // credentials are fine, they are just closed.
    expect(answer).not.toContain('BRIDGE_USER')
    expect(answer).toContain('PROTON_MCP_WEB_PORT')
  })

  it('carries the right message into the elicitation as well', () => {
    const request = signInElicitation(url, 'locked')
    expect(isInputRequiredResult(request)).toBe(true)
    expect(JSON.stringify(request)).toContain('encrypted file that is not open yet')
  })

  it('names the master password in the retry note', () => {
    expect(retryNote('accepted', 'locked')).toContain('master password was not entered')
    expect(retryNote('accepted')).toContain('sign-in was not completed')
  })

  it('falls back to the ordinary message when nothing can answer', async () => {
    // No check wired: more than is needed rather than wrong, since the sign-in
    // message names both the address and the password.
    setSignInHint(() => url)
    const result = await withSignIn(context(), async () => {
      throw new NotSignedInError('nothing stored')
    })
    expect(text(result)).toContain('not signed in to Proton Mail Bridge yet')
  })

  it('falls back to the ordinary message when the check throws', async () => {
    setSignInHint(() => url)
    setLockedCheck(async () => {
      throw new Error('the keyring is not answering')
    })
    const result = await withSignIn(context(), async () => {
      throw new NotSignedInError('nothing stored')
    })
    expect(text(result)).toContain('not signed in to Proton Mail Bridge yet')
  })
})


describe('a Bridge that cannot be reached', () => {
  /**
   * The message from errors.ts says what happened. What is checked here is the
   * part that says who has to act, because without it a model either retries in
   * a loop or offers to start an application it cannot reach.
   */
  it('tells the agent that only the user can start the Bridge', () => {
    setSignInHint(() => url)
    const failure = explainError({ code: 'ECONNREFUSED' }, '127.0.0.1', 1143)
    const answer = text(describeFailure(failure, 'listing mailboxes'))

    expect(answer).toContain('start and unlock it themselves')
    expect(answer).toContain('Do not retry in a loop')
    expect(answer).toContain(url)
  })

  it('sends a rejected password to the page rather than into the chat', () => {
    setSignInHint(() => url)
    const failure = explainError({ responseText: 'AUTHENTICATIONFAILED' }, '127.0.0.1', 1143)
    const answer = text(describeFailure(failure, 'listing mailboxes'))

    expect(answer).toContain('enter the current one')
    expect(answer).toContain('Do not ask for it in this conversation')
    expect(answer).toContain(url)
  })

  it('distinguishes not ready from not running', () => {
    setSignInHint(() => url)
    const answer = text(
      describeFailure(explainError({ code: 'ETIMEDOUT' }, '127.0.0.1', 1143), 'listing'),
    )
    expect(answer).toContain('not ready yet')
    expect(answer).not.toContain('Do not retry in a loop')
  })

  it('adds nothing where the interface cannot help', () => {
    setSignInHint(() => url)
    const failure = explainError(new Error('self-signed certificate'), '127.0.0.1', 1143)
    const answer = text(describeFailure(failure, 'listing'))
    expect(answer).toBe(failure.message)
  })

  it('leaves out the address when no page is running', () => {
    const answer = text(
      describeFailure(explainError({ code: 'ECONNREFUSED' }, '127.0.0.1', 1143), 'listing'),
    )
    expect(answer).toContain('start and unlock it themselves')
    expect(answer).not.toContain('The configuration page is at')
  })
})
