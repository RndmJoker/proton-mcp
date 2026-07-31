#!/usr/bin/env node
/**
 * Entry point of the MCP server.
 *
 * The server speaks over stdio, so the client starts it as a child process.
 * That is not a workaround: the Bridge only listens on 127.0.0.1, so a server
 * running in the cloud could not reach it at all.
 *
 * The local web interface runs for as long as this process does. It is not
 * started on demand: it is where configuration and state live, and it is meant
 * to be opened again and again rather than summoned for one sign-in.
 */

import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { McpServer, createRequestStateCodec } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import {
  loadConfig,
  credentialsFromEnvironment,
  portsSetExplicitly,
  ConfigError,
} from './config.js'
import { Connection } from './bridge/connection.js'
import { loadPinned, pinPath } from './bridge/certificate.js'
import { Session } from './session.js'
import { encryptedFilePath } from './credentials/encrypted-file.js'
import { loadSettings, saveSettings } from './settings.js'
import * as activity from './activity.js'
import { WebInterface, type StatusSnapshot } from './web/server.js'
import { registerListFolders } from './tools/list-folders.js'
import { registerMessageTools } from './tools/messages.js'
import { registerInterfaceTool } from './tools/interface.js'
import { registerLabelTools } from './tools/labels.js'
import { registerActionTools } from './tools/actions.js'
import { registerDraftTools } from './tools/drafts.js'
import { registerSendTools } from './tools/send.js'
import type { PendingSend } from './tools/confirm.js'
import { setSignInHint } from './tools/failures.js'
import { setHandshakeCapabilities } from './tools/capabilities.js'
import { waitForIdle } from './in-flight.js'

// The version number lives in package.json only.
// Writing it here a second time would mean forgetting it here. From
// dist/server.js the path points at the package.json of the project root, and
// in the published package at its own.
const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { name: string; version: string }

const NAME = pkg.name
const VERSION = pkg.version

const notify = (message: string): void => {
  // stderr, never stdout: the protocol runs over stdout.
  process.stderr.write(`${NAME}: ${message}\n`)
}

