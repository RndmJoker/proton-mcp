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
import type { RegisteredTool } from '@modelcontextprotocol/server'
import {
  Permissions,
  PermissionsError,
  CONTROLLED,
  GROUPS,
  defaultLevel,
  levelsFor,
  type Group,
} from './permissions.js'
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
import { loadSettings, updateSettings, watchSettings, type StoredSettings } from './settings.js'
import { registerInstance, listInstances } from './instances.js'
import { STORE_DESCRIPTIONS } from './credentials/store.js'
import { PreviewServer } from './web/preview-server.js'
import { recordFromEnvironment, recordProblem, RecordError } from './mail/record.js'
import type { RecordCopy } from './settings.js'
import * as activity from './activity.js'
import { WebInterface, type StatusSnapshot } from './web/server.js'
import { registerListFolders } from './tools/list-folders.js'
import { registerMessageTools } from './tools/messages.js'
import { registerInterfaceTool } from './tools/interface.js'
import { registerLabelTools } from './tools/labels.js'
import { registerActionTools } from './tools/actions.js'
import { registerDraftTools } from './tools/drafts.js'
import { registerSendTools } from './tools/send.js'
import { registerSavedAttachmentTools } from './tools/saved.js'
import { SavedAttachments } from './mail/saved-attachments.js'
import type { PendingSend } from './tools/confirm.js'
import { setSignInHint, setLockedCheck, setPreviewBase } from './tools/failures.js'
import { pendingView } from './tools/pending-view.js'
import { setHandshakeCapabilities } from './tools/capabilities.js'
import { registerGuidance, INSTRUCTIONS } from './tools/guidance.js'
import { registerUpdateTool } from './tools/updates.js'
import { registerFilterTool } from './tools/filters.js'
import { registerBrowserFilterTools } from './tools/filter-tools.js'
import { waitForIdle } from './in-flight.js'

// The version number lives in package.json only.
// Writing it here a second time would mean forgetting it here. From
// dist/server.js the path points at the package.json of the project root, and
// in the published package at its own.
const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { name: string; version: string }

/**
 * What this server calls itself, which is deliberately not the package name.
 *
 * The package is scoped so that other servers can sit beside it under the same
 * namespace. That scope is an ownership statement for a registry and has no
 * business in a protocol handshake or at the front of every line on stderr,
 * where it would only make both harder to read.
 *
 * Fixed here rather than derived, because deriving it would tie the name a
 * client displays to a decision about where the package is published.
 */
