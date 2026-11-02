/**
 * The parts of a stored message, read so that they can be built into a message
 * again unchanged.
 *
 * mailparser is the wrong tool for this, measured with mailparser 3.14.1. It
 * descends into a forwarded original (message/rfc822) and writes it into the
 * body as a table of its headers, so the original disappears from the
 * attachments and turns up as markup nobody wrote. And it rewrites every cid:
 * image into a data: address, which the markup check refuses at every level. A
 * stored draft read back that way could not be sent as it was stored.
 *
 * mailsplit, the splitter mailparser itself is built on, keeps a forwarded
 * original as one part when asked to and hands out the bytes of every part.
 * The body here is the first text/plain and the first text/html part that is
 * not an attachment; everything else is a file, carried along as it was.
 */

import { Splitter } from '@zone-eu/mailsplit'
import type { MimeNode, SplitterChunk } from '@zone-eu/mailsplit/lib/types.js'
import libmime from 'libmime'
import type { Readable, Transform } from 'node:stream'
import { isProtonPublicKey } from './parse.js'

/** A file inside a stored message, with its content. */
export interface CarriedFile {
  filename: string
  contentType: string
  content: Buffer
  /** Set when the markup refers to the file by cid. */
  contentId?: string
}

export interface StoredParts {
  /** The plain text body, when there is one. */
  text?: string
  /** The markup body, with its cid: references as they were. */
  html?: string
  /** Every other part, in the order the message carries them. */
  files: CarriedFile[]
}

/** Runs bytes through a stream and collects what comes out. */
async function through(stream: Transform, chunks: Buffer[]): Promise<Buffer> {
  const out: Buffer[] = []
  const done = (async () => {
    for await (const chunk of stream as Readable) out.push(Buffer.from(chunk as Buffer))
  })()
  for (const chunk of chunks) stream.write(chunk)
  stream.end()
  await done
  return Buffer.concat(out)
}

async function asText(node: MimeNode, decoded: Buffer): Promise<string> {
  const text = (await through(libmime.createDecodeStream(node.charset || 'utf-8'), [decoded])).toString(
    'utf8',
  )
  return node.flowed ? libmime.decodeFlowed(text, node.delSp) : text
}

/** Splits the message into its nodes, each with the raw bytes of its body. */
async function split(source: Buffer): Promise<Array<{ node: MimeNode; body: Buffer[] }>> {
  // ignoreEmbedded keeps a forwarded original as one part instead of
  // descending into it, which is the whole reason this module exists.
  const splitter = new Splitter({ ignoreEmbedded: true })
  const nodes: Array<{ node: MimeNode; body: Buffer[] }> = []
  let current: { node: MimeNode; body: Buffer[] } | undefined

  const done = (async () => {
    for await (const chunk of splitter as unknown as AsyncIterable<SplitterChunk>) {
      if (chunk.type === 'node') {
        current = { node: chunk, body: [] }
        nodes.push(current)
      } else if (chunk.type === 'body' && current && chunk.value) {
        current.body.push(Buffer.from(chunk.value))
      }
    }
  })()
  splitter.end(source)
  await done
  return nodes
}

/** Reads a stored message into its body and the files it carries. */
export async function readParts(source: Buffer): Promise<StoredParts> {
  const parts: StoredParts = { files: [] }

  for (const { node, body } of await split(source)) {
    // A multipart node is only a container; its children follow as nodes.
    if (node.multipart) continue

    const contentType = (node.contentType || 'text/plain').toLowerCase()
    const decoded = await through(node.getDecoder() as Transform, body)
    const isBody =
      node.disposition !== 'attachment' &&
      !node.filename &&
      (contentType === 'text/plain' || contentType === 'text/html')

    if (isBody && contentType === 'text/html' && parts.html === undefined) {
      parts.html = await asText(node, decoded)
      continue
    }
    if (isBody && contentType === 'text/plain' && parts.text === undefined) {
      parts.text = await asText(node, decoded)
      continue
    }

    const filename = node.filename || `part-${parts.files.length + 1}`
    // Proton attaches its own key to whatever it sends, so a key carried over
    // from a stored draft would go out twice.
    if (isProtonPublicKey(contentType, filename)) continue

    const id = node.headers ? node.headers.getFirst('content-id').trim() : ''
    const file: CarriedFile = { filename, contentType, content: decoded }
    if (id) file.contentId = id.replace(/^<|>$/g, '')
    parts.files.push(file)
  }

  return parts
}
