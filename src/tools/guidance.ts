/**
 * What this server tells a model about itself.
 *
 * Two channels, and the difference between them is the whole design here:
 *
 * - **`instructions`** travels with every connection whether anyone wants it or
 *   not, so it costs context on every single session. It says only what a model
 *   would otherwise get wrong before it had a reason to look anything up.
 * - **Resources** are read on demand. They can afford to be thorough, because
 *   nobody pays for the ones that are not read.
 *
 * The split is not tidiness. A tool description that grows until nobody reads
 * it protects nobody, and the same is true of instructions. So the short text
 * names the traps and points here; the long text explains why they are traps.
 *
 * What goes in them is not invented. Everything below was measured against a
 * running Bridge and a real mailbox, and the numbers are kept in because a model
 * deciding whether to wait three seconds or twenty is better served by the
 * measurement than by the word "briefly".
 */

import type { McpServer } from '@modelcontextprotocol/server'

/**
 * Sent to every client at connection time.
 *
 * Deliberately short. Each line is here because a model got it wrong in
 * practice or would have: writing HTML into a plain text field, transliterating
 * umlauts away, checking a write immediately and reporting the intermediate
 * state as the outcome.
 */
export const INSTRUCTIONS = [
  'This server reads and writes a Proton Mail account through a local Proton Mail Bridge.',
  '',
  'Four things are worth knowing before the first call, because they are the ones that go',
  'wrong quietly:',
  '',
  '1. Nothing is sent without a person agreeing to it. Every sending tool asks first, through',
  '   the client, showing the final recipients. The first call never sends, and there is no',
  '   setting that turns the question off.',
  '2. A message body is either plain text or markup, never both. Markup written into the text',
  '   field arrives as visible tags. All text is UTF-8: write words the way the language',
  '   spells them rather than transliterating characters away.',
  '3. Writes need time to settle, and how much depends on what was written. Flags are',
  '   immediate; a move takes about fifteen seconds; a new message needs about twenty before',
  '   it appears in "All Mail". Checking straight after a write reports an intermediate state',
  '   as though it were the result.',
  '4. Nothing here deletes for good. "Delete" means moving to the trash.',
  '',
  'Everything about this server is seen and changed in a local page, and open_configuration',
  'returns its address. Hand that address over whenever it is asked for, in whatever words: it',
  'carries an access token, changes on every restart, and cannot be guessed or remembered.',
  '',
  'Two guides can be read when they are needed:',
  '  proton-mcp://guide/writing   composing messages, formatting, quoting, what the',
  '                               confirmation shows',
  '  proton-mcp://guide/bridge    how the Bridge behaves, with the measurements behind the',
  '                               numbers above',
].join('\n')

const WRITING_GUIDE = `# Writing messages with this server

## Text or markup, never both

Every tool that composes a message takes either \`text\` or \`html\`. Giving both is
refused rather than resolved by a preference, because Proton keeps the markup and
drops the plain text half of a message that carries both. Whichever one this
server chose to prefer, the other would silently never arrive.

Markup placed in the \`text\` field is not interpreted. It arrives as visible
characters and the recipient reads the tags.

## What markup you may write

Headings, paragraphs, line breaks, rules, quotes, emphasis, lists, tables, links
and images. Styling by colour, background, font, size, weight, alignment,
spacing and borders.

**Images work, and the usual way is a plain web address.** An \`<img>\` pointing
at \`https://…\` is permitted with no restrictions on where it comes from, at any
size, inside a link, with rounded corners. **An animated GIF is permitted too**,
and it is one of the few things that really does animate in a mail client, since
CSS animation does not survive most of them.

The one refusal is a \`data:\` address, which would carry an entire file inside
the markup where nothing lists it as an attachment.

What is *not* possible is attaching a file from this machine; see Attachments
below. That is a separate thing from showing an image, and confusing the two
leads to writing a plainer message than necessary.

Anything else is **refused, not quietly removed**, and the answer names what and
why. A message that was silently altered is no longer the message anyone agreed
to, so there is nothing to guess at: if a send is refused, the reason says which
element or property and what to use instead.

Two refusals are worth understanding rather than working around:

- **Properties that hide content** (\`display\`, \`visibility\`, \`opacity\`,
  \`position\`, a size of zero) are refused. They let a message be delivered
  looking different from how it was written.
- **Addresses** are limited to \`http\`, \`https\`, \`mailto\` and \`cid\`. A \`data:\`
  address would carry a whole file inside the markup, where nothing lists it as
  an attachment.

## What the person confirming is shown

Not only the body. Understanding this explains most of the rules above.

- The beginning of what you wrote, as it will read.
- **Every address in it, in full**, links and images alike, each with the text it
  is shown as. A link's visible text and its target are the same string in plain
  text and two different strings in markup, and that difference is the shape of
  every phishing message ever written.
- **Every piece of text a recipient can read that the body preview does not
  show.** An image's alt text is the clearest case: it never appears in the
  converted body, and mail clients block remote images by default, so it is
  frequently what the recipient actually reads.
- Every file carried with the message, with its size.

The agreement is bound to that exact message by a fingerprint covering the
sender, every recipient, the subject, the markup and the contents of each
carried file. Changing anything between the question and the answer means
nothing is sent. So compose the message you mean, then ask; do not ask and then
adjust.

## Replying and forwarding

The original is quoted below your part, with its formatting intact. You write
your own part and nothing else; the quote is assembled by this server from the
message being answered.

- Your part goes through the rules above.
- **The quote does not**, and could not: real mail is full of elements this
  server would never write itself, and holding a quote to that list would make
  replying to most messages impossible. It is kept as it was written, minus the
  elements that would reach out of the quote and restyle your text above it.
- The confirmation counts the quote rather than listing it. A quoted newsletter
  carries dozens of addresses that arrived in the recipient's mailbox already,
  and listing those would bury the ones you are answering for.

Replying as a **draft** and replying as a **send** differ in more than whether
anything leaves. Proton rewrites the thread headers of anything it stores, so a
reply written to a draft and sent later carries Proton's idea of the
conversation. A reply handed straight to SMTP keeps its \`In-Reply-To\` and stays
in the thread. If threading matters, use \`send_reply\` rather than
\`reply_draft\` followed by \`send_draft\`.

## Attachments

A message cannot be given a file from this machine. That is a decision that has
not been made rather than a feature that is missing: which paths a model may
reach is its own question.

**This does not stop a message from showing images.** An image at a web address
needs no attachment at all, and that is how almost every formatted message does
it. Only a file that would travel inside the message is unavailable.

\`cid:\` addresses are permitted and refer to a file the message already carries.
When composing a new message there is none, so a \`cid:\` reference has nothing
to point at. Where they do work is a forward: the original travels along whole,
attachments and embedded images included, so nothing is lost there.
`

