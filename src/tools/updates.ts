/**
 * Tool: check_for_updates
 *
 * Asks the npm registry which version is current and compares it with the one
 * running.
 *
 * ## The reason this file has a long comment
 *
 * Everything else in this server talks to `127.0.0.1` and nothing else. That is
 * not an accident of implementation, it is the property the readme leads with:
 * your mail is decrypted on your machine and nothing leaves it. This tool is the
 * single exception, and an exception to a claim like that has to be small,
 * visible and voluntary or it should not exist.
 *
 * So:
 *
 * - **It runs only when called.** No check at startup, no timer, nothing in the
 *   background. A server that phones out on its own schedule is a different
 *   thing from one that answers a question.
 * - **One address, and it is in the source.** `registry.npmjs.org`, over TLS,
 *   for one package name.
 * - **It sends nothing about you.** A GET for a public package. The registry
 *   learns an IP asked about proton-mcp, which is what installing it already
 *   tells them.
 * - **It installs nothing.** A server that replaces its own code is exactly what
 *   you do not want from something holding a mailbox. It says what to run.
 * - **Failure is an answer.** Offline, a proxy, a registry that is down: the
 *   reply says it could not look, not that anything is broken.
 *
 * The tool description states the outgoing connection, so a model can tell the
 * user before calling rather than after.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import { track } from '../in-flight.js'

/** The package this server is published as. */
export const PACKAGE = '@rndmjoker/proton-mcp'

/** Long enough for a slow connection, short enough not to hold a tool call. */
export const LOOKUP_TIMEOUT_MS = 5000

/** Compares two version strings. Returns true when `latest` is newer. */
export function isNewer(latest: string, running: string): boolean {
  const parse = (v: string): number[] =>
    v
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)

  const [a, b] = [parse(latest), parse(running)]
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  // Equal numbers, so a prerelease of that version is older than the release.
  const preLatest = latest.includes('-')
  const preRunning = running.includes('-')
  if (preLatest !== preRunning) return preRunning
  return false
}

export interface UpdateCheck {
  latest?: string
  /** Set when the registry could not be asked. Not an error, an answer. */
  unreachable?: string
}

/**
 * Asks the registry for the version on the `latest` tag.
 *
 * Deliberately not `npm view`: spawning a package manager from a mail server to
 * answer a question is a lot of machinery, and it would inherit whatever
 * registry and proxy configuration happens to be around. One request, one URL.
 */
export async function latestVersion(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<UpdateCheck> {
  const stop = AbortSignal.timeout(timeoutMs)
  try {
    // encodeURIComponent rather than replacing the slash by hand. The hand
    // version worked for this one name, which has exactly one slash, and would
    // have encoded only the first of any others: a correctness that depends on
    // the value never changing. Flagged by CodeQL, and it was right to.
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}/latest`,
      { signal: stop, headers: { accept: 'application/json' } },
    )
    if (!response.ok) {
      return { unreachable: `the registry answered ${response.status}` }
    }
    const body = (await response.json()) as { version?: unknown }
    if (typeof body.version !== 'string') {
      return { unreachable: 'the registry answered something without a version in it' }
    }
    return { latest: body.version }
  } catch (error) {
    return { unreachable: (error as Error).message }
  }
}

/** How to update, which depends on how it was started. */
const HOW =
  'How to update depends on how it was installed, and the ways look identical from the outside:\n' +
  '  - through npx: clear the cache with "npm cache clean --force", since npx will otherwise ' +
  'keep using what it already has\n' +
  '  - installed globally: "npm install -g @rndmjoker/proton-mcp@latest"\n' +
  '  - from a directory: "git pull --ff-only && npm ci && npm run build" in it\n\n' +
  'The whole procedure, including how to tell which case applies, is at\n' +
  'https://raw.githubusercontent.com/RndmJoker/proton-mcp/main/update.md\n\n' +
  '**The client has to be restarted afterwards.** A running server keeps the old code, and ' +
  'nothing about that is visible from the outside, which is the usual reason an update looks ' +
  'like it did not work.'

export function registerUpdateTool(server: McpServer, version: string): void {
  server.registerTool(
    'check_for_updates',
    {
      title: 'Check for a newer version',
      description:
        'Asks the npm registry whether a newer version of this server exists, and reports how to ' +
        'install it. **This is the only thing in this server that connects to anything other than ' +
        'the Proton Mail Bridge on this machine**, so call it when the user asks about updates ' +
        'rather than by habit, and say that it means one request to registry.npmjs.org. It sends ' +
        'nothing about the user or their mail, and it installs nothing: updating is left to the ' +
        'person, deliberately.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      track(async () => {
        const { latest, unreachable } = await latestVersion()

        if (unreachable !== undefined) {
          const answer: CallToolResult = {
            content: [
              {
                type: 'text',
                text:
                  `Running version ${version}. The registry could not be asked, so whether ` +
                  `there is a newer one is unknown: ${unreachable}.\n\n` +
                  'That is not a fault in this server and nothing needs fixing. Trying again ' +
                  'later is the whole remedy.',
              },
            ],
          }
          return answer
        }

        const text = isNewer(latest!, version)
          ? `Version ${latest} is available. This server is running ${version}.\n\n${HOW}\n\n` +
            'What changed is listed at https://github.com/RndmJoker/proton-mcp/releases, one ' +
            'entry per version, and reading the ones in between is more use than the number.'
          : `Running version ${version}, which is the current one. Nothing to do.`

        const answer: CallToolResult = { content: [{ type: 'text', text }] }
        return answer
      }, 'check_for_updates'),
  )
}
