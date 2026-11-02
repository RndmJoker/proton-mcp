/**
 * Turns technical failures into sentences a language model can act on.
 *
 * For an MCP server the error message is part of the interface: it ends up in
 * the model's context, which then has to work out what to do next.
 * "ECONNREFUSED 127.0.0.1:1143" does not help with that.
 */

/**
 * What would fix it, as a category rather than as a sentence.
 *
 * The sentence needs the address of the configuration page, and this module has
 * no business knowing that. So the diagnosis happens here, where the error codes
 * are, and the remedy is written where the address is known. See describeFailure.
 */
export type BridgeRemedy =
  /** Nothing is listening. The Bridge is not running, or the port is wrong. */
  | 'unreachable'
  /** It answered and refused the login. The stored password is stale. */
  | 'credentials'
  /** It is there but not ready: starting up, or locked. */
  | 'not-ready'
  /** Nothing the user can do from the interface. */
  | 'none'

export class BridgeError extends Error {
  override name = 'BridgeError'
  readonly remedy: BridgeRemedy

  constructor(message: string, remedy: BridgeRemedy = 'none', options?: ErrorOptions) {
    super(message, options)
    this.remedy = remedy
  }
}

interface ErrorWithCode {
  code?: string
  /**
   * The code of the system error, where a library put its own in `code`.
   * nodemailer files a refused connection as ESOCKET and keeps ECONNREFUSED
   * here.
   */
  originalCode?: string
  responseText?: string
  message?: string
}

/** The codes that mean the connection itself did not come about. */
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'])

/** The system code of an error, also where a library relabelled it. */
function systemCode(e: ErrorWithCode | undefined): string | undefined {
  return e?.originalCode ?? e?.code
}

/**
 * Whether the connection itself failed, rather than something said over it.
 *
 * Sending learns this only from nodemailer, which relabels the system error,
 * and since the certificate is no longer fetched before every send, a send is
 * where a Bridge that is not running shows up first.
 */
export function isConnectionFailure(error: unknown): boolean {
  const code = systemCode(error as ErrorWithCode)
  return code !== undefined && CONNECTION_CODES.has(code)
}

/**
 * Builds an understandable message from an arbitrary failure.
 *
 * `host` and `port` appear in the text because the ports are configurable and
 * a wrong port is the second most common cause.
 */
export function explainError(error: unknown, host: string, port: number): BridgeError {
  const e = error as ErrorWithCode
  const address = `${host}:${port}`
  const code = systemCode(e)

  if (code === 'ECONNREFUSED') {
    return new BridgeError(
      `Nothing is accepting connections on ${address}. Proton Mail Bridge is most likely not ` +
        'running: it is a desktop application that has to be started and unlocked by the person ' +
        'using it, and this server can neither start it nor unlock it. If it is running, it may ' +
        'be listening on a different port, which the Bridge shows under Settings, Advanced.',
      'unreachable',
      { cause: error },
    )
  }

  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return new BridgeError(
      `The connection to ${address} did not come up, or it was dropped. That happens while the ` +
        'Bridge is starting up and while it is locked, both of which pass on their own once the ' +
        'person at the machine has unlocked it.',
      'not-ready',
      { cause: error },
    )
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new BridgeError(
      `The address "${host}" could not be resolved. Unless the Bridge was deliberately put on ` +
        'another machine, BRIDGE_HOST should be 127.0.0.1.',
      'unreachable',
      { cause: error },
    )
  }

  // imapflow reports rejected logins as AUTHENTICATIONFAILED.
  const text = `${e?.responseText ?? ''} ${e?.message ?? ''}`
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(text)) {
    return new BridgeError(
      'The Bridge answered and refused the login, so it is running and the stored password is no ' +
        'longer the right one. The Bridge generates a new password whenever an account is removed ' +
        'and added again, and it can be regenerated at any time, so a password that worked ' +
        'yesterday can be wrong today. It is not the Proton account password: the current one is ' +
        'shown in the Bridge application under the account.',
      'credentials',
      { cause: error },
    )
  }

  if (/certificate|self.signed|DEPTH_ZERO/i.test(text)) {
    return new BridgeError(
      'The Bridge certificate was rejected. The Bridge uses a self-signed certificate, ' +
        'which is only accepted for connections to 127.0.0.1.',
      'none',
      { cause: error },
    )
  }

  // imapflow marks a STARTTLS that was required and did not happen. The Bridge
  // always offers it, so the likelier story is something else on the port.
  if ((error as { tlsFailed?: unknown })?.tlsFailed === true || /STARTTLS/.test(text)) {
    return new BridgeError(
      `Whatever answered on ${address} did not offer an encrypted connection, so the password was ` +
        'not sent. Proton Mail Bridge always offers one. If the Bridge is running, check that this ' +
        'is its port; otherwise another program may be listening there.',
      'none',
      { cause: error },
    )
  }

  const raw = e?.message ?? String(error)
  return new BridgeError(`The Bridge reported an error: ${raw}`, 'none', { cause: error })
}