const BRIDGE_GUIDE = `# How the Bridge behaves

Everything here was measured against a running Bridge rather than read in a
specification, and several of these contradict what the specification would
suggest.

## Waiting times differ by an order of magnitude

| Operation | Before it is visible |
| :--- | :--- |
| Setting a flag, read state or star | immediately, and unchanged twenty seconds later |
| A message appended to a mailbox | immediately in that mailbox |
| The same message in "All Mail" | about twenty seconds |
| A move between folders, settled | about fifteen seconds |
| SMTP accepting a message | about six and a half seconds |
| A sent message visible over IMAP | about three seconds after that |

During the settling time a move shows the message in **both** mailboxes. A check
run straight after a write therefore reports something that is not the outcome.
Wait, or simply report what was asked for.

## Folders and labels are different things

A message lives in exactly one folder and carries any number of labels.

- Applying a label leaves the message where it is. Removing one leaves the
  folder and the other labels untouched, and does not move anything to trash.
- **Moving a message into a label is not a move.** The label is applied and the
  message stays in its folder. \`move_messages\` refuses a label for that reason
  and points at \`add_label\`.
- Labels survive a move between folders.
- "All Mail" holds every message exactly once, including the ones in the trash.
  A listing of it does not say which folder a message is really in.

## Two commands that report success without doing anything

- **A copy into a mailbox that does not exist reports success and changes
  nothing.** No error, and the destination is not created either. Whether a
  label exists has to be established before the call, not after it.
- **A move out of "All Mail" does nothing**, and reports a refusal as a falsy
  return value rather than as an error. Moving needs the folder a message really
  sits in.

## Other measured behaviour

- **Proton fills the inbox through delivery, not through IMAP.** A message moved
  to "INBOX" was measured to end up elsewhere shortly afterwards.
- **A message with both a text and an HTML part arrives with only the HTML.**
- **Proton attaches its own public key to every message sent through the
  Bridge.** It is filtered out of every attachment list here, so a client showing
  three attachments where this server reports two is showing that key.
- **Proton rewrites the thread headers of anything it stores.** A draft appended
  with \`In-Reply-To\` and \`References\` comes back without the first and with the
  second replaced. A message handed to SMTP keeps them.
- **Searching is fast and local.** It runs against the Bridge's own database.
  Ordering a listing by date is the expensive part, because there is no
  server-side sort: it reads one date per message in the mailbox before a page
  can be cut, and the answer says so when it took a while.

## The trap behind all of these

Every one of the surprises above looked settled after a single measurement and
turned out differently on the second. A move looked like a copy because the
message was briefly in both places. A missing label looked like a successful
copy because the command said so. If something here is ever re-measured, it is
worth doing twice with a pause in between.
`

/**
 * Makes the guides readable.
 *
 * Registered as resources rather than folded into tool descriptions, because a
 * description is paid for on every listing whether it is needed or not, and
 * these are long by design.
 */
export function registerGuidance(server: McpServer): void {
  server.registerResource(
    'writing-guide',
    'proton-mcp://guide/writing',
    {
      title: 'Writing messages with this server',
      description:
        'Composing messages: text against markup, what markup is permitted and what is refused, ' +
        'what the person confirming a send is shown, how replies and forwards quote the original, ' +
        'and why replying as a draft and replying as a send are not the same thing.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: WRITING_GUIDE, mimeType: 'text/markdown' }] }),
  )

  server.registerResource(
    'bridge-guide',
    'proton-mcp://guide/bridge',
    {
      title: 'How the Proton Mail Bridge behaves',
      description:
        'Measured behaviour of the Bridge: how long each kind of write takes to settle, how ' +
        'folders and labels differ, and the two commands that report success without having done ' +
        'anything.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: BRIDGE_GUIDE, mimeType: 'text/markdown' }] }),
  )
}
