# Updating proton-mcp

You are reading this because somebody asked you to update **proton-mcp**, an MCP
server that gives an assistant access to a Proton Mail account through a locally
running Proton Mail Bridge.

**You do the work, not the user.** Run the commands yourself and report what you
find, rather than printing a list for somebody to copy.

This is shorter than the setup guide and has one trap in it, which is why it
exists at all: **how you update depends on how it was installed**, and the three
ways look identical from the outside.

---

## 1. Find out how it is installed

Read the client's configuration and look at the `proton-mcp` entry.

```bash
claude mcp list
```

For Claude Desktop or Cursor, read the JSON file instead:
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/.config/Claude/claude_desktop_config.json` on Linux, and `~/.cursor/mcp.json`
for Cursor.

What the `command` and `args` say tells you which case you are in:

| The entry says | It is installed |
| :--- | :--- |
| `npx` with `@rndmjoker/proton-mcp` | from npm, on demand |
| A path ending in `dist/server.js` | from a directory on this machine |
| `proton-mcp` alone | globally, with `npm install -g` |

**Report which one it is before doing anything.** If you cannot find the entry at
all, say so and stop: there is nothing to update, and the setup guide at
`prompt.md` is the right document instead.

---

## 2. Update it

### Installed through npx

**Usually nothing has to be done here.** The npm that comes with Node.js 24
asks the registry for a newer version every time `npx` starts a package that
was given by name only, and `npx -y @rndmjoker/proton-mcp` is exactly that. The
restart in step 3 is what brings the new version in.

Check what the registry has:

```bash
npm view @rndmjoker/proton-mcp version
```

If the client still runs an older version after the restart, remove this
package's entry from the npx cache and restart again. The first command lists
the entries, each as a key followed by the package; the second removes the one
whose package is `@rndmjoker/proton-mcp`:

```bash
npm cache npx ls
npm cache npx rm <key>
```

Do not reach for `npm cache clean --force`. It empties npm's whole download
cache, and it leaves the npx entries, which live in a directory of their own,
exactly where they were.

### Installed globally

```bash
npm install -g @rndmjoker/proton-mcp@latest
npm list -g --depth=0 2>/dev/null | grep proton-mcp
```

### Installed from a directory

Find the directory from the path in the configuration, then:

```bash
cd <that directory>
git pull --ff-only
npm ci
npm run build
npm test
```

**Do not use `git pull` without `--ff-only`.** If the working copy has changes,
that would merge them silently; with the flag it stops instead, and stopping is
the right answer. If it does stop, tell the user their copy has diverged and
leave it alone.

If the directory is not a git repository, it was installed from a package rather
than from source. Then it is the npm case: install it properly and change the
configuration entry to `npx -y @rndmjoker/proton-mcp`, so future updates are one
command instead of three.

---

## 3. Tell them what changed, and that a restart is needed

**The client has to be restarted before it uses the new version.** A running
server keeps the old code, and nothing about that is visible from the outside,
which is the most common way an update appears not to have worked.

The releases are at https://github.com/RndmJoker/proton-mcp/releases and say
what changed and why. 0.4.6 and 0.4.8 to 0.4.10 have no release of their own;
the notes of 0.4.11 cover them. Read the entries between the version that was
installed and the one now installed, and summarise them in a sentence or two.
That is more useful than a version number: it tells them what to try.

If you cannot tell which version was there before, say so rather than guessing.

---

## 4. What an update does not touch

Say this only if it comes up. The point is that nothing has to be set up again.

- **Credentials stay where they are**, in the keyring, the encrypted file or
  wherever they were put. An update does not sign anyone out.
- **The pinned Bridge certificate stays.** It was recorded on first use and is
  checked against every connection.
- **Settings stay**, including the Bridge ports.

If a version ever does need something from the user, the release notes say so.

---

## If something is wrong afterwards

- **The server does not start.** Its output goes to stderr, and most clients hide
  it. Running the command from the configuration by hand shows it.
- **A tool reports that nothing is signed in.** That is the ordinary state after
  the credentials were cleared, not an update problem. The server answers with
  the address of its local page; the user signs in there, never in the chat.
- **Going back to an older version** is possible with npm:
  `npx -y @rndmjoker/proton-mcp@<version>`, with a version that
  `npm view @rndmjoker/proton-mcp versions` lists. Not every number between two
  releases was published. Say which version and why, so it does not become a
  permanent unexplained pin.
