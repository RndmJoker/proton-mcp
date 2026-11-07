import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebInterface } from '../../src/web/server.js'

/**
 * One fixed address, shared by every running server.
 *
 * The first server serves the interface. A second one finds the port taken by a
 * proton-mcp, serves nothing itself and points at the same address, and takes
 * the port over once the first one stops. A port held by some other program is
 * a different story the user has to hear about, and one held by an older
 * proton-mcp, from before the shared interface, a third with its own remedy.
 */

const started: Array<WebInterface | Server> = []

afterEach(async () => {
  for (const item of started.splice(0)) {
    if (item instanceof WebInterface) await item.stop()
    else await new Promise<void>((resolve) => item.close(() => resolve()))
  }
})

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

function build(port: number, notes: string[] = []): WebInterface {
  const web = new WebInterface({
    port,
    takeoverIntervalMs: 50,
    onSignIn: async () => undefined,
    onSignOut: async () => undefined,
    getStatus: async () => ({ connected: false, bridgeHost: '127.0.0.1', bridgeImapPort: 1143, bridgeSmtpPort: 1025 }),
    notify: (message) => notes.push(message),
  })
  started.push(web)
  return web
}

/** Starts a program on the port that answers every request with the given page. */
async function occupy(port: number, status: number, page: string): Promise<void> {
  const occupant = createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(page)
  })
  await new Promise<void>((resolve) => occupant.listen(port, '127.0.0.1', resolve))
  started.push(occupant)
}

/**
 * What proton-mcp 0.4.13 answers to /health: it has no such address and
 * answers a request without its token with this page, head as it renders it.
 * The style is padding to the few kilobytes the real page has, all of which
 * arrives in one piece.
 */
const OLDER_PAGE =
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<meta name="robots" content="noindex, nofollow">\n' +
  '<title>Not available - proton-mcp</title>\n' +
  `<style>${'body { margin: 0 } '.repeat(200)}</style>\n` +
  '</head>\n<body><h1>Not available</h1></body>\n</html>\n'

describe('the shared address', () => {
  it('lets the second server point at the first one instead of moving to another port', async () => {
    const port = await freePort()
    const first = build(port)
    const second = build(port)
    expect(await first.start()).toBe(`http://127.0.0.1:${port}/`)
    expect(await second.start()).toBe(`http://127.0.0.1:${port}/`)
    expect(first.running).toBe(true)
    expect(second.running).toBe(false)
    expect(second.reachable).toBe(true)
    expect(second.occupant).toBe('proton-mcp')
  })

  it('is taken over when the server that served it stops', async () => {
    const port = await freePort()
    const first = build(port)
    const second = build(port)
    await first.start()
    await second.start()
    await first.stop()
    for (let i = 0; i < 40 && !second.running; i++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(second.running).toBe(true)
  })

  it('reports a port held by another program instead of pretending all is well', async () => {
    const port = await freePort()
    const stranger = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('not proton-mcp')
    })
    await new Promise<void>((resolve) => stranger.listen(port, '127.0.0.1', resolve))
    started.push(stranger)

    const web = build(port)
    await web.start()
    expect(web.running).toBe(false)
    expect(web.reachable).toBe(false)
    expect(web.occupant).toBe('other')
  })

  it('recognises an older proton-mcp on the port instead of calling it a stranger', async () => {
    expect(OLDER_PAGE.length).toBeGreaterThan(3000)
    const port = await freePort()
    await occupy(port, 404, OLDER_PAGE)
    expect(await WebInterface.probe(port)).toBe('older')

    const notes: string[] = []
    const web = build(port, notes)
    await web.start()
    expect(web.running).toBe(false)
    expect(web.reachable).toBe(false)
    expect(web.occupant).toBe('older')
    const said = notes.join('\n')
    expect(said).toContain('held by an older proton-mcp, from a session started before the update')
    expect(said).toContain('restarting the sessions that still run the older version')
    expect(said).not.toContain('not proton-mcp')
    expect(said).not.toContain('PROTON_MCP_WEB_PORT')
  })

  it('does not take a page for an older proton-mcp because its text mentions one', async () => {
    const port = await freePort()
    await occupy(port, 200, '<html><head><title>Dashboard</title></head><body>proton-mcp - proton-mcp</body></html>')
    expect(await WebInterface.probe(port)).toBe('other')
  })

  it('tells who is on a port without trusting anything but its own answer', async () => {
    const port = await freePort()
    expect(await WebInterface.probe(port)).toBe('none')
    const web = build(port)
    await web.start()
    expect(await WebInterface.probe(port)).toBe('proton-mcp')
  })
})
