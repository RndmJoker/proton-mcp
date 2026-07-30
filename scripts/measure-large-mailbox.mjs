// Scaling measurement against a large mailbox.
//
// STRICTLY READ-ONLY. The script issues nothing but SELECT, STATUS, SEARCH and
// FETCH on RFC822.SIZE. There is no command in here that changes anything.
//
// What it prints: numbers. Message counts, hit counts, timings, size
// distribution.
// What it does NOT print: subject lines, senders, recipients, content,
// attachment names. User folder names are anonymised, because a folder name is
// personal data in itself. Only system mailboxes appear verbatim.
//
// Usage:  node scripts/measure-large-mailbox.mjs <path-to-env-file>

import { ImapFlow } from 'imapflow'
import { readFileSync } from 'node:fs'

const envPath = process.argv[2]
if (!envPath) {
  console.error('Usage: node scripts/measure-large-mailbox.mjs <path-to-env-file>')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf('=')
    return [line.slice(0, i), line.slice(i + 1)]
  }),
)

const SYSTEM = new Set(['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash', 'All Mail', 'Starred'])
// User folders get a running number instead of their name.
const anon = new Map()
const label = (p) =>
  SYSTEM.has(p) ? p : (anon.has(p) ? anon.get(p) : (anon.set(p, `<user folder ${anon.size + 1}>`), anon.get(p)))

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6

const client = new ImapFlow({
  host: env.BRIDGE_HOST ?? '127.0.0.1',
  port: Number(env.BRIDGE_IMAP_PORT ?? 1143),
  secure: false,
  auth: { user: env.BRIDGE_USER, pass: env.BRIDGE_PASS },
  tls: { rejectUnauthorized: false },
  logger: false,
})

const tConnect = process.hrtime.bigint()
await client.connect()
console.log(`Connected in ${ms(tConnect).toFixed(0)} ms\n`)

// --- 1. Size of the mailbox ---
console.log('=== SCALE ===')
const boxes = (await client.list()).filter((b) => !b.flags.has('\\Noselect'))
let total = 0
const nonEmpty = []
for (const b of boxes) {
  const st = await client.status(b.path, { messages: true })
  total += st.messages
  if (st.messages > 0) nonEmpty.push({ path: b.path, n: st.messages })
}
nonEmpty.sort((a, b) => b.n - a.n)
console.log(`Mailboxes total        : ${boxes.length} (${nonEmpty.length} non-empty)`)
console.log(`Messages total         : ${total}  (may double-count via "All Mail")`)
console.log('\nTen largest mailboxes:')
for (const g of nonEmpty.slice(0, 10)) {
  console.log(`  ${label(g.path).padEnd(24)} ${String(g.n).padStart(7)} messages`)
}

// --- 2. Search timings in the largest mailbox ---
const target = nonEmpty[0]
if (!target) {
  console.log('\nNo messages present, measurement ends here.')
  await client.logout()
  process.exit(0)
}

console.log(`\n=== SEARCH in the largest mailbox (${label(target.path)}, ${target.n} messages) ===`)
console.log('Only hit counts and timings are printed, never the hits themselves.\n')

const lock = await client.getMailboxLock(target.path)
try {
  const queries = [
    ['BODY "invoice"', { body: 'invoice' }],
    ['BODY "order"', { body: 'order' }],
    ['BODY "newsletter"', { body: 'newsletter' }],
    ['BODY "meeting"', { body: 'meeting' }],
    ['BODY "zzqxwvunknown" (no hit expected)', { body: 'zzqxwvunknown' }],
    ['HEADER SUBJECT "invoice"', { header: { subject: 'invoice' } }],
    ['SINCE 30 days ago', { since: new Date(Date.now() - 30 * 86400000) }],
    ['UNSEEN', { seen: false }],
    ['LARGER 1 MB', { larger: 1024 * 1024 }],
    ['ALL', { all: true }],
  ]
  for (const [name, q] of queries) {
    const t0 = process.hrtime.bigint()
    try {
      const r = await client.search(q, { uid: true })
      console.log(`  ${name.padEnd(44)} ${String(r.length).padStart(6)} hits   ${ms(t0).toFixed(0).padStart(6)} ms`)
    } catch (e) {
      console.log(`  ${name.padEnd(44)} FAILED: ${e.message}`)
    }
  }

  // --- 3. Size distribution, RFC822.SIZE only ---
  console.log('\n=== SIZE DISTRIBUTION (byte values only, no content) ===')
  const t0 = process.hrtime.bigint()
  const sizes = []
  const sampleSize = Math.min(target.n, 3000)
  for await (const m of client.fetch(`1:${sampleSize}`, { size: true })) sizes.push(m.size)
  const elapsed = ms(t0)
  sizes.sort((a, b) => a - b)
  const p = (q) => sizes[Math.floor(sizes.length * q)] ?? 0
  const kb = (n) => (n / 1024).toFixed(1) + ' KB'
  const tokens = (n) => Math.round(n / 4)
  console.log(`Sample                 : ${sizes.length} messages in ${elapsed.toFixed(0)} ms (${(elapsed / sizes.length).toFixed(2)} ms each)`)
  console.log(`Median                 : ${kb(p(0.5))}   roughly ${tokens(p(0.5))} tokens raw`)
  console.log(`75th percentile        : ${kb(p(0.75))}   roughly ${tokens(p(0.75))} tokens`)
  console.log(`95th percentile        : ${kb(p(0.95))}   roughly ${tokens(p(0.95))} tokens`)
  console.log(`Largest in sample      : ${kb(sizes.at(-1) ?? 0)}`)
  const sum = sizes.reduce((a, b) => a + b, 0)
  console.log(`\nExtrapolated: 20 median messages raw = roughly ${tokens(p(0.5)) * 20} tokens`)
  console.log(`Sample total           : ${(sum / 1048576).toFixed(1)} MB`)

  // --- 4. How expensive is fetching headers? ---
  console.log('\n=== HEADER FETCH (to size up pagination) ===')
  for (const n of [50, 200, 1000]) {
    if (n > target.n) continue
    const t = process.hrtime.bigint()
    let count = 0
    for await (const _m of client.fetch(`1:${n}`, { envelope: true, flags: true, size: true })) count++
    console.log(`  ${String(n).padStart(5)} headers: ${ms(t).toFixed(0).padStart(6)} ms  (${(ms(t) / count).toFixed(2)} ms each)`)
  }
} finally {
  lock.release()
}

await client.logout()
console.log('\nMeasurement finished, connection closed.')