async function main(): Promise<void> {
  const startedAt = Date.now()

  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${NAME}: ${error.message}\n`)
      process.exit(1)
    }
    throw error
  }

  // Stored ports fill in only where the environment said nothing. An explicit
  // BRIDGE_IMAP_PORT has to keep meaning what it says.
  const explicitPorts = portsSetExplicitly()
  const stored = await loadSettings()
  if (!explicitPorts.imapPort && stored.imapPort !== undefined) config.imapPort = stored.imapPort
  if (!explicitPorts.smtpPort && stored.smtpPort !== undefined) config.smtpPort = stored.smtpPort

  const environmentCredentials = credentialsFromEnvironment()
  const session = new Session({
    ...(environmentCredentials ? { fromEnvironment: environmentCredentials } : {}),
    notify,
  })

  // One connection for the whole process, opened on the first tool call rather
  // than at startup: a client often spawns the server long before the user wants
  // anything, and a locked Bridge should not prevent it from starting.
  const connection = new Connection(config, () => session.credentials(), notify)

  /**
   * Tries credentials against the Bridge before they are trusted.
   *
   * Storing something that does not work would send the user looking in the
   * wrong place, and on the unlock path it is the only way to tell a wrong
   * master password from a Bridge that is simply locked.
   */
  const verify = async (credentials: { user: string; pass: string }): Promise<string | undefined> => {
    const probe = new Connection(config, async () => credentials, notify)
    try {
      await probe.listMailboxes()
      return undefined
    } catch (error) {
      return (error as Error).message
    } finally {
      await probe.close()
    }
  }

  const web = new WebInterface({
    port: config.webPort,
    onSignIn: async (credentials, storeKind, masterPassword) => {
      const failure = await verify(credentials)
      if (failure) return failure
      try {
        await session.signIn(credentials, storeKind, masterPassword)
      } catch (error) {
        return (error as Error).message
      }
      // Drop the old connection so the next call uses the new credentials.
      await connection.close()
      return undefined
    },
    onSignOut: async () => {
      await session.signOut()
      await connection.close()
    },
    onUnlock: async (masterPassword) => {
      let credentials
      try {
        credentials = await session.unlock(masterPassword)
      } catch (error) {
        return (error as Error).message
      }
      // The file opened, which only says the master password was right. Whether
      // the Bridge still accepts what was in it is a separate question, and one
      // the user would rather have answered here than at the next tool call.
      const failure = await verify(credentials)
      if (failure) {
        await session.signOut()
        return (
          `${failure}\n\nThe file was decrypted, so the master password was correct, but the ` +
          'Bridge password inside it no longer works. Sign in again with a fresh one.'
        )
      }
      await connection.close()
      return undefined
    },
    onDiscardEncrypted: async () => {
      await session.discardEncrypted()
      notify('the encrypted credentials file was deleted on request')
    },
    getStatus: async () => {
      const pinned = loadPinned(pinPath())
      const base: StatusSnapshot = {
        connected: session.signedIn,
        locked: await session.locked(),
        encryptedPath: encryptedFilePath(),
        bridgeHost: config.host,
        bridgeImapPort: config.imapPort,
        bridgeSmtpPort: config.smtpPort,
        readOnly: config.readOnly,
        uptimeMs: Date.now() - startedAt,
        ...(session.address ? { address: session.address } : {}),
        ...(session.storeKind ? { storeKind: session.storeKind } : {}),
        ...(pinned
          ? {
              certificate: {
                fingerprint: pinned.fingerprint256,
                subject: pinned.subject,
                firstSeen: pinned.firstSeen,
              },
            }
          : {}),
      }
      if (!session.signedIn) return base
      try {
        const mailboxes = await connection.listMailboxes()
        const inbox = await connection.status('INBOX')
        return {
          ...base,
          mailboxCount: mailboxes.filter((box) => box.selectable).length,
          messageCount: inbox.messages,
          unseenCount: inbox.unseen,
        }
      } catch {
        // The status page should still render when the Bridge is unreachable.
        return base
      }
    },
    // Absent when the user set the ports themselves: the form then disappears
    // rather than quietly overriding what they configured.
    ...(explicitPorts.imapPort || explicitPorts.smtpPort
      ? {}
      : {
          onPorts: async (ports) => {
            try {
              await saveSettings(ports)
            } catch (error) {
              return `The ports could not be saved: ${(error as Error).message}`
            }
            // The Connection reads this object on every reconnect, so closing
            // the current one is all that is needed for the change to take.
            config.imapPort = ports.imapPort
            config.smtpPort = ports.smtpPort
            await connection.close()
            notify(`ports changed to IMAP ${ports.imapPort}, SMTP ${ports.smtpPort}`)
            return undefined
          },
        }),
    onTest: async () => {
      try {
        const mailboxes = await connection.listMailboxes()
        return {
          ok: true,
          message:
            `The Bridge answered on ${config.host}:${config.imapPort} and accepted the ` +
            `credentials. ${mailboxes.filter((box) => box.selectable).length} mailboxes are visible.`,
        }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    },
    getMailboxes: () => connection.listMailboxes(),
    getActivity: () => {
      const now = Date.now()
      return {
        running: activity.inProgress().map((call) => ({
          tool: call.tool,
          forMs: now - call.startedAt,
        })),
        recent: activity.recent().map((call) => ({
          tool: call.tool,
          at: call.startedAt,
          durationMs: call.durationMs,
          outcome: call.outcome,
        })),
      }
    },
    notify,
  })

  // Every tool answer about a missing sign-in names this address, so the model
  // sends the user there instead of asking for the password in the chat.
  setSignInHint(() => (web.running ? web.url : undefined))

  let webUrl: string | undefined
  try {
    webUrl = await web.start()
    notify(`web interface at ${webUrl}`)
    if (!session.signedIn && !environmentCredentials) {
      // Asking the session restores from a store, which is what makes this
      // message true. Without it the answer is always "nothing stored": the
      // restore is lazy and has not happened yet at startup, so a perfectly
      // good credentials file was reported as absent every single start.
      const restored = await session.credentials()
      if (restored) {
        notify(`credentials restored from the ${session.storeKind ?? 'store'}, signed in as ${session.address}`)
      } else {
        notify(
          (await session.locked())
            ? 'credentials are stored in an encrypted file, open the address above to unlock them'
            : 'no credentials stored yet, open the address above to sign in',
        )
      }
    }
  } catch (error) {
    // A web interface that cannot start must not stop the server: with
    // credentials in the environment everything else still works.
    notify(`${(error as Error).message} Continuing without it.`)
  }

  /**
   * Seals the confirmation that has to survive a round trip through the client.
   *
   * The key is random and lives only in this process, which is exactly right
   * here: the server speaks over stdio, so the same process serves every round
   * of a flow, and a key that never reaches disk cannot be stolen from it. A
   * restart invalidates any confirmation in flight, which is the safe direction
   * to fail in.
   *
   * Bound to the request method as well, so a sealed state cannot be lifted out
   * of one kind of request and presented in another. Which tool it belongs to is
   * checked separately, in the handler.
   */
  const sendCodec = createRequestStateCodec<PendingSend>({
    key: randomBytes(32),
    // Long enough to read a confirmation and think about it, short enough that
    // a yes does not stay usable for the rest of the day.
    ttlSeconds: 300,
    bind: (requestCtx) => String(requestCtx.mcpReq?.method ?? ''),
  })

  const handle = serveStdio(() => {
    const server = new McpServer(
      { name: NAME, version: VERSION },
      {
        // Verifies the seal before a handler ever runs, and hands the decoded
        // payload to it. Without this the state would come back as a raw
        // string the client could have written itself.
        requestState: { verify: sendCodec.verify },
      },
    )
    registerListFolders(server, connection)
    registerMessageTools(server, connection)
    // Read as a function rather than a value: whether the server may write is a
    // property of the configuration, and the tools should ask at call time.
    registerLabelTools(server, connection, () => config.readOnly)
    registerActionTools(server, connection, () => config.readOnly)
    registerDraftTools(server, connection, () => config.readOnly, () => session.address)
    // What the client declared at handshake time. On this SDK's protocol
    // revision it is the only place the declaration exists, and the confirmation
    // before sending refuses when it cannot see one. Registered here because the
    // instance is built here and does not exist earlier.
    setHandshakeCapabilities(() => server.server?.getClientCapabilities?.())

    registerSendTools(server, {
      config,
      connection,
      getCredentials: () => session.credentials(),
      readOnly: () => config.readOnly,
      from: () => session.address,
      codec: sendCodec,
    })
    registerInterfaceTool(server, {
      url: () => web.url,
      running: () => web.running,
      signedIn: () => session.signedIn,
      address: () => session.address,
      storeKind: () => session.storeKind,
      locked: () => session.locked(),
    })
    return server
  })

  // Clean shutdown. stdin matters most: when the client dies the stream ends
  // without any signal arriving. Without handling this, the server process
  // would be left orphaned along with its open IMAP connection and its socket.
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    // Give the event loop one turn first. When the input stream ends there may
    // still be unread messages in the buffer that do not count as in-flight
    // work yet. Without this pause the counter would be zero and the server
    // would exit before the last request even starts.
    await new Promise((next) => setTimeout(next, 50))

    // Let running tool calls finish so their answer still goes out. Bounded,
    // so that a stuck call cannot prevent shutdown.
    const idle = await waitForIdle(5000)
    if (!idle) notify('shutdown forced, a call was still running.')

    try {
      await web.stop()
      await connection.close()
      await handle.close()
    } finally {
      process.exit(idle ? 0 : 1)
    }
  }

  process.stdin.on('end', () => void shutdown())
  process.stdin.on('close', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main()
