# proton-mcp

An MCP server for Proton Mail. It talks to a locally running Proton Mail Bridge and makes your mailbox available to AI assistants such as Claude.

> **Unofficial.** proton-mcp is not made by, affiliated with or endorsed by Proton AG. "Proton" and "Proton Mail" are their trademarks.
>
> **Largely AI-generated.** Most of the code, tests and documentation in this repository were written by Anthropic's Claude Opus models. I decide what gets built and how, and I note this on every one of my projects that is largely AI-generated.

**Status: under construction.** Reading works and can be used, and so does signing in through the browser. Labels, moving between folders, read state, trash, drafts and sending all work. By default every send asks you first, and that question is enforced by the server rather than requested in a prompt; you can allow a tool to act on its own, within bounds you choose. See [Status](#status) for the details.

## Why everything runs locally

Proton Mail Bridge only listens on `127.0.0.1`. It cannot be reached from outside, and that is by design: your messages are decrypted on your own machine.

This server therefore runs on your machine as well, started by the AI client as a child process. Your mail leaves your machine only as far as you show content to the assistant yourself. There is no remote access and no service in between.

## Status

### What works

| Tool | What it does |
| :--- | :--- |
| `list_folders` | Lists folders and labels, grouped by kind |
| `list_messages` | Headers of a mailbox, newest first, with paging. In "All Mail" the discarded ones are marked as such |
| `search_messages` | Full text, subject, sender, recipient, date range, read state, star, size. Dates are the sender's, matching what the results show. Subject, sender and recipient match umlauts and spaces as written. Full text cannot reach attachments or parts sent as base64, and the answer says so |
| `get_message` | One message as readable text, HTML converted, budgeted |
| `get_attachment` | One attachment by index, textual types only |
| `save_attachment` | Saves one attachment as a file into the directory you set in `PROTON_MCP_ATTACHMENT_DIR`, so the assistant can open it. Deleted again after an hour and when the server stops, see [Saved attachments](#saved-attachments) |
| `delete_saved_attachments` | Deletes files `save_attachment` wrote, all of them or the ones named, and nothing else |
| `add_label` | Applies an existing label. The message stays in its folder |
| `remove_label` | Removes a label. Folder, other labels and the message itself are untouched |
| `move_messages` | Moves messages into a folder. Labels survive the move |
| `set_flags` | Marks read or unread and sets or clears the star |
| `trash_messages` | Moves messages to the trash, which is what deletion means here |
| `create_draft` | Writes a draft. Nothing is sent |
| `update_draft` | Replaces a draft, keeping its id and the files stored with it |
| `reply_draft` | Prepares a reply as a draft, with the original quoted |
| `forward_draft` | Prepares a forward as a draft, attachments and all |
| `list_drafts` | The drafts, newest first |
| `send_message` | Composes and sends. Asks you first unless you chose otherwise, see [What the assistant may do](#what-the-assistant-may-do) |
| `send_reply` | Replies and sends, keeping the conversation intact |
| `send_forward` | Forwards and sends, attachments and all |
| `send_draft` | Sends a draft that is already written, exactly as it was stored |
| `open_configuration` | Hands back the address of the local web interface, the same for every running server |
| `check_for_updates` | Asks npm whether a newer version exists. The only thing here that contacts anything but your own machine, and only when called |
| `list_filters` | The names of your Proton Mail filters in the order Proton runs them, read through the browser extension [Proton MCP Helper](#the-browser-extension-for-filters). Also what waits in the extension and its last changes |
| `get_filters` | One or several filters in full: what each does to matching mail and its whole Sieve script |
| `propose_filter` | A new filter, or a new version of one, as a Sieve script. You agree in a window of the extension, which shows the whole script and, for a change, what changes |
| `apply_filter` | Runs a saved filter over the mail already there, after you agree in the same kind of window. On a large mailbox Proton takes hours for that |
| `reorder_filters` | Moves filters in the order Proton runs them, after you agree to the new order |
| `delete_filter` | Deletes a filter for good, after you agree. Off until you switch it on. The answer keeps the whole script, so the filter can be set up again |
| `set_filter_status` | Switches a filter on or off, after you agree. Off until you switch it on |
| `manage_filters` | Reads and changes nothing. Explains the way through Proton's own settings page, for when the extension is not there |

Every tool that composes a message takes either `text` or `html`, never both: Proton drops the plain text half of a message that carries markup, so the half you confirmed would be the half that never arrived.

They also take a `markupLevel`. At **`standard`**, the default, a message may use colour, background, font, alignment, spacing, borders and size, plus links, images, tables and lists; anything else is refused with a reason rather than quietly removed. At **`extended`** every CSS property is permitted, including ones that can put content out of sight. Nothing is refused there for being a style: what was used is reported instead, the confirmation carries a warning telling you to open the preview, and the preview names every property, its value and the element it sat on. A proper button needs `extended`, because a link cannot fill its own padding without `display: inline-block`.

The server also tells an assistant how it works, so the rules are not something a model has to infer from failures. A short text travels with every connection naming the four things that go wrong quietly, and two longer guides can be read on demand: `proton-mcp://guide/writing` for composing messages and `proton-mcp://guide/bridge` for the measured behaviour of the Bridge itself.

Underneath: a held IMAP connection that recovers from a Bridge restart, stable identifiers based on the Message-ID, HTML to text conversion, filtering of the public key Proton attaches to every sent message, and a character budget so a single message cannot exhaust a context window.

There is also a **local web interface**, on `127.0.0.1` only, at one fixed address: `http://127.0.0.1:7345/` unless `PROTON_MCP_WEB_PORT` says otherwise. Every assistant session starts its own server, and all of them share this one interface and its settings: the first one to start serves it, and when that one stops, the next takes over. Right after an update, a server from before 0.5.0 may still run in a session started earlier and hold that address with an interface of its own; the shared one appears as soon as that session ends, and at once if you restart it. It is divided into sections, reached from a rail on the left:

| Section | What is there |
| :--- | :--- |
| Overview | Connection, address, where the password is kept, read-only mode, both Bridge ports, whether changes need a PIN, uptime and counters, and every running server with its sign-in. State only: every control lives in the section it acts on |
| Folders and labels | On its own page, only when asked. They belong to the whole account, so a folder named after a bank gives that away on its own |
| Bridge | The ports, the pinned certificate, and a button that tries the connection. Ports are stored in `~/.config/proton-mcp/settings.json`; an explicit environment variable wins and the form disappears |
| Credentials | Where the Bridge password is kept, and signing out, which clears it from every store at once and signs out every running server |
| Permissions | What each tool may do, the bounds on sending without asking, a copy of everything sent, and the PIN that every change in this interface asks for once you set one |
| Activity | What is running and for how long, plus the last 50 finished calls. Tool names and timings only, never arguments |

One more page appears only while a message is waiting for you to confirm it, linked from that question: the message rendered as the recipient will see it, every address in full, every alt text, every attachment. It is the one place that shows mail, and it carries no confirm button by design. It is served by the server that asked, on a port of its own, because the message is held in that server's memory and nowhere else.

Before signing in there are two more: the sign-in form, where the address and Bridge password go into the browser rather than into a client configuration or a conversation, with four places to keep the password and the cost of each stated; and the unlock page, which after a restart asks for the master password alone, since the Bridge password is already on disk.

**None of it uses JavaScript.** The Content-Security-Policy forbids it, so navigation is links and anything interactive is a form control. It follows the system light or dark setting, which needs no script either.

When a tool is called before anyone has signed in, the server does not ask for the password in the conversation. It returns the address of that page, and on clients that support URL elicitation it asks the client to open it directly.

### What does not exist yet

This table says what the server cannot do today. The issue behind each entry says what is planned and how far it has got.

| Missing | Tracked in |
| :--- | :--- |
| Attachments composed from files on this machine | [#17](https://github.com/RndmJoker/proton-mcp/issues/17) |
| Choosing in the interface how much markup a message may carry. The levels exist and a caller picks one per message; what is missing is a ceiling the caller cannot raise | [#24](https://github.com/RndmJoker/proton-mcp/issues/24) |

**Binary attachments** are not returned as text: base64 in the context window would be unusable. `save_attachment` writes one to a directory you name instead, and it is off until you name one, see [Saved attachments](#saved-attachments).

### What will never exist

These limits come from the Bridge itself and cannot be worked around:

- **No calendar, no contacts.** Neither flows through the Bridge.
- **No Proton-specific features.** No message expiration, no password-protected messages to outside recipients.
- **No forwarding rules and no account settings.** This is also a deliberate security boundary, see below. Filters are within reach through the [browser extension](#filters-through-the-browser-extension), and what a filter may do beyond filing and flags, and deleting or switching one, is yours to allow. Forwarding stays out: Proton does not run it in filters, and its own forwarding setting is out of reach of these tools.
- **No server-side threading or sorting.** The Bridge supports neither `THREAD` nor `SORT`, so ordering happens in this server, which costs one date read per message before a page can be cut out.
- **No permanent deletion.** Deleted will mean moved to trash, on purpose.

## Requirements

- **A paid Proton plan.** The Bridge is not included in the free tier.
- **Proton Mail Bridge**, installed, running and unlocked. Tried against versions 3.25.0 and 3.27.1. The official application expects a desktop. On a machine without one, [proton-mail-bridge-docker](https://github.com/RndmJoker/proton-mail-bridge-docker) runs it in a container instead. That is a way to get a bridge, not a way to put one somewhere else: it decrypts your mail wherever it runs, so a bridge on another machine means your mail is decrypted on that machine. The section above still applies, and the container's own readme says the same.
- **Node.js 24 or newer.**
- **The Bridge password**, which is not your Proton account password. The Bridge generates one per account. You find it in the Bridge application under the account, or in a terminal via `protonmail-bridge --cli` and then `info`.

## Installing

Filters additionally need the browser extension, which for now is installed by hand, see [The browser extension for filters](#the-browser-extension-for-filters).

### Hand it to your assistant

If you already have an AI assistant with a shell, the shortest route is to let it do the work:

```
Fetch https://raw.githubusercontent.com/RndmJoker/proton-mcp/main/prompt.md and follow it
```

It checks the prerequisites, registers the server with your client and tells you what to do next. **It never asks for your Bridge password** and cannot: that goes into the local web interface, in your browser, and nowhere else.

You can also just ask your assistant whether there is an update: the server has a `check_for_updates` tool that asks npm and reports what to do. It is the one thing in here that contacts anything other than your own machine, it runs only when called, it sends nothing about you, and it installs nothing.

Or hand over the guide, the same way as for the installation:

```
Fetch https://raw.githubusercontent.com/RndmJoker/proton-mcp/main/update.md and follow it
```

It works out how you installed it, since the three ways look identical from the outside and are updated differently, and it reminds you that the client has to be restarted. Nothing has to be set up again: credentials, the pinned certificate and the ports all survive. The browser extension, where you installed it, is the exception and is replaced by hand, see [Updating it](#the-browser-extension-for-filters).

### From npm

```bash
npx @rndmjoker/proton-mcp
```

That is also the command to register with your client, so nothing has to be installed permanently. The published package carries provenance, so npm can show which commit and which workflow built it.

To register it with Claude Code:

```bash
claude mcp add proton-mcp -- npx -y @rndmjoker/proton-mcp
```

For Claude Desktop, Cursor and anything else that reads a JSON file:

```json
{
  "mcpServers": {
    "proton-mcp": {
      "command": "npx",
      "args": ["-y", "@rndmjoker/proton-mcp"]
    }
  }
}
```

Nothing else belongs in that entry. Credentials are not passed here, see [Signing in](#signing-in).

### From this repository

To run the current development state, or to change something. A setup script does the work on either platform.

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

On Linux the system keyring is the desktop's, GNOME Keyring or KWallet, reached over D-Bus. MCP clients usually start a server without the address of that bus, so the server looks for it in the usual place itself. Where there is no desktop session, on a server or in a container, the keyring library uses the kernel's keyring instead. That one keeps the password in memory only: it is gone after a restart, and after three days without use by default. The sign-in page says so when that is the case.

If you pick the encrypted file, every later start shows an unlock page asking for that master password alone. Forget it and nothing anywhere can recover the file; the page offers to throw it away so you can sign in afresh.

**Signing in again replaces what was stored.** The password then lives only where you chose last, and every other place is emptied. **Signing out empties all four.** If one of them cannot be emptied, a file the server may not delete for instance, the page says which and how to remove it by hand, because until then the next start signs in with it again.

**With several sessions running**, a password kept in the system keyring or in a file reaches every one of their servers, which reread it whenever you sign in or out. One kept for this session only, or in an encrypted file opened in the interface, stays with the server that shows the interface, because it lives in that server's memory alone. The overview lists every running server with its sign-in, so this is visible rather than puzzling. A server left out says so when a tool needs the sign-in, and names the two ways out: sign in again with the password kept where every server reads it, or end the session whose server shows the interface, so that the next one shows it and asks for what it needs.

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
{
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_folders","arguments":{"kind":"system"}}}'
  sleep 5
} | node dist/server.js
```

The `sleep` keeps the input open while the answer is on its way. A client signals that it is leaving by closing the server's input, and from that moment no further answer is written, so a plain `printf ... |` only ever gets the reply to `initialize`.

You should see your system mailboxes. If instead you get a message saying the Bridge is probably not running, start and unlock the Bridge and try again. The server explains what to do in its error messages rather than printing error codes.

### The browser extension for filters

Optional. Proton keeps filters behind an interface it has not opened to other programs, and the Bridge does not carry them. The extension **Proton MCP Helper** does the work inside the Proton page you are signed in to in Chrome, and a small connector program, which Chrome starts for it, carries the requests between this server and the extension. This server never holds a Proton session or password for it.

**For now it is installed by hand.** It is not in the Chrome Web Store. Every [release](https://github.com/RndmJoker/proton-mcp/releases) carries it as `proton-mcp-helper-<version>-chrome.zip`. Take the one of the release that matches your server, which for `npx -y @rndmjoker/proton-mcp@latest` is the latest.

1. Set up the connector, once per computer:

   ```bash
   npx -y @rndmjoker/proton-mcp@latest setup-browser
   ```

   It writes a secret only you can read, a copy of the connector and a launcher under `~/.config/proton-mcp/browser/`, and the file that tells Chrome which program the extension may start. It prints what it wrote. Run it again after Node moved, for example to another version under another path.
2. Download the zip from the release and unpack it into a folder of its own, somewhere it can stay. Chrome loads the extension from that folder every time it starts, so moving or deleting the folder removes the extension.
3. Open `chrome://extensions`, switch on Developer mode, choose **Load unpacked** and pick that folder. Its card has to show the id `nfmconelbflppeoolebhcckbmffiokkd`, the only one the connector lets in.
4. Reload any open Proton tab once, or open `https://mail.proton.me` and sign in.

The extension's popup says whether the connector runs and what waits; when it does not run, it says why. It also holds the extension's own switches for saving, applying, moving, deleting and switching filters without its window, and what a filter may do beyond filing and flags, all off by default, see [Filters, through the browser extension](#filters-through-the-browser-extension). When the extension cannot be reached, the filter tools say so as well, with the cause where it can be told: no setup, Chrome not running, the extension missing or switched off. To take the connector away again, run the same command with `--remove`, and remove the extension in `chrome://extensions`.

**Updating it.** Chrome never updates an extension loaded by hand, and the connector stays the copy `setup-browser` made. So after the server was updated:

1. Run `setup-browser` again, as above. The secret stays, the copy of the connector is replaced.
2. Download the zip of the new release, empty the folder Chrome loads the extension from, and unpack the zip into it.
3. In `chrome://extensions`, click the reload arrow on the extension's card, then reload the Proton tab.

When the connector no longer fits the server, the filter tools say so, with these steps.

**The code.** The source of the extension is in [`extension/`](extension/) in this repository, and its [readme](extension/README.md) says how to build it yourself. The zip attached to a release is built from that release's tagged commit, and GitHub attaches the source of the whole repository to every release as well.

Chrome first. Measured on Linux; the setup for macOS and Windows is written but not measured yet. One Chrome profile at a time can serve the server.

## Security

The content of someone else's email is text written by strangers, and it is handed to a language model that can call tools. A crafted message may try to instruct the assistant. This server assumes that will happen:

- **Message content is marked as untrusted** in every answer, enclosed in markers and separated from anything the server itself says. The markers carry a label drawn per answer, because a fixed one is written down in this repository: a sender could put the closing marker in the body and have everything after it read as though the server wrote it. A label that changes every time cannot be copied. For the same reason a subject, a display name or an attachment name never breaks across lines, however many line breaks it was sent with; the break is shown, not removed.
- **Nothing is filtered out of the content** and no attempt is made to detect attacks. Such filters pretend to offer safety they cannot deliver.
- **Sending requires your confirmation by default**, enforced in the server rather than in a system prompt, and a client that cannot ask the question cannot send. You can allow a sending tool to act on its own; the switch is guarded by the PIN when you set one, the environment can fix it either way, and bounds can limit who it may send to, how often and until when.
- **There will be no permanent deletion**, and no tool that reads or changes filters, forwarding, account or key settings. A hijacked session must not be able to leave behind lasting access.
- **HTML is never passed through raw** and external content is never fetched. Tracking pixels stay ineffective.
- **Your mail is not kept on your disk.** No cache, no index, no copies. Anything this server wrote down would be your mail in plain text, outside the encryption you pay Proton for. The one exception is an attachment you have the assistant save, into a directory you chose, for an hour at most, see [Saved attachments](#saved-attachments).

### Writing to your mailbox

Every tool that changes something is bounded on purpose:

- **`PROTON_MCP_READ_ONLY=true` refuses every write**, and the interface reports the mode it is in. Reading keeps working.
- **Nothing is ever deleted for good.** `trash_messages` moves messages to the trash, where Proton keeps them and where `move_messages` can take them back out. There is no tool that empties the trash.
- **Removing a label is an expunge inside the label's own mailbox.** The same command aimed at a folder would delete mail, so the code refuses any path outside `Labels/`, checked again in the line immediately before the expunge. A label name containing a path separator is rejected rather than repaired.
- **Labels are never created**, only applied. Create them in Proton itself.
- **A label is not a destination for `move_messages`.** Moving a message into a label was measured to apply the label and leave the message where it is, so the tool refuses it instead of reporting a move that did not happen.
- **A batch touches at most 50 messages**, and every one of them is accounted for in the answer, including the ones that failed and why.

**A draft is the safe default.** The assistant prepares, you decide.

**Messages can be plain text or formatted.** A formatted one may use headings, paragraphs, emphasis, lists, tables, links and images, with colour, font, alignment, spacing and borders. **Images work the ordinary way**: an `<img>` at an `https` address, at any size, inside a link, animated if you like. Only a `data:` address is refused, because it would carry a whole file inside the markup where nothing lists it.

Anything outside the permitted set is refused with a reason rather than quietly removed, because a message that was silently altered is no longer the message anyone agreed to. **The refusal names the way forward**, which is usually `markupLevel: "extended"`.

Formatting changes what a confirmation has to show, and that is the interesting part. In plain text a link's visible text and its target are the same string, so showing you the body shows you everything. In markup they are two strings, which is the shape of every phishing mail ever written. Neither fits in a dialog, so both live on the preview page, never shortened:

- **Every address in the message**, links and images alike, each with the text it is shown as.
- **Text a recipient can read that the body does not show.** Measured: an image's alt text never appears in the converted body, and mail clients block remote images by default, so the alt text is frequently what the recipient actually reads. That was a way past the confirmation, and it is closed.
- **Every property beyond ordinary formatting**, when `extended` was used, with the ones that really put something out of sight marked as such.

What no level permits is `style` blocks, `script`, event handlers, `data:` addresses and comments. Comments look inert and are not: Outlook runs conditional ones, so a `<style>` block inside a comment reaches those recipients as markup while the confirmation and the preview see a comment. Addresses are checked wherever they appear, a CSS `background: url(...)` included, and every one of them is listed on the preview page. The line runs between describing a document and running inside it or reaching out of it: a `<style>` in the quote of a reply restyles the answer written above it, and 66 percent of real formatted mail carries one. Attachments from files on this machine are not supported today: a path named by a model, read by the server and carried out by the next confirmation would be a way out for anything on your disk. [#17](https://github.com/RndmJoker/proton-mcp/issues/17) tracks a version that reads only from a directory you have set yourself, and stays off until you do. Forwarding loses nothing all the same, because the original message travels along whole, embedded images included.

A stored draft is sent exactly as it was stored, its files and a forwarded original included. Its markup is checked when the draft is written, not again when it is sent: once stored, the part somebody wrote and the quote below it can no longer be told apart, and checked again a formatted reply would fail on the `<style>` of its quote. Nothing is waved through unseen for that. The preview page lists every address, every hidden text and everything a newly written message could not contain, and the confirmation carries the same warning as `extended` whenever the draft holds more than `standard` would have let through. `update_draft` keeps a draft's files whatever happens to its body.

One more thing worth knowing about drafts: Proton rewrites the thread headers of anything it stores. A reply is built with `In-Reply-To` and `References`, and what comes back has neither, only Proton's own internal thread id. Threading a stored draft is therefore Proton's business rather than this server's.

Writes need a moment to settle. A move takes roughly fifteen seconds to reconcile with Proton, and until then the Bridge lists the message in both places, so the tools say so rather than reading back an intermediate state and calling it the result. Flags are the exception: those hold immediately.

### Sending, and the question before it

Mail is text written by strangers, handed to a model that can call tools. A message can politely ask to be forwarded somewhere, and other projects answer that with a line in a system prompt. **A system prompt is not a security boundary.** This one lives in the server:

- **By default, nothing is sent without a person saying yes.** The first call never sends. It returns a question through your client naming the sender, every recipient separated into To, Cc and Bcc, and the subject. Only the second call, carrying your answer, sends.
- **The question is short, and the message is somewhere with room.** It carries no part of the message itself; it links to a page, served by the server that asks, where you can read it as the recipient will see it, with every address in full. That split exists because the question used to grow with the message: 74 lines for a newsletter-shaped one, at which point the confirm button sat below the bottom of the dialog and nothing could be sent at all.
- **Recipients are never summarised**, however many there are. Seeing three of eight would mean agreeing to a send to five strangers.
- **The address you confirm is the address the message goes to.** Every recipient is read back through the code that builds the envelope, and refused if it would come out as another address or as none. An address with a character outside ASCII is refused as well: letters from another script can spell a familiar domain, and the message would go to a different one that anyone can register. A domain that really is written with such letters can be given in its `xn--` form, which is then exactly what you confirm.
- **The answer goes through your client, never through the browser.** That page has no confirm button and will not get one: its address travels with the question and so reaches your assistant, so a control there could be operated by the thing it is supervising.
- **You can switch the question off, per tool, and nobody else can when a PIN is set.** See [What the assistant may do](#what-the-assistant-may-do) below. Off is the default, and an answer the server already asked for always stands: a "no" given after the level changed is still a no.
- **A client that cannot ask cannot send.** If your client does not support form elicitation, sending is refused and you are pointed at drafts instead. That is deliberately different from the sign-in prompt, which falls back to text: the worst outcome there is an inconvenience, and here it is a message that cannot be recalled. What counts as "can ask" is the capability your client declares, read from the request when the protocol revision carries it there and from the handshake otherwise.
- **Your yes covers one specific message.** A fingerprint of the sender, every recipient, the subject and the body is sealed with an HMAC whose key exists only in the running process, and it travels with the question. On the way back the fingerprint is recomputed from what is being asked for now. If a single address was added in between, nothing is sent. A confirmation is also bound to the tool that asked, so one cannot be reused for another.
- **Blind copies stay blind.** They travel in the envelope and never appear in the headers the recipients see. Verified against a real delivery.
- **The Bridge password is protected on the way out too.** IMAP and SMTP are both verified against the same pinned certificate, and on both STARTTLS is required rather than merely attempted. Something listening on the port that offers no encryption gets no password.

Replying and forwarding exist as sending tools of their own, not just as drafts. The reason is measured: Proton rewrites the thread headers of anything it stores, so a reply written to a draft and sent later loses the chain, while a reply handed straight to SMTP keeps its `In-Reply-To` and stays in the conversation.

After a send, nothing checks its own work. The Bridge took about six and a half seconds to accept a message and the message appeared over IMAP about three seconds after that, so an immediate look would describe a state that is not the outcome.

### What the assistant may do

Every tool that can be switched has a level, chosen on the Permissions page of the interface or in the environment, which wins:

| Level | What the tool does |
| :--- | :--- |
| `off` | Is taken away from the assistant entirely. It disappears from the list your client sees, and a call that arrives anyway is refused |
| `ask first` | Runs only after you agree: the sending tools ask through your client, the filter tools that change something in a window of the browser extension. These do it by default, and only these can |
| `act on its own` | Runs without asking. Every other tool does this by default |

**Nothing changes on an upgrade:** the defaults are the behaviour before levels existed, and `delete_filter` and `set_filter_status`, which came later, are off until you switch them on. `open_configuration` and `check_for_updates` are always there and have no level.

In the environment, three lists take tool names or the groups `reading`, `filing`, `writing`, `sending` and `filters`. A tool named on its own wins over its group, and anything contradictory or unknown stops the server at start rather than letting it run with permissions nobody chose:

```
PROTON_MCP_OFF=trash_messages,send_forward
PROTON_MCP_ASK_FIRST=send_draft
PROTON_MCP_ACT_ON_ITS_OWN=send_reply
```

`PROTON_MCP_READ_ONLY=true` still works and switches every tool that changes something off, whatever else says otherwise.

**Sending without asking costs something, and the Permissions page says so where you switch it on:** your private mail, text written by strangers and a way out are then together with no person in between. A single message can ask for your mailbox to be forwarded, and nobody would see it happen. Three bounds make that smaller, each one optional, set on the same page or in the environment:

| Bound | Environment | What happens outside it |
| :--- | :--- | :--- |
| Permitted recipients, full addresses or domains written as `@example.com` | `PROTON_MCP_SEND_ALLOWED` | The send asks first |
| A maximum per hour, counted per running server | `PROTON_MCP_SEND_MAX_PER_HOUR` | The send asks first |
| A last day, written YYYY-MM-DD | `PROTON_MCP_ACT_UNTIL` | Every send asks first again |

A send outside a bound becomes a question, not a failure, and the question says which bound held it back. A send that went out without asking says so in its answer, and the overview of the interface lists every tool whose level departs from the default. **Without a PIN, anything on your machine can change these levels, the assistant included**, so set one before you allow sending without asking, or set the levels in the environment.

### A copy of everything sent

One address can receive a copy of every message any sending tool sends: as a blind copy, for a record the recipients do not see, or as Cc, for a second person who sees every send. Set it on the Permissions page or in the environment, which wins:

```
PROTON_MCP_COPY_TO=archive@example.com
PROTON_MCP_COPY_AS=bcc
```

- **It is added before the question is asked**, so it is part of what you confirm, and the question names it as coming from this setting rather than from the assistant.
- **Nothing the assistant passes removes it.** An address the assistant named itself is not added a second time.
- **A send without asking carries it too**, and it does not count against the permitted recipients.
- **Only an address in plain ASCII is accepted**, for the same reason as every other recipient, and more so: this one receives everything.

A field that quietly adds a recipient to every message is what an attacker would most like to set. So the overview shows it whenever it is on, and once a PIN is set, only someone who knows the PIN can change it.

### Filters, through the browser extension

What an assistant can do with filters, and what keeps that in bounds. Each point is held in this server and again in the extension; neither trusts the other's check.

- **Filing and flags, and anything more only where you allow it.** A proposed script has to start with Proton's spam guard, exactly as Proton writes it, and may file into folders and labels and set or clear the read and star flags. Beyond that, each of these is refused until you allow it, on the Permissions page and again in the popup of the extension: moving mail to Trash or Spam, `discard`, `expire`, `reject`, `vacation` and `stop`. Allowed, the window names what it does and what it costs, and a text that goes to a sender has to be written out, with no variable in it. Deleting a filter and switching one on or off are tools of their own, off until you switch them on. `redirect` is refused whatever you allow: Proton does not run it in filters.
- **Nothing that reads differently from what it does**, whatever you allow: comments other than Proton's own two, the line above the spam guard and the one its filter editor writes above each rule, `text:` blocks and line breaks inside a string, invisible characters, `:regex` and Proton's own `eval` extension, a folder given as a bare number or named by a variable, and anything this check does not know.
- **You agree in a window of the extension**, by default, before anything is saved, applied, moved, deleted or switched. It shows the account, what the filter does to matching mail, the whole script, and for a change the difference to the stored version; for a move, the new order and a warning where a filter that does something an assistant may not set up changes place. Each window answers only in the tab it was opened in, and only once. Its buttons are locked for a moment and a half whenever it opens or comes to the front, and the one that refuses comes first, so a click meant for another window or a stray Enter does not agree.
- **Acting without the window takes two switches, and so does every allowed action.** The tool's level on the Permissions page, like the sending tools, and the extension's own switch for that action in its popup. Likewise each action a filter may do beyond filing and flags: allowed on the Permissions page or with `PROTON_MCP_FILTER_ACTIONS`, and again in the popup. The extension's switches are off by default, and then it shows its window whatever the server sends, and refuses what its popup did not allow.
- **A browser tool an assistant drives cannot reach that window.** Measured with Claude in Chrome: the window is not among its tabs; on a web page there is no way to message the extension; a jump to the window's address from a web page ends on `chrome-extension://invalid/`; reading, finding and screenshots on an extension page fail.
- **Orders only from this server.** The extension declares no `externally_connectable`, so no web page can send it anything, and its script in the Proton page listens to the extension alone. The connector accepts connections only on a socket file in a directory only you can open, and only after the connection proves it knows the secret from the setup; the connector proves the same back. Every message is checked against a fixed list of seven kinds. Measured: a connection without the secret is cut off at its first request, and nothing reaches the extension. The limit: a program running as you can read the secret. It then meets the window like the server does, unless you turned on the extension's switches.
- **The right account.** Before anything is read or changed, the extension checks that the Proton page belongs to the account this server is signed in to, and once more right before each change.
- **What you agreed to, and nothing that changed since.** A change runs only while the filter, or the order, is still as it was when you agreed. A filter that does something you did not allow is neither replaced, applied nor switched on by an assistant. A change tried again after a lost answer first looks whether the first try already worked, so it does not save a filter twice.
- **Applying takes time.** Proton runs a filter over the existing mail in the background, which on a large mailbox takes hours, and applies no other filter meanwhile. An application you agreed to then waits in the extension, tried again at growing intervals of up to fifteen minutes, for as long as Chrome stays open; saving and moving go through meanwhile. The popup shows what waits and can cancel it, except while it is being tried. Restarting Chrome or the extension drops what waits, and the popup notes each one.

### What lands on your disk

Only these, all under `~/.config/proton-mcp/` (on Windows `%USERPROFILE%\.config\proton-mcp\`) and all written readable by your account alone:

| File | When | What is in it |
| :--- | :--- | :--- |
| `known-certificate.json` | On the first connection | The Bridge's certificate and its fingerprint |
| `settings.json` | When you change something in the interface | The two Bridge ports, whether the notice that this is not an official Proton tool was dismissed, the PIN as a salted hash, and a counter that tells every running server to reread the stored credentials |
| `run/instances/` | While servers run | One small file per running server: process id, version, start time, whether it is signed in and as which address, and whether it serves the interface. No password |
| `credentials.enc` | Only if you chose the encrypted file | Your Bridge password, encrypted with your master password |
| `env` | Only if you chose the plain file, or put it there yourself | Your Bridge password in plain text |
| `saved-attachments/` | While attachments are saved | Which files this server saved, so it can delete exactly those again. No content |
| `browser/secret` | When you run `setup-browser` | The random secret the server and the connector prove to each other |
| `browser/host/` | When you run `setup-browser` | A copy of the connector and the launcher Chrome starts |
| `run/browser.sock` | While Chrome runs the connector | The socket the server reaches the connector through. Where the home path is too long for a socket, under `/tmp/proton-mcp-<your user id>/` instead; on Windows a named pipe |

Choosing the system keyring puts the password where the operating system keeps your other passwords, and nothing of it in a file. Choosing "this session only" writes nothing at all.

`setup-browser` also writes the file that tells Chrome which program the extension may start, where Chrome looks for it: `~/.config/google-chrome/NativeMessagingHosts/com.rndmjoker.proton_mcp.json` on Linux, the same name under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` on macOS, and on Windows in `browser/` above, named in a registry key under `HKEY_CURRENT_USER`. The extension keeps its switches, what filters may do, its last fifty changes with the filter names, and what waits for Proton, with the script, in its own storage in your Chrome profile; what waits is gone once it ran, was cancelled or Chrome restarted. A proposal waiting for your decision is kept in memory only.

**No mail, no subjects, no sender addresses, no folder names, no search terms.** The activity list in the interface records tool names and timings, in memory only, and is gone when the server stops.

### Saved attachments

`save_attachment` writes an attachment to your disk so that the assistant can open it, a PDF or a spreadsheet for instance. That is your mail decrypted, so it is bounded on every side:

- **Off until you name a directory** in `PROTON_MCP_ATTACHMENT_DIR`, and only there or in a folder inside it. The tool is still listed, and without the directory its answer says what to set. The variable is read from the environment only; the web interface cannot set it, because an assistant can reach that page.
- **Nothing outside it.** A folder is checked after it is resolved; `..` and a symbolic link on the way are refused.
- **The sender's file name is reduced to a plain one**, without path separators, control or formatting characters, a leading dot or a device name Windows reserves.
- **An existing file is never replaced**, a link in its place is never followed, and every file is readable by your account alone.
- **Gone within the hour.** A saved file is deleted one hour after saving and when the server stops. A server that was killed leaves its files to the next one that starts. The assistant is told so, and copies a file it needs for longer.
- **Only what it saved.** The server records which files it wrote and deletes a file only while it is still that file, so whatever else is in the directory is never touched. A folder it created for a file goes again once it is empty; a folder that was there before stays. The one gap: a folder deleted and made again under the same name can be taken for the one it created, when the file system hands out the same inode again, and then goes too if it is empty.
- **At most 25 MB**, which is what Proton accepts per message anyway.

To switch it on, add the variable to the server's entry in your client's configuration:

```json
{
  "mcpServers": {
    "proton": {
      "command": "node",
      "args": ["/absolute/path/to/proton-mcp/dist/server.js"],
      "env": { "PROTON_MCP_ATTACHMENT_DIR": "/absolute/path/to/a/directory" }
    }
  }
}
```

The directory has to exist; it is not created for you, so that a mistyped path does not become a new place for mail to land.

**Do not choose a folder that is synced to a cloud service.** A file saved there leaves your machine decrypted, and the server cannot tell such a folder from any other.

### The web interface

It binds to `127.0.0.1` and there is no option to change that. It is not remote access and cannot be made into it. Four defences, each against a specific attack:

- **An optional PIN on every change.** Until 0.4.13 a token in the address kept other programs out, but that address reached the assistant, so it kept out everything except the one party the interface is meant to supervise. Set a PIN on the Permissions page and every change there asks for it: the assistant never sees it, so it can open the page but change nothing. It is stored only as a salted scrypt hash, and five wrong attempts lock changes for a minute. **Without a PIN, anything running on your machine can change the settings, an assistant with a browser tool included**, and the interface says so. Type the PIN only into a tab you are using yourself, since a tab an assistant drives at that moment can read what is typed into it. A forgotten PIN is removed by deleting the line `"pin"` from `settings.json`.
- **A Host header check.** A page on the internet can point its own domain at `127.0.0.1` and have your browser send requests there, which the browser then treats as same-origin with that domain. Only loopback names are accepted. This is DNS rebinding, and it is the attack local servers most often forget.
- **An Origin check and a per-action CSRF token** on everything that changes something, so a token for one action cannot be replayed against another.
- **A strict Content-Security-Policy.** Nothing may be loaded from anywhere and nothing can reach the network. The interface also serves no files from disk at all, which removes path traversal as a category rather than guarding against it.

Reading needs nothing: any program on your machine can open the pages, including the one listing your folder names. On a machine shared with other people, keep that in mind.

It shows no message content, with exactly one exception: a message waiting for you to confirm it. That page renders it as the recipient will see it, and lists every address, alt text and attachment. The message is held in memory only, dropped as soon as you answer either way, and gone after fifteen minutes. Somebody else's markup, which a reply carries as its quote, is rendered in a frame with no permissions at all, and images from the internet are not loaded: a tracking pixel must not tell its author that you looked.

### What you actually expose

In Proton, folders and labels belong to the **account**, not to an individual address. If you connect the server using a secondary address, the **complete folder structure of your account** is still visible, even though the messages inside belong to the other address and stay hidden.

The names alone say something. A folder `Banking/Revolut` reveals your bank, `Tax` your dealings with the tax office, a company name your employer. Separating both content **and** structure requires a separate Proton account, not just a second address.

### The Bridge certificate

The Bridge generates its own certificate and keeps it inside its encrypted vault rather than on disk, so it cannot be trusted in advance. Switching verification off would mean anything that manages to listen on the port gets your Bridge password.

Instead the certificate is **pinned on first use**. The first connection records its fingerprint in `~/.config/proton-mcp/known-certificate.json` and reports it on stderr. The web interface shows it too, along with the date it was recorded. Every connection after that is verified against that one certificate, which is stricter than the public trust store: a certificate signed by a recognised authority would not do. The check happens in the connection's own handshake, before the password is sent. The certificate is read on a connection of its own only on first use and after a connection failed, to tell whether the certificate is what changed.

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
| MCP | `@modelcontextprotocol/server` v2. Its newest protocol revision is 2025-11-25; the parts of 2026-07-28 this server prepares for are read defensively, see the comment in `src/tools/capabilities.ts` |
| IMAP | `imapflow` |
| MIME | `mailparser`, `html-to-text` |
| SMTP | `nodemailer` |
| Schemas | `zod` |
| Tests | Vitest, `node` environment |

Every dependency that ships is permissive: mostly MIT, with Apache-2.0 (`@modelcontextprotocol/server` and `@modelcontextprotocol/core`, which are moving from MIT and keep it for older contributions), MIT-0 (`nodemailer`), BSD-2-Clause (the `htmlparser2` family), BSD-3-Clause (`deepmerge-ts`), ISC (`split2`) and one dual `MIT OR EUPL-1.1+` (`@zone-eu/mailsplit`). Development dependencies add MPL-2.0.

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
├── browser/      the channel to the browser extension: connector, socket, setup
├── credentials/  the four places a password can be kept, and the runtime probe
├── filters/      the check every proposed Sieve script passes, and moving filters
├── mail/         listing, reading, searching, identifiers, attachments
├── mime/         parsing, HTML to text, budgeting, the parts of a stored draft
├── tools/        the MCP tools and their output formatting
├── web/          the local interface and its security layer
├── activity.ts   what is running and what ran, in memory only
├── config.ts     the environment variables, read once at startup
├── in-flight.ts  the counter that holds shutdown until answers are out
├── session.ts    whether we are signed in, and where from
├── settings.ts   the Bridge ports, when changed in the interface
└── server.ts     entry point and transport
extension/        the browser extension Proton MCP Helper, built with WXT, not in the npm package
```

The web interface has one property worth knowing before touching it: `Referrer-Policy` must not be `no-referrer`. Under that policy browsers send `Origin: null`, which the CSRF defence rightly refuses, and the interface then refuses its own forms. The tests set the Origin header themselves and cannot catch it. There is a comment in `src/web/security.ts` and a test asserting the cause.

### Checks before a pull request

The CI in `.github/workflows/ci.yml` runs the tests, the type check, the build, an audit of the dependencies and a scan for accidentally committed secrets, and type checks and builds the extension. All of it runs locally too:

```bash
npm ci --prefix extension             # once: the extension's own dependencies, which its tests need
npm test
npm run typecheck
npm run build
npm audit --omit=dev
npm run typecheck --prefix extension
npm run build --prefix extension
```

### Measured behaviour of the Bridge

Some of what this server does looks odd until you know what the Bridge actually does, as opposed to what a standard IMAP server would do. The comments in `src/bridge/`, `src/mail/` and `src/mime/` name the measurement behind each decision. The three that surprise people most:

- `FETCH 1:*` on an empty mailbox is answered with `BAD no such message` instead of an empty result, so a message count has to be checked first.
- UIDs are per mailbox and change when a message is moved. The Message-ID is the only stable handle.
- A median message costs roughly 16000 tokens in its raw form and a fraction of that as text, which is why nothing raw is ever passed through.

Worth reading before changing anything in those directories.

## License

MIT
