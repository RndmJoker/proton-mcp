#!/usr/bin/env node
/**
 * The connector's entry point (#59): the file the launcher starts when Chrome
 * asks for it on behalf of the Proton MCP Helper extension.
 *
 * It does one thing, start the connector, and decides nothing about whether it
 * should. The first version had no file of its own: host.ts checked whether it
 * was the program being started by comparing its own address with the path it
 * was started under. On Tobi's machine /home is a link to /var/home, so the
 * two were spellings of the same file that never compared equal, and the
 * connector did nothing at all. Chrome showed "Native host has exited", and no
 * test noticed, because the tests run the connector inside their own process.
 * Measured on 06.11.2026.
 */

import { runHost } from './host.js'
import { browserPaths } from './paths.js'

const host = await runHost({
  input: process.stdin,
  output: process.stdout,
  origin: process.argv[2],
  paths: browserPaths(),
  log: (line) => process.stderr.write(`proton-mcp connector: ${line}\n`),
})
await host.done
process.exit(host.failure ? 1 : 0)
