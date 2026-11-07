/**
 * The security layer of the local web interface.
 *
 * The threat model is not "someone on the internet": the server binds to
 * loopback only, so nobody reaches it from outside. What has to be defended
 * against is anything the user's browser is talked into doing by a page from
 * elsewhere, and, when the user sets one, anything on the same machine that does
 * not know the PIN.
 *
 * Four defences, each against a specific attack:
 *
 * 1. **An optional PIN on every change.** Any local program can send a request
 *    to 127.0.0.1, and so can the assistant, through a browser tool. Until
 *    2026-11-05 a token in the address kept them out, but the address reached
 *    the assistant through `open_configuration`, so the token protected against
 *    everything except the one party the switches for autonomy are about. A PIN
 *    the user types and the assistant never sees does. It is optional: without
 *    one, anything on this machine can change the settings, and the pages say so.
 * 2. **Host header check.** A page on the internet can resolve its own domain to
 *    127.0.0.1 and have the browser send requests there. The browser then treats
 *    that domain as the origin, so same-origin rules do not help. Rejecting any
 *    Host other than a loopback name stops it. This is DNS rebinding, and it is
 *    the attack local servers most often forget.
 * 3. **Origin check plus CSRF token on writes.** A page from elsewhere can post
 *    a form to 127.0.0.1 without reading the response. That is enough to change
 *    settings, so writes require a matching origin and a token bound to the
 *    session.
 * 4. **A restrictive Content-Security-Policy.** No external scripts, styles,
 *    fonts or images, and no inline event handlers, so injected markup cannot
 *    fetch anything or run.
 *
 * All comparisons of secrets use timingSafeEqual, so response time does not
 * reveal how much of a token was right.
 */

import { randomBytes, timingSafeEqual, createHmac, scrypt } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** Hostnames that mean this machine. Anything else is rejected. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export interface SessionSecrets {
  /** Signs CSRF tokens. Never leaves the process. */
  csrfSecret: string
}

/** Creates the per-process secrets. */
export function createSession(): SessionSecrets {
  return {
    csrfSecret: randomBytes(32).toString('base64url'),
  }
}

/**
 * A PIN as it is stored: salted and run through scrypt, never the PIN itself.
 *
 * The settings file is readable by the user's own programs, the assistant
 * included when it can read files. A plain PIN there would be a PIN the
 * assistant can look up. A hash of a short PIN can still be guessed offline,
 * which is why the length rule below asks for more than four digits and why
 * scrypt rather than a fast hash: every guess has to pay for the memory.
 */
export interface StoredPin {
  salt: string
  hash: string
}

/** scrypt with Node's default cost, named so a change here is deliberate. */
const PIN_KEY_LENGTH = 32
const PIN_COST = { N: 16384, r: 8, p: 1 }

function derive(pin: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin.normalize('NFC'), salt, PIN_KEY_LENGTH, PIN_COST, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}

/** Why a PIN cannot be used, or nothing when it can. */
export function pinProblem(pin: string): string | undefined {
  if (pin.length < 6) return 'The PIN needs at least 6 characters.'
  if (pin.length > 128) return 'The PIN can have at most 128 characters.'
  return undefined
}

export async function hashPin(pin: string): Promise<StoredPin> {
  const salt = randomBytes(16).toString('base64url')
  return { salt, hash: (await derive(pin, salt)).toString('base64url') }
}

export async function pinMatches(pin: string, stored: StoredPin): Promise<boolean> {
  const presented = await derive(pin, stored.salt)
  return safeEqual(presented.toString('base64url'), stored.hash)
}

/**
 * Slows down guessing.
 *
 * After `max` wrong PINs within `windowMs`, every attempt is refused until the
 * window has passed, the right PIN included: a lock that the right answer opens
 * early tells the guesser when they found it. Held in memory by the server that
 * shows the interface, which is the only one that checks PINs.
 */
export class AttemptLimiter {
  #failures: number[] = []
  readonly #max: number
  readonly #windowMs: number

  constructor(max = 5, windowMs = 60_000) {
    this.#max = max
    this.#windowMs = windowMs
  }

  /** Whether an attempt may be checked at all right now. */
  allowed(now = Date.now()): boolean {
    this.#failures = this.#failures.filter((at) => now - at < this.#windowMs)
    return this.#failures.length < this.#max
  }

  fail(now = Date.now()): void {
    this.#failures.push(now)
  }

  reset(): void {
    this.#failures = []
  }
}