const NAME = 'proton-mcp'
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
  // The settings shared by every running server. Held here and replaced
  // whenever the file changes, whichever server changed it. Writes go through
  // updateSettings, which reads the file first, so that a change made here
  // cannot undo one made by another server a moment earlier.
  let settings: StoredSettings = await loadSettings()
  if (!explicitPorts.imapPort && settings.imapPort !== undefined) config.imapPort = settings.imapPort
  if (!explicitPorts.smtpPort && settings.smtpPort !== undefined) config.smtpPort = settings.smtpPort
  /**
   * The sign-in counter as this server last knew it. A higher number in the
   * file means somebody signed in or out through the interface, possibly in
   * another server, and the stored credentials have to be read again.
   */
  let knownGeneration = settings.credentialsGeneration ?? 0

  // What the assistant may do, tool by tool. A mistake in the environment stops
  // the start: running with permissions nobody chose would be worse.
  let permissions: Permissions
  try {
    permissions = new Permissions({ settings: () => settings, readOnly: config.readOnly })
  } catch (error) {
    if (error instanceof PermissionsError) {
      process.stderr.write(`${NAME}: ${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
  // The recipient added to every message sent (#18). From the environment it is
  // fixed; otherwise the interface sets it, guarded by the PIN when one is set.
  let recordFromEnv: RecordCopy | undefined
  try {
    recordFromEnv = recordFromEnvironment()
  } catch (error) {
    if (error instanceof RecordError) {
      process.stderr.write(`${NAME}: ${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
  const recordInForce = (): RecordCopy | undefined => recordFromEnv ?? settings.record
  const startRecord = recordInForce()
  if (startRecord) {
    notify(`every message sent also goes to ${startRecord.address} (${startRecord.mode})`)
  }

  const departures = permissions.departures()
  if (departures.length > 0) {
    notify(
      `assistant permissions that differ from the default: ` +
        departures.map((d) => `${d.tool} ${d.level} (${d.source})`).join(', '),
    )
  }
  /**
   * Shows or hides the tools after a change of levels. Set once the MCP server
   * exists; the settings watcher calls it whenever the file changes.
   */
  let applyLevels: () => void = () => undefined
  /** The tools this server registered, so the permissions page lists only real ones. */
  const registeredNames = new Set<string>()
  const groupOf = (tool: string): string =>
    (Object.keys(GROUPS) as Group[]).find((group) => (GROUPS[group] as readonly string[]).includes(tool)) ?? ''

  const environmentCredentials = credentialsFromEnvironment()
  const session = new Session({
    ...(environmentCredentials ? { fromEnvironment: environmentCredentials } : {}),
    notify,
  })

  // One connection for the whole process, opened on the first tool call rather
  // than at startup: a client often spawns the server long before the user wants
  // anything, and a locked Bridge should not prevent it from starting.
  const connection = new Connection(config, () => session.credentials(), notify)

  // Attachments saved to disk, one store for the whole process. Starting it
  // clears up what a server that was killed left behind; stopping it, below,
  // deletes what this one saved. The exit handler is the fallback for an exit
  // that does not pass through shutdown.
  const saved = new SavedAttachments({ root: config.attachmentDir })
  saved.start()
  process.on('exit', () => saved.stop())

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

  // This server's entry in the list of running servers the interface shows.
  // Nothing in it is secret: who is signed in is on the overview page anyway.
  const instance = registerInstance({
    pid: process.pid,
    version: VERSION,
    startedAt,
    signedIn: session.signedIn,
    servesInterface: false,
    ...(session.address ? { address: session.address } : {}),
    ...(session.storeKind ? { storeKind: session.storeKind } : {}),
  })
  const refreshInstance = (): void => {
    instance.update({
      signedIn: session.signedIn,
      address: session.address,
      storeKind: session.storeKind,
    })
  }
  // The session restores credentials lazily, on the first tool call, so the
  // entry is brought up to date now and then rather than only on sign-in.
  setInterval(refreshInstance, 15_000).unref()
  process.on('exit', () => instance.remove())

  /**
   * Tells every other running server that the stored credentials changed.
   *
   * The counter is raised in the shared settings, and each server rereads the
   * stores when it sees that. This server raises its own idea of the number
   * first, so it does not throw away the sign-in it just made.
   */
  const announceCredentials = async (): Promise<void> => {
    try {
      settings = await updateSettings((current) => {
        knownGeneration = (current.credentialsGeneration ?? 0) + 1
        return { ...current, credentialsGeneration: knownGeneration }
      })
    } catch (error) {
      notify(`other running servers could not be told about the sign-in: ${(error as Error).message}`)
    }
  }

  const web = new WebInterface({
    port: config.webPort,
    getPin: () => settings.pin,
    onPinChange: async (next) => {
      try {
        settings = await updateSettings((current) => {
          const { pin: _old, ...rest } = current
          return next ? { ...rest, pin: next } : rest
        })
      } catch (error) {
        return `The PIN could not be saved: ${(error as Error).message}`
      }
      notify(next ? 'a PIN now guards changes in the web interface' : 'the PIN of the web interface was removed')
      return undefined
    },
    getServers: () =>
      listInstances().map((entry) => ({
        pid: entry.pid,
        version: entry.version,
        startedAt: entry.startedAt,
        signedIn: entry.signedIn,
        servesInterface: entry.servesInterface,
        ...(entry.address ? { address: entry.address } : {}),
        ...(entry.storeKind ? { storeTitle: STORE_DESCRIPTIONS[entry.storeKind].title } : {}),
      })),
    onServingChange: (serving) => instance.update({ servesInterface: serving }),
    getPermissions: () => {
      const fixed = permissions.limitsFixed()
      const limits = permissions.limits()
      return {
        tools: CONTROLLED.filter((tool) => registeredNames.has(tool)).map((tool) => {
          const source = permissions.source(tool)
          return {
            tool,
            group: groupOf(tool),
            level: permissions.level(tool),
            options: levelsFor(tool),
            fixed: source === 'environment' || source === 'read-only',
            source: permissions.where(tool),
            departs: permissions.level(tool) !== defaultLevel(tool),
          }
        }),
        limits: {
          allowed: limits.allowed ?? [],
          ...(limits.maxPerHour !== undefined ? { maxPerHour: limits.maxPerHour } : {}),
          ...(limits.until ? { until: limits.until } : {}),
          fixed,
        },
      }
    },
    onLevels: async (chosen) => {
      try {
        settings = await updateSettings((current) => {
          const levels = { ...(current.levels ?? {}) }
          for (const [tool, level] of Object.entries(chosen)) {
            // Only departures are stored, so a default that changes in a later
            // version reaches everyone who never chose otherwise.
            if (level === defaultLevel(tool)) delete levels[tool]
            else levels[tool] = level
          }
          const { levels: _old, ...rest } = current
          return Object.keys(levels).length > 0 ? { ...rest, levels } : rest
        })
      } catch (error) {
        return `The levels could not be saved: ${(error as Error).message}`
      }
      applyLevels()
      const now = permissions.departures()
      notify(
        now.length > 0
          ? `assistant permissions changed: ${now.map((d) => `${d.tool} ${d.level}`).join(', ')}`
          : 'assistant permissions are back to the default',
      )
      return undefined
    },
    getRecord: () => {
      const record = recordInForce()
      return {
        fixed: recordFromEnv !== undefined,
        ...(record ? { address: record.address, mode: record.mode } : {}),
      }
    },
    onRecord: async (record) => {
      if (record) {
        const problem = recordProblem(record.address)
        if (problem) return problem
      }
      try {
        settings = await updateSettings((current) => {
          const { record: _old, ...rest } = current
          return record ? { ...rest, record: { address: record.address.trim(), mode: record.mode } } : rest
        })
      } catch (error) {
        return `The copy recipient could not be saved: ${(error as Error).message}`
      }
      notify(record ? `every message sent now also goes to ${record.address} (${record.mode})` : 'no copy is added to messages any more')
      return undefined
    },
    getFilterActions: () => ({ allowed: [...permissions.unlocks()], fixed: permissions.unlocksFixed() }),
    onFilterActions: async (actions) => {
      try {
        settings = await updateSettings((current) => {
          const { filterActions: _old, ...rest } = current
          return actions.length > 0 ? { ...rest, filterActions: actions } : rest
        })
      } catch (error) {
        return `What filters may do could not be saved: ${(error as Error).message}`
      }
      notify(
        actions.length > 0
          ? `filters from an assistant may now also: ${actions.join(', ')}`
          : 'filters from an assistant may only file and flag again',
      )
      return undefined
    },
    onLimits: async (limits) => {
      try {
        settings = await updateSettings((current) => {
          const { limits: _old, ...rest } = current
          return Object.keys(limits).length > 0 ? { ...rest, limits } : rest
        })
      } catch (error) {
        return `The bounds could not be saved: ${(error as Error).message}`
      }
      notify('the bounds on sending without asking changed')
      return undefined
    },
    onSignIn: async (credentials, storeKind, masterPassword) => {
      const failure = await verify(credentials)
      if (failure) return failure
      let left: string[]
      try {
        left = await session.signIn(credentials, storeKind, masterPassword)
      } catch (error) {
        return (error as Error).message
      }
      // Drop the old connection so the next call uses the new credentials.
      await connection.close()
      refreshInstance()
      await announceCredentials()
      if (left.length === 0) return undefined
      return {
        warning:
          `Signed in, and the password is kept where you chose. An earlier one is still stored ` +
          `elsewhere, though. ${left.join(' ')} Until it is gone, the next start may sign in ` +
          'with it instead.',
      }
    },
    onSignOut: async () => {
      const left = await session.signOut()
      await connection.close()
      refreshInstance()
      await announceCredentials()
      if (left.length === 0) return undefined
      return (
        `Signed out here, but not everywhere. ${left.join(' ')} Until that is done, the next start ` +
        'signs in with what is left.'
      )
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
        const left = await session.signOut()
        return (
          `${failure}\n\nThe file was decrypted, so the master password was correct, but the ` +
          'Bridge password inside it no longer works. Sign in again with a fresh one.' +
          (left.length ? `\n\nNot everything stored could be removed. ${left.join(' ')}` : '')
        )
      }
      await connection.close()
      return undefined
    },
    onDiscardEncrypted: async () => {
      try {
        await session.discardEncrypted()
      } catch (error) {
        return (error as Error).message
      }
      notify('the encrypted credentials file was deleted on request')
      return undefined
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
              settings = await updateSettings((current) => ({ ...current, ...ports }))
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
    noticeDismissed: () => settings.noticeDismissed === true,
    onDismissNotice: async () => {
      settings = { ...settings, noticeDismissed: true }
      try {
        settings = await updateSettings((current) => ({ ...current, noticeDismissed: true }))
      } catch (error) {
        // Worth a line, not worth failing over: the notice is hidden for this
        // run either way, and the next start simply shows it again.
        notify(`the dismissed notice could not be remembered: ${(error as Error).message}`)
      }
    },
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

  // Follows the shared settings file, whichever server wrote it. Ports set in
  // the environment stay as they are; a raised sign-in counter means the
  // credentials changed through the interface, possibly in another server.
  const stopWatching = watchSettings((next) => {
    settings = next
    let reconnect = false
    if (!explicitPorts.imapPort && next.imapPort !== undefined && next.imapPort !== config.imapPort) {
      config.imapPort = next.imapPort
      reconnect = true
    }
    if (!explicitPorts.smtpPort && next.smtpPort !== undefined && next.smtpPort !== config.smtpPort) {
      config.smtpPort = next.smtpPort
      reconnect = true
    }
    const generation = next.credentialsGeneration ?? 0
    if (generation !== knownGeneration) {
      knownGeneration = generation
      session.reloadShared()
      reconnect = true
    }
    if (reconnect) void connection.close()
    refreshInstance()
    applyLevels()
  })

  // Messages waiting for confirmation are shown by this server itself, on a
  // port of its own: they are held in its memory and nowhere else.
  const preview = new PreviewServer({ getPending: (digest) => pendingView(digest), notify })
  try {
    await preview.start()
  } catch (error) {
    notify(`messages waiting for confirmation cannot be previewed: ${(error as Error).message}`)
  }
  setPreviewBase((digest) => preview.urlFor(digest))

  // Every tool answer about a missing sign-in names this address, so the model
  // sends the user there instead of asking for the password in the chat.
  setSignInHint(() => (web.reachable ? web.url : undefined))
  // So that a tool called while an encrypted file is still closed says what is
  // actually missing: the master password, not the Bridge password.
  setLockedCheck(() => session.locked())

  let webUrl: string | undefined
  try {
    webUrl = await web.start()
    if (web.running) notify(`web interface at ${webUrl}`)
    else if (web.reachable) notify(`web interface at ${webUrl}, served by another running proton-mcp`)
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
        // Travels with every connection, so it costs context on every session.
        // It names only what a model would otherwise get wrong before it had a
        // reason to look anything up; the detail lives in the resources.
        instructions: INSTRUCTIONS,
      },
    )
    // Every tool is recorded as it is registered, so its level can show or hide
    // it later. The SDK tells the client whenever that changes the list, and
    // refuses a call to a tool that is switched off.
    const tools = new Map<string, RegisteredTool>()
    const register = server.registerTool.bind(server) as (...args: unknown[]) => RegisteredTool
    ;(server as unknown as { registerTool: (...args: unknown[]) => RegisteredTool }).registerTool = (
      ...args: unknown[]
    ) => {
      const tool = register(...args)
      tools.set(String(args[0]), tool)
      registeredNames.add(String(args[0]))
      return tool
    }

    registerGuidance(server)
    registerUpdateTool(server, VERSION)
    // Handed nothing but the server: it answers filter requests without
    // touching the Bridge, so there is no connection it could use.
    registerFilterTool(server)
    // Through the browser extension (#59). The account is the one signed in
    // here, so the extension can refuse a Proton page of another account.
    registerBrowserFilterTools(server, {
      getCredentials: () => session.credentials(),
      permissions,
    })
    registerListFolders(server, connection)
    registerMessageTools(server, connection)
    registerSavedAttachmentTools(server, connection, saved)
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
      permissions,
      record: recordInForce,
    })
    registerInterfaceTool(server, {
      url: () => web.url,
      running: () => web.running,
      reachable: () => web.reachable,
      pinSet: () => settings.pin !== undefined,
      signedIn: () => session.signedIn,
      address: () => session.address,
      storeKind: () => session.storeKind,
      locked: () => session.locked(),
    })

    applyLevels = () => {
      for (const [name, tool] of tools) {
        const off = permissions.level(name) === 'off'
        const enabled = (tool as { enabled?: boolean }).enabled !== false
        if (off && enabled) tool.disable()
        else if (!off && !enabled) tool.enable()
      }
    }
    applyLevels()
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

    // Let running tool calls finish their work. Their answer no longer goes
    // out, because the SDK closes the transport once the input ends, but a
    // message being handed to the Bridge is not cut off halfway. Bounded, so
    // that a stuck call cannot prevent shutdown.
    const idle = await waitForIdle(5000)
    if (!idle) notify('shutdown forced, a call was still running.')

    try {
      saved.stop()
      stopWatching()
      instance.remove()
      await web.stop()
      await preview.stop()
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

// One more thing the same command does, so that nobody has to install a second
// package: setting up the helper Chrome starts for the browser extension (#59).
// Everything else is the server.
if (process.argv[2] === 'setup-browser') {
  const { setupBrowser } = await import('./browser/setup.js')
  process.exit(setupBrowser({ remove: process.argv.includes('--remove') }))
} else {
  void main()
}
