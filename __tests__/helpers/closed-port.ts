import { createServer, type AddressInfo } from 'node:net'

/**
 * A port on 127.0.0.1 where nothing listens.
 *
 * Taken from the operating system on port 0 and released again, so it is free
 * without being one of the Bridge's ports. Connecting to it is refused at once.
 */
export async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