/** Compares two secrets without leaking their similarity through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // timingSafeEqual throws on differing lengths, which would itself be a signal,
  // so pad to a fixed size first.
  const size = Math.max(left.length, right.length, 1)
  const paddedLeft = Buffer.alloc(size)
  const paddedRight = Buffer.alloc(size)
  left.copy(paddedLeft)
  right.copy(paddedRight)
  return timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length
}

/**
 * Checks the Host header.
 *
 * The defence against DNS rebinding: a page at evil.example.com can point that
 * name at 127.0.0.1, and the browser will happily send requests with
 * `Host: evil.example.com`. Only loopback names are accepted.
 */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false
  // Strip the port. IPv6 literals keep their brackets.
  const withoutPort = host.startsWith('[')
    ? (host.match(/^\[[^\]]+\]/)?.[0] ?? host)
    : (host.split(':')[0] ?? host)
  return LOOPBACK_HOSTS.has(withoutPort.toLowerCase())
}

/**
 * Checks the Origin header for state-changing requests.
 *
 * A missing Origin is accepted, because browsers omit it for ordinary top-level
 * navigation and non-browser clients never send it. A present but foreign one is
 * rejected: that is a cross-site request.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true
  if (origin === 'null') return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:') return false
  if (parsed.port && Number(parsed.port) !== port) return false
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
}

/**
 * Derives a CSRF token for a form.
 *
 * Bound to the session secret and to the form's purpose, so a token for one
 * action cannot be replayed against another.
 */
export function csrfToken(secrets: SessionSecrets, purpose: string): string {
  return createHmac('sha256', secrets.csrfSecret).update(purpose).digest('base64url')
}

export function csrfValid(secrets: SessionSecrets, purpose: string, presented: string): boolean {
  return safeEqual(csrfToken(secrets, purpose), presented)
}

/** Why a request was rejected. Deliberately vague towards the client. */
export type RejectionReason =
  | 'bad-host'
  | 'bad-origin'
  | 'bad-csrf'
  | 'method-not-allowed'

export interface CheckResult {
  ok: boolean
  reason?: RejectionReason
}

export interface CheckOptions {
  request: IncomingMessage
  secrets: SessionSecrets
  port: number
  /** True for requests that change something. */
  writing: boolean
  /** For writing requests: the CSRF token and what it is for. */
  csrf?: { purpose: string; presented: string | undefined }
}

/**
 * Runs every check in order.
 *
 * Order matters: the host check comes first, so a rebinding attempt is refused
 * before anything else is looked at. The PIN is not checked here: a wrong PIN is
 * the user's mistake and gets a page that says so, where every failure in here
 * gets the same refusal that says nothing.
 */
export function checkRequest(options: CheckOptions): CheckResult {
  const { request, secrets, port, writing, csrf } = options

  if (!isAllowedHost(request.headers.host)) return { ok: false, reason: 'bad-host' }

  if (writing) {
    if (!isAllowedOrigin(request.headers.origin, port)) return { ok: false, reason: 'bad-origin' }
    if (!csrf?.presented || !csrfValid(secrets, csrf.purpose, csrf.presented)) {
      return { ok: false, reason: 'bad-csrf' }
    }
  }

  return { ok: true }
}

/**
 * The referrer policy.
 *
 * `same-origin` rather than the stricter-looking `no-referrer`, and this is not a
 * concession: `no-referrer` **breaks the Origin check above**, which makes every
 * form on this interface unusable.
 *
 * The mechanism, per the Fetch standard: when a request's referrer policy is
 * `no-referrer`, the browser sets the request's origin to an opaque one, and the
 * `Origin` header goes out as the literal string `null`. Since a foreign or
 * sandboxed page can also produce `Origin: null`, that value has to be refused,
 * so the interface would refuse its own forms. Confirmed in a real browser:
 * every POST answered 404 with reason `bad-origin` until this was changed.
 *
 * Nothing is given up. The strict CSP already forbids this page from reaching any
 * other host, and the page contains no external links, so `same-origin` has no
 * third party to leak a referrer to in the first place.
 *
 * Do not "harden" this back to `no-referrer` without a browser to try it in.
 */
export const REFERRER_POLICY = 'same-origin'

/**
 * The headers every response carries.
 *
 * The CSP is the strict kind: nothing may be loaded from anywhere, styles are
 * allowed only from the document itself, and there is no way to reach the
 * network. `frame-ancestors 'none'` keeps the page out of foreign frames, which
 * also rules out clickjacking.
 */
export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      // For the one page that shows a message waiting to be sent. The content
      // is passed as srcdoc rather than fetched, so this permits an inline
      // document and nothing from anywhere.
      //
      // What the frame inherits from this policy is the point of putting it
      // here at all: img-src stays 'self' data: inside it, so a message full of
      // remote images loads none of them. A tracking pixel in a message being
      // previewed would tell its author that the message was looked at, and a
      // preview must not be an event anybody outside gets to observe.
      "frame-src 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': REFERRER_POLICY,
    // The interface shows configuration, never mail. Still, nothing here should
    // linger in a cache a later user could read.
    'Cache-Control': 'no-store, max-age=0',
    // No browser feature this page needs is worth leaving enabled.
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  }
}
