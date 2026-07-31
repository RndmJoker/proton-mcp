/**
 * Sending over the Bridge's SMTP interface.
 *
 * This is the only code in the server that can make something leave the
 * machine, so it is deliberately small and says no in more places than it says
 * yes. The confirmation itself is not here: it belongs to the tool layer, where
 * the protocol's round trip lives. What is here is the part that must be true
 * regardless of who asks.
 *
 * ## The certificate
 *
 * The Bridge password goes over SMTP exactly as it goes over IMAP, so the
 * connection is pinned the same way. Measured on 31.07.2026: **the Bridge
 * presents the same certificate on both ports**, fingerprint for fingerprint,
 * so the entry recorded for IMAP is what SMTP is verified against and no second
 * pin is needed. That is also why nothing here disables the check: if Proton
 * ever gives the two ports different certificates, sending stops with a
 * verification failure instead of quietly handing the password to whatever
 * answered.
 *
 * ## No verification afterwards
 *
 * Measured on 31.07.2026: SMTP took about six and a half seconds to accept a
 * message and answer `250 2.0.0 OK: queued`, and the message showed up over
 * IMAP about three seconds after that. Nothing here looks for what it just
 * sent. What SMTP accepted is what is reported, and the answer says what that
 * does and does not mean.
 *
 * ## What Proton keeps
 *
 * Also measured, and it is the reason replying exists as a sending tool rather
 * than only as a draft tool: **a sent message keeps its `In-Reply-To`.** A
 * stored draft does not, and gets Proton's internal thread id in `References`
 * instead. `References` is normalised on the way out, keeping the entries
 * Proton can resolve and dropping the ones it cannot, which is reasonable
 * behaviour and leaves the threading intact.
 *
 * The blind copies were verified to be absent from the delivered headers while
 * the blind recipient still received the message. That is the whole reason the
 * envelope is stated separately below.
 */

import { createTransport, type Transporter } from 'nodemailer'
import type { Config, BridgeCredentials } from '../config.js'
import { BridgeError } from '../bridge/errors.js'
import { ensurePinned } from '../bridge/certificate.js'
import { buildMessage, allRecipients, type Draft } from './compose.js'

export interface SendOutcome {
  messageId: string
  /** Addresses the Bridge took responsibility for. */
  accepted: string[]
  /** Addresses it refused. A message can be half delivered. */
  rejected: string[]
  /** What the Bridge said, for the record. */
  response: string
}

/**
 * Opens an authenticated SMTP connection to the Bridge.
 *
 * Built per send rather than held open. Sending is rare, and a connection that
 * sits idle holding the Bridge password is a worse trade than a handshake.
 */
async function transport(
  config: Config,
  credentials: BridgeCredentials,
): Promise<Transporter> {
  // The pin is recorded against the IMAP port because that is where the first
  // connection happens. Measured to be the same certificate on the SMTP port,
  // so this is the material to verify against; a difference fails the
  // handshake rather than being waved through.
  const pinned = await ensurePinned(config.host, config.imapPort)

  return createTransport({
    host: config.host,
    port: config.smtpPort,
    // Plain connection upgraded via STARTTLS, which is what the Bridge offers.
    secure: false,
    // Not "if available": without this a server that drops STARTTLS from its
    // greeting would get the password in the clear.
    requireTLS: true,
    auth: { user: credentials.user, pass: credentials.pass },
    tls: {
      rejectUnauthorized: true,
      ca: [pinned.pem],
      // The certificate does not carry 127.0.0.1 as a subject alternative
      // name, so the hostname check has to go. It adds nothing on top of
      // pinning: matching one specific certificate says more than matching a
      // name written inside it.
      checkServerIdentity: () => undefined,
    },
    logger: false,
  })
}

function assertWritable(readOnly: boolean): void {
  if (readOnly) {
    throw new BridgeError(
      'The server is running read-only, so sending is refused. This is set by ' +
        'PROTON_MCP_READ_ONLY and the web interface reports it as the current mode.',
    )
  }
}

/**
 * Sends a message.
 *
 * The exact bytes that were built are handed over as the message, with the
 * envelope stated separately. That is not a detail: the envelope is what
 * carries the blind copies, and the built message must not, so the two have to
 * be given apart from one another.
 */
export async function sendMessage(
  config: Config,
  getCredentials: () => Promise<BridgeCredentials | undefined>,
  readOnly: boolean,
  draft: Draft,
): Promise<SendOutcome> {
  assertWritable(readOnly)

  const credentials = await getCredentials()
  if (!credentials) {
    throw new BridgeError(
      'No Bridge credentials are available, so there is nothing to send with. Sign in through ' +
        'the configuration page first.',
    )
  }

  const recipients = allRecipients(draft)
  if (recipients.length === 0) {
    throw new BridgeError('A message needs at least one recipient.')
  }

  // Built without the blind copies in the headers. They travel in the envelope
  // below, where the other recipients never see them.
  const raw = await buildMessage(draft, { keepBcc: false })

  const mailer = await transport(config, credentials)
  try {
    const info = await mailer.sendMail({
      // The bytes, not the fields: what was confirmed is what goes out.
      raw,
      envelope: {
        from: draft.from.address,
        to: recipients.map((r) => r.address),
      },
    })
    return {
      messageId: draft.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
      response: info.response ?? '',
    }
  } catch (error) {
    throw new BridgeError(
      `The Bridge did not accept the message: ${(error as Error).message}. ` +
        'Nothing was sent. Check that the Bridge is running and unlocked.',
      { cause: error },
    )
  } finally {
    mailer.close()
  }
}
