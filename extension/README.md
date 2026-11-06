# Proton MCP Helper

The browser extension of [proton-mcp](../README.md). It works in the signed-in Proton page for the server, for now on mail filters: reading them, proposing new or changed ones, applying them to the mail already there, and moving them in their order. It can also delete filters and switch them on or off. Every change waits for a yes in a window of its own, unless the user allowed a tool to act on its own twice: on the server's Permissions page, and with the extension's own switch for it in its popup, off by default. What a filter may do beyond filing and flags is allowed the same way, twice, one action at a time.

It is not part of the npm package. Each release carries it as a zip.

## Building

```bash
npm ci
npm run build
```

The unpacked extension is then in `.output/chrome-mv3`. `npm run zip` packs it into `.output/` for a release.

To load it, open `chrome://extensions`, switch on Developer mode, choose **Load unpacked** and pick `.output/chrome-mv3`. The id is fixed by the public key in `wxt.config.ts` and has to be `nfmconelbflppeoolebhcckbmffiokkd`, the only one the connector lets in. After a change, click the reload arrow on its card and reload the Proton tab: a tab opened before keeps the old script.

The connector, the program Chrome starts for the extension, is set up from the server: `node ../dist/server.js setup-browser` after a build, or `npx -y @rndmjoker/proton-mcp@latest setup-browser`.

## Where things are

| File | What it does |
| :--- | :--- |
| `entrypoints/background.ts` | Talks to the connector, checks every request again, finds the Proton tab of the right account, opens the windows, runs every write and keeps the queue |
| `entrypoints/proton.content.ts` | The script in the Proton page. Listens to the background only and hands each request to `lib/content-ops.ts` |
| `entrypoints/confirm/` | The window where a change is agreed to. Its buttons are locked for 1.5 seconds whenever it opens or comes to the front, and the one that refuses comes first |
| `entrypoints/popup/` | Whether the connector runs, what waits, the switches for acting without the window, what filters may do beyond filing and flags, the last changes |
| `lib/content-ops.ts` | What the page script does: before every write it checks the account and the script once more |
| `lib/proton-api.ts` | The calls to Proton's interface |
| `lib/queue.ts` | When an application waits and when it is tried again |
| `lib/ops.ts` | The messages between the parts of the extension |
| `../src/filters/` | The check every script passes and the arithmetic of moving filters, shared with the server |
| `../src/browser/messages.ts` | The fixed list of what may pass between server, connector and extension, shared as well |

The tests are in the server's `__tests__/extension/` and run with its `npm test`. `background.test.ts` runs the background against a stand-in for Chrome and for Proton, which is why the server's tests need `npm ci` here first. The background is type checked here, with `npm run typecheck`, not by the server's configuration.

## Permissions

`nativeMessaging` to start the connector, `storage` for the switches, what filters may do, what waits and what happened, `alarms` to try a waiting application again, and the two Proton addresses `mail.proton.me` and `account.proton.me`. No `externally_connectable`: no web page can send the extension anything.
