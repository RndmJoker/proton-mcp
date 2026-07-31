# proton-mcp

An MCP server for Proton Mail. It talks to a locally running Proton Mail Bridge and makes your mailbox available to AI assistants such as Claude.

**Status: under construction.** Reading works and can be used, and so does signing in through the browser. Labels, moving between folders, read state, trash, drafts and sending all work. Every send asks you first, and that question is enforced by the server rather than requested in a prompt. See [Status](#status) for the details.

## Why everything runs locally

Proton Mail Bridge only listens on `127.0.0.1`. It cannot be reached from outside, and that is by design: your messages are decrypted on your own machine.

This server therefore runs on your machine as well, started by the AI client as a child process. Your mail leaves your machine only as far as you show content to the assistant yourself. There is no remote access and no service in between.

## Status

### What works

| Tool | What it does |
| :--- | :--- |
| `list_folders` | Lists folders and labels, grouped by kind |
| `list_messages` | Headers of a mailbox, newest first, with paging |
| `search_messages` | Full text, subject, sender, recipient, date range, read state, star, size |
| `get_message` | One message as readable text, HTML converted, budgeted |
| `get_attachment` | One attachment by index, textual types only |
| `add_label` | Applies an existing label. The message stays in its folder |
| `remove_label` | Removes a label. Folder, other labels and the message itself are untouched |
| `move_messages` | Moves messages into a folder. Labels survive the move |
| `set_flags` | Marks read or unread and sets or clears the star |
| `trash_messages` | Moves messages to the trash, which is what deletion means here |
| `create_draft` | Writes a draft. Nothing is sent |
| `update_draft` | Replaces a draft, keeping its id |
| `reply_draft` | Prepares a reply as a draft, with the original quoted |
| `forward_draft` | Prepares a forward as a draft, attachments and all |
| `list_drafts` | The drafts, newest first |
| `send_message` | Composes and sends. Asks you first, always |
| `send_reply` | Replies and sends, keeping the conversation intact |
| `send_forward` | Forwards and sends, attachments and all |
| `send_draft` | Sends a draft that is already written |

Every tool that composes a message takes either `text` or `html`, never both: Proton drops the plain text half of a message that carries markup, so the half you confirmed would be the half that never arrived.

The server also tells an assistant how it works, so the rules are not something a model has to infer from failures. A short text travels with every connection naming the four things that go wrong quietly, and two longer guides can be read on demand: `proton-mcp://guide/writing` for composing messages and `proton-mcp://guide/bridge` for the measured behaviour of the Bridge itself.

Underneath: a held IMAP connection that recovers from a Bridge restart, stable identifiers based on the Message-ID, HTML to text conversion, filtering of the public key Proton attaches to every sent message, and a character budget so a single message cannot exhaust a context window.

There is also a **local web interface**, on `127.0.0.1` only, running for as long as the server does. It is divided into sections, reached from a rail on the left:

| Section | What is there |
| :--- | :--- |
| Overview | Connection, address, where the password is kept, read-only mode, both Bridge ports, uptime and counters. State only: every control lives in the section it acts on |
| Folders and labels | On its own page, only when asked. They belong to the whole account, so a folder named after a bank gives that away on its own |
| Bridge | The ports, the pinned certificate, and a button that tries the connection. Ports are stored in `~/.config/proton-mcp/settings.json`; an explicit environment variable wins and the form disappears |
| Credentials | Where the Bridge password is kept, and signing out, which clears it from every store at once |
| Activity | What is running and for how long, plus the last 50 finished calls. Tool names and timings only, never arguments |

Before signing in there are two more: the sign-in form, where the address and Bridge password go into the browser rather than into a client configuration or a conversation, with four places to keep the password and the cost of each stated; and the unlock page, which after a restart asks for the master password alone, since the Bridge password is already on disk.

**None of it uses JavaScript.** The Content-Security-Policy forbids it, so navigation is links and anything interactive is a form control. It follows the system light or dark setting, which needs no script either.

When a tool is called before anyone has signed in, the server does not ask for the password in the conversation. It returns the address of that page, and on clients that support URL elicitation it asks the client to open it directly.

### What does not exist yet

This table says what the server cannot do today. The issue behind each entry says what is planned and how far it has got.

| Missing | Tracked in |
| :--- | :--- |
| Attachments composed from files on this machine | [#17](https://github.com/RndmJoker/proton-mcp/issues/17) |
| Publication on npm, so installation via `npx` | [#7](https://github.com/RndmJoker/proton-mcp/issues/7) |
| A single prompt that sets a client up on its own | [#8](https://github.com/RndmJoker/proton-mcp/issues/8) |

**Binary attachments** are missing from that table on purpose. They are not an unfinished feature waiting for its turn: `get_attachment` refuses anything that is not text and says why. Handing one over would mean either base64 in the context window, which is unusable, or writing decrypted content to your disk, which this server does not do. Changing that needs a decision first, not an implementation, so there is nothing to track yet.

### What will never exist

These limits come from the Bridge itself and cannot be worked around:

- **No calendar, no contacts.** Neither flows through the Bridge.
- **No Proton-specific features.** No message expiration, no password-protected messages to outside recipients.
- **No access to filters, forwarding rules or account settings.** This is also a deliberate security boundary, see below.
- **No server-side threading or sorting.** The Bridge supports neither `THREAD` nor `SORT`, so ordering happens in this server, which costs one date read per message before a page can be cut out.
- **No permanent deletion.** Deleted will mean moved to trash, on purpose.

## Requirements

- **A paid Proton plan.** The Bridge is not included in the free tier.
- **Proton Mail Bridge**, installed, running and unlocked. The official application expects a desktop. On a machine without one, [proton-mail-bridge-docker](https://github.com/RndmJoker/proton-mail-bridge-docker) runs it in a container instead. That is a way to get a bridge, not a way to put one somewhere else: it decrypts your mail wherever it runs, so a bridge on another machine means your mail is decrypted on that machine. The section above still applies, and the container's own readme says the same.
- **Node.js 24 or newer.**
- **The Bridge password**, which is not your Proton account password. The Bridge generates one per account. You find it in the Bridge application under the account, or in a terminal via `protonmail-bridge --cli` and then `info`.

## Installing from this repository

There is no published package on npm yet, so the server is built from source. A setup script does the work on either platform.

### Linux and macOS

```bash
git clone https://github.com/RndmJoker/proton-mcp.git
cd proton-mcp
./scripts/setup.sh
```

### Windows

```powershell
git clone https://github.com/RndmJoker/proton-mcp.git
cd proton-mcp
.\scripts\setup.ps1
```

The script checks that Node.js is new enough, installs the dependencies, builds the server, runs the tests, and creates the credentials file with placeholders if it does not exist yet. It prints the exact line to register the server with your client. It never touches an existing credentials file.

### Updating

Same script, one flag:

```bash
./scripts/setup.sh --update          # Linux and macOS
```

```powershell
.\scripts\setup.ps1 -Update          # Windows
```

That pulls the latest commits, then installs, builds and tests again. If you have uncommitted changes in the working copy, the script stops instead of discarding them.

### Signing in

**Nothing needs to be entered before the first start.** Register the server with your client, then ask the assistant anything about your mail. It will answer with a `127.0.0.1` address, or open it for you if your client supports that. Sign in there, in your browser, and repeat the request.

The page asks for two things: your Proton address and the **Bridge password**, which is the one the Bridge generates and not your Proton account password.

Then it asks where the password should be kept. All four options are supported and none is a fallback; what differs is the drawback you accept:

| Option | On disk | You type something | Suits |
| :--- | :--- | :--- | :--- |
| **System keyring** | Protected by the operating system | Rarely | A desktop machine you use yourself. The ordinary case, and the default when it works |
| **Encrypted file** | Encrypted with your master password | Every server start | Servers, containers, headless machines. The only option that behaves the same everywhere |
| **This session only** | Nothing | Every server start | A shared machine, or a one-off look |
| **Plain file** | Unencrypted, readable by your account | Never | Automation, where nobody can type a password |

The interface probes the keyring at runtime rather than guessing from the operating system, because the same Linux with and without a graphical session is a different machine as far as a keyring is concerned. An option that cannot work is shown greyed out with the actual reason.

If you pick the encrypted file, every later start shows an unlock page asking for that master password alone. Forget it and nothing anywhere can recover the file; the page offers to throw it away so you can sign in afresh.

#### Without a browser

Environment variables still work and take precedence over anything stored:

```
BRIDGE_USER=your.address@example.com
BRIDGE_PASS=the-password-the-bridge-generated
```

Put them in `~/.config/proton-mcp/env` (on Windows `%USERPROFILE%\.config\proton-mcp\env`), which the setup script creates with placeholders and which **the server reads itself**. Do not put them in your AI client's configuration, where they would sit in plain text and be read on every start. The file is created readable only by you, and the server warns on startup if that stops being true.

All variables are documented in `.env.example`.

### Registering it with a client

**Claude Code:**

```bash
claude mcp add proton -- node /absolute/path/to/proton-mcp/dist/server.js
```

**Any client that reads a JSON configuration** (Claude Desktop, Cursor and others):

```json
{
  "mcpServers": {
    "proton": {
      "command": "node",
      "args": ["/absolute/path/to/proton-mcp/dist/server.js"]
    }
  }
}
```

Use an absolute path; `~` is not expanded by every client. The setup script prints the correct line for your machine.

### Checking that it works

Without any client, by speaking the protocol directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_folders","arguments":{"kind":"system"}}}' \
  | node dist/server.js
```

You should see your system mailboxes. If instead you get a message saying the Bridge is probably not running, start and unlock the Bridge and try again. The server explains what to do in its error messages rather than printing error codes.

## Security

The content of someone else's email is text written by strangers, and it is handed to a language model that can call tools. A crafted message may try to instruct the assistant. This server assumes that will happen:

- **Message content is marked as untrusted** in every answer, enclosed in explicit markers and separated from anything the server itself says.
- **Nothing is filtered out of the content** and no attempt is made to detect attacks. Such filters pretend to offer safety they cannot deliver.
- **Sending will always require your confirmation**, enforced in the server rather than in a system prompt. There will be no switch to turn it off. Until sending exists at all, there is nothing to confirm.
- **There will be no permanent deletion**, and no tools for filters, forwarding, account or key settings. A hijacked session must not be able to leave behind lasting access.
- **HTML is never passed through raw** and external content is never fetched. Tracking pixels stay ineffective.
- **No message ever touches your disk.** No cache, no index, no copies. Anything this server wrote down would be your mail in plain text, outside the encryption you pay Proton for.

### Writing to your mailbox

Every tool that changes something is bounded on purpose:

- **`PROTON_MCP_READ_ONLY=true` refuses every write**, and the interface reports the mode it is in. Reading keeps working.
- **Nothing is ever deleted for good.** `trash_messages` moves messages to the trash, where Proton keeps them and where `move_messages` can take them back out. There is no tool that empties the trash.
- **Removing a label is an expunge inside the label's own mailbox.** The same command aimed at a folder would delete mail, so the code refuses any path outside `Labels/`, checked again in the line immediately before the expunge. A label name containing a path separator is rejected rather than repaired.
- **Labels are never created**, only applied. Create them in Proton itself.
- **A label is not a destination for `move_messages`.** Moving a message into a label was measured to apply the label and leave the message where it is, so the tool refuses it instead of reporting a move that did not happen.
- **A batch touches at most 50 messages**, and every one of them is accounted for in the answer, including the ones that failed and why.

**A draft is the safe default.** The assistant prepares, you decide.

**Messages can be plain text or formatted.** A formatted one may use headings, paragraphs, emphasis, lists, tables, links and images, with colour, font, alignment, spacing and borders. Anything outside that set is refused with a reason rather than quietly removed, because a message that was silently altered is no longer the message anyone agreed to.

Formatting changes what a confirmation has to show, and that is the interesting part. In plain text a link's visible text and its target are the same string, so showing you the body shows you everything. In markup they are two strings, which is the shape of every phishing mail ever written. So the confirmation for a formatted message adds two blocks that are never shortened:

- **Every address in the message**, links and images alike, each with the text it is shown as.
- **Text a recipient can read that the body preview does not show.** Measured: an image's alt text never appears in the converted body, and mail clients block remote images by default, so the alt text is frequently what the recipient actually reads. That was a way past the confirmation, and it is closed.

The set of permitted markup leaves out `style`, `script`, `noscript`, `textarea` and `head` by not listing them. Those are the elements whose content the preview and a mail client disagree about, and a list of what is allowed refuses them without anyone having had to think of them first. Attachments from files on this machine are deliberately not supported: a path named by a model, read by the server and carried out by the next confirmation is not a feature, it is a way out for anything on your disk. Forwarding loses nothing all the same, because the original message travels along whole.

One thing worth knowing about drafts: Proton rewrites the thread headers of anything it stores. A reply is built with `In-Reply-To` and `References`, and what comes back has neither, only Proton's own internal thread id. Threading a stored draft is therefore Proton's business rather than this server's.

Writes need a moment to settle. A move takes roughly fifteen seconds to reconcile with Proton, and until then the Bridge lists the message in both places, so the tools say so rather than reading back an intermediate state and calling it the result. Flags are the exception: those hold immediately.

### Sending, and the question you cannot switch off

Mail is text written by strangers, handed to a model that can call tools. A message can politely ask to be forwarded somewhere, and other projects answer that with a line in a system prompt. **A system prompt is not a security boundary.** This one lives in the server:

- **Nothing is sent without a person saying yes.** The first call never sends. It returns a question through your client showing the final recipients separated into To, Cc and Bcc, the subject, and the first lines. Only the second call, carrying your answer, sends.
- **There is no setting that turns the question off.** Not an environment variable, not an argument, not a mode.
- **A client that cannot ask cannot send.** If your client does not support form elicitation, sending is refused and you are pointed at drafts instead. That is deliberately different from the sign-in prompt, which falls back to text: the worst outcome there is an inconvenience, and here it is a message that cannot be recalled. What counts as "can ask" is the capability your client declares, read from the request when the protocol revision carries it there and from the handshake otherwise.
- **Your yes covers one specific message.** A fingerprint of the sender, every recipient, the subject and the body is sealed with an HMAC whose key exists only in the running process, and it travels with the question. On the way back the fingerprint is recomputed from what is being asked for now. If a single address was added in between, nothing is sent. A confirmation is also bound to the tool that asked, so one cannot be reused for another.
- **Blind copies stay blind.** They travel in the envelope and never appear in the headers the recipients see. Verified against a real delivery.
- **The Bridge password is protected on the way out too.** SMTP is verified against the same pinned certificate as IMAP, and STARTTLS is required rather than merely attempted.

Replying and forwarding exist as sending tools of their own, not just as drafts. The reason is measured: Proton rewrites the thread headers of anything it stores, so a reply written to a draft and sent later loses the chain, while a reply handed straight to SMTP keeps its `In-Reply-To` and stays in the conversation.

After a send, nothing checks its own work. The Bridge took about six and a half seconds to accept a message and the message appeared over IMAP about three seconds after that, so an immediate look would describe a state that is not the outcome.

### What lands on your disk

Only these, all under `~/.config/proton-mcp/` (on Windows `%USERPROFILE%\.config\proton-mcp\`) and all written readable by your account alone:

| File | When | What is in it |
| :--- | :--- | :--- |
| `known-certificate.json` | On the first connection | The Bridge's certificate and its fingerprint |
| `settings.json` | When you change the ports in the interface | Two port numbers |
| `credentials.enc` | Only if you chose the encrypted file | Your Bridge password, encrypted with your master password |
| `env` | Only if you put it there yourself | Your Bridge password in plain text |

Choosing the system keyring puts the password where the operating system keeps your other passwords, and nothing of it in a file. Choosing "this session only" writes nothing at all.

**No mail, no subjects, no sender addresses, no folder names, no search terms.** The activity list in the interface records tool names and timings, in memory only, and is gone when the server stops.

### The web interface

It binds to `127.0.0.1` and there is no option to change that. It is not remote access and cannot be made into it. Four defences, each against a specific attack:

- **A token in the URL**, generated per process and never written down. Any other program on your machine can reach `127.0.0.1`; without the token it can do nothing here.
- **A Host header check.** A page on the internet can point its own domain at `127.0.0.1` and have your browser send requests there, which the browser then treats as same-origin with that domain. Only loopback names are accepted. This is DNS rebinding, and it is the attack local servers most often forget.
- **An Origin check and a per-action CSRF token** on everything that changes something, so a token for one action cannot be replayed against another.
- **A strict Content-Security-Policy.** Nothing may be loaded from anywhere and nothing can reach the network. The interface also serves no files from disk at all, which removes path traversal as a category rather than guarding against it.

It shows no message content, by design. It is for configuration and state, not a mail client.

### What you actually expose

In Proton, folders and labels belong to the **account**, not to an individual address. If you connect the server using a secondary address, the **complete folder structure of your account** is still visible, even though the messages inside belong to the other address and stay hidden.

The names alone say something. A folder `Banking/Revolut` reveals your bank, `Tax` your dealings with the tax office, a company name your employer. Separating both content **and** structure requires a separate Proton account, not just a second address.

### The Bridge certificate

The Bridge generates its own certificate and keeps it inside its encrypted vault rather than on disk, so it cannot be trusted in advance. Switching verification off would mean anything that manages to listen on the port gets your Bridge password.

Instead the certificate is **pinned on first use**. The first connection records its fingerprint in `~/.config/proton-mcp/known-certificate.json` and reports it on stderr. The web interface shows it too, along with the date it was recorded. Every connection after that is verified against that one certificate, which is stricter than the public trust store: a certificate signed by a recognised authority would not do.

If the certificate ever changes, the server refuses to connect and says so:

```
The certificate of the Bridge at 127.0.0.1:1143 has changed. Refusing to connect.

  expected: 93:87:F5:3D:...
  received: 11:22:33:44:...
```

Reinstalled the Bridge or moved machines? Then delete the file and the next connection records the new certificate. Changed nothing? Then do not delete it, because something else may be listening on that port.

The one moment this cannot protect you is the very first connection, which is what trust on first use means. If that matters to you, compare the fingerprint the server prints against the certificate the Bridge shows.

## Development

| Area | Choice |
| :--- | :--- |
| Language | TypeScript, Node.js 24 or newer |
| MCP | `@modelcontextprotocol/server` v2, specification 2026-07-28 |
| IMAP | `imapflow` |
| MIME | `mailparser`, `html-to-text` |
| SMTP | `nodemailer`, for sending once it exists |
| Schemas | `zod` |
| Tests | Vitest, `node` environment |

Every dependency is MIT or MIT-0, except `deepmerge-ts` which is BSD-3-Clause. All permissive.

```bash
npm run build         # compile into dist/
npm test              # run the tests once
npm run test:watch    # run the tests in watch mode
npm run test:coverage # with coverage report
npm run typecheck     # type check only, no output
```

The tests run without a Bridge, so they work in CI. Real credentials and real mail content have no place in test files.

### Layout

```
src/
├── bridge/       connection handling, certificate pinning, error translation
├── credentials/  the four places a password can be kept, and the runtime probe
├── mail/         listing, reading, searching, identifiers, attachments
├── mime/         parsing, HTML to text, budgeting
├── tools/        the MCP tools and their output formatting
├── web/          the local interface and its security layer
├── activity.ts   what is running and what ran, in memory only
├── session.ts    whether we are signed in, and where from
├── settings.ts   the Bridge ports, when changed in the interface
└── server.ts     entry point and transport
```

The web interface has one property worth knowing before touching it: `Referrer-Policy` must not be `no-referrer`. Under that policy browsers send `Origin: null`, which the CSRF defence rightly refuses, and the interface then refuses its own forms. The tests set the Origin header themselves and cannot catch it. There is a comment in `src/web/security.ts` and a test asserting the cause.

### Checks before a pull request

The CI in `.github/workflows/ci.yml` runs the tests, the type check, the build, an audit of the dependencies and a scan for accidentally committed secrets. All of it runs locally too:

```bash
npm test
npx tsc --noEmit
npm run build
npm audit --omit=dev
```

### Measured behaviour of the Bridge

Some of what this server does looks odd until you know what the Bridge actually does, as opposed to what a standard IMAP server would do. The comments in `src/bridge/`, `src/mail/` and `src/mime/` name the measurement behind each decision. The three that surprise people most:

- `FETCH 1:*` on an empty mailbox is answered with `BAD no such message` instead of an empty result, so a message count has to be checked first.
- UIDs are per mailbox and change when a message is moved. The Message-ID is the only stable handle.
- A median message costs roughly 16000 tokens in its raw form and a fraction of that as text, which is why nothing raw is ever passed through.

Worth reading before changing anything in those directories.

## License

MIT
