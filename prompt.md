# Setting up proton-mcp

You are reading this because somebody asked you to set up **proton-mcp**, an MCP
server that gives an assistant access to a Proton Mail account through a locally
running Proton Mail Bridge. It is free software and is not made by, affiliated
with or endorsed by Proton AG.

**You do the work, not the user.** Run the commands yourself and report what you
find. Do not print a list of steps for somebody to copy.

There is one thing you must not do, and it is the reason this file exists at
all. It is stated in full further down: **never ask for the Bridge password.**

---

## 1. Check what is there before you install anything

Report each result plainly. Two of these are things only the user can fix, and
finding out afterwards wastes their time.

```bash
node --version
```

Needs to be **24 or newer**. If it is older or missing, say so and stop: the
server will not start, and installing it anyway only moves the failure.

```bash
# Is the Bridge listening?
(echo > /dev/tcp/127.0.0.1/1143) 2>/dev/null && echo "IMAP port open" || echo "IMAP port closed"
(echo > /dev/tcp/127.0.0.1/1025) 2>/dev/null && echo "SMTP port open" || echo "SMTP port closed"
```

On Windows, in PowerShell:

```powershell
Test-NetConnection 127.0.0.1 -Port 1143 -InformationLevel Quiet
Test-NetConnection 127.0.0.1 -Port 1025 -InformationLevel Quiet
```

Closed ports are not an error you can fix. **Proton Mail Bridge is a desktop
application that the user has to install, start and unlock themselves.** You
cannot start it, and neither can this server. If the ports are closed, tell them
that, and carry on with the rest: the server installs fine without it and will
say so when it is first asked for anything.

Two more things to name rather than test:

- **The Bridge needs a paid Proton plan.** It is not in the free tier. You have
  no way to check this. Say it, so it is not discovered an hour later.
- The Bridge may use different ports if they were changed in its settings. Those
  can be corrected later in the configuration interface, so do not treat closed
  ports as final.

---

## 2. Register the server with the client

Nothing has to be installed permanently. `npx` fetches the package on demand,
and the entry below is all the configuration there is.

### Claude Code

```bash
claude mcp add proton-mcp -- npx -y @rndmjoker/proton-mcp
```

### Claude Desktop, Cursor, and anything else with a JSON configuration

Add this to the `mcpServers` object. Claude Desktop keeps that file at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows, and
`~/.config/Claude/claude_desktop_config.json` on Linux. Cursor uses
`~/.cursor/mcp.json`.

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

**Read the file before you write it** and keep whatever is already in it. People
have other servers configured, and replacing the file would remove them without
saying so.

**Put nothing else in that entry.** In particular no address and no password:
there is a place for those and it is not a configuration file.

The client has to be restarted before it picks up a new server.

---

## 3. Do not ask for the password

This is the part that matters most, so it is not folded into a list.

The Bridge generates **its own password per account**, which is not the Proton
account password. People confuse the two reliably.

**Neither of them belongs in a conversation with you.** Not in a prompt, not in
a configuration file you write, not "just this once so I can test it". A
password pasted into a chat is in a transcript, and transcripts are stored,
synced and sometimes shared.

The server has a local web interface for exactly this. When a tool is called
before anyone has signed in, it answers with a `127.0.0.1` address carrying a
one-time token, and clients that support it will open that page directly.

So the correct move, after registering the server, is:

> Ask the user to try something simple, like listing their folders. The server
> will answer with an address. Tell them to open it and sign in there.

If they offer you the password anyway, decline and point at the page again.

---

## 4. Tell them what a connection actually exposes

Do not skip this. It is the one thing about this server that surprises people
after the fact rather than before.

**In Proton, folders and labels belong to the account, not to an address.** If
they connect a secondary address, the **complete folder structure of the whole
account** is still visible, even though the messages in it belong to another
address and stay hidden.

The names alone say a great deal. A folder called `Banking/Revolut` names a
bank, `Tax` names an authority, a company name names an employer. Separating
content *and* structure needs a separate Proton account, not a second address.

Two more, briefly:

- **Every send asks first.** The server puts the question to the user through
  the client and shows the final recipients. There is no setting that turns it
  off.
- **Nothing is deleted for good.** Deleting means moving to the trash.

---

## 5. Report back

Tell the user, in plain words:

- which client the server was registered with, and that it needs a restart
- whether the Bridge was reachable, and if not, that they have to start and
  unlock it themselves
- that a paid Proton plan is required, if you could not verify one
- that the next step is to ask for something simple, then open the address the
  server answers with and sign in there
- that folder names of the whole account become visible

---

## Later, to update

The server can answer that itself: `check_for_updates` asks npm and reports what
to run. It is the only thing in this server that contacts anything other than
the user's own machine, so mention that when you use it rather than after.

There is also a counterpart to this file, for doing the whole thing:

```
Fetch https://raw.githubusercontent.com/RndmJoker/proton-mcp/main/update.md and follow it
```

Worth mentioning once at the end of setup, because how a version is updated
depends on how it was installed, and that is not obvious from the outside.

## Where to read more

- The readme, which lists what works and what does not:
  https://github.com/RndmJoker/proton-mcp
- The package: https://www.npmjs.com/package/@rndmjoker/proton-mcp

Once the server is running it also documents itself. Two guides can be read
through the connection, without asking anyone:

- `proton-mcp://guide/writing` — composing messages, what markup is permitted,
  what the confirmation shows, how replies quote the original
- `proton-mcp://guide/bridge` — the measured behaviour of the Bridge, including
  how long each kind of write takes to settle
