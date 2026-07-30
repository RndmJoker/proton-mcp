import { describe, it, expect } from 'vitest'
import { format } from '../../src/tools/list-folders.js'
import type { Mailbox } from '../../src/bridge/connection.js'

const box = (path: string, kind: Mailbox['kind'], extra: Partial<Mailbox> = {}): Mailbox => ({
  path,
  name: path.split('/').at(-1) ?? path,
  kind,
  selectable: true,
  ...extra,
})

describe('format', () => {
  it('reports an empty result in an understandable way', () => {
    expect(format([])).toBe('No mailboxes found.')
  })

  it('groups by kind and counts', () => {
    const text = format([
      box('INBOX', 'system', { specialUse: '\\Inbox' }),
      box('Folders/Receipts', 'folder'),
      box('Folders/Receipts/Invoices', 'folder'),
      box('Labels/Important', 'label'),
    ])
    expect(text).toContain('## System mailboxes (1)')
    expect(text).toContain('## Folders (2)')
    expect(text).toContain('## Labels (1)')
  })

  it('shows the special-use attribute of system mailboxes', () => {
    expect(format([box('INBOX', 'system', { specialUse: '\\Inbox' })])).toContain('[\\Inbox]')
  })

  it('leaves out containers that cannot hold messages', () => {
    // "Folders" and "Labels" are \Noselect in the Bridge.
    const text = format([
      box('Folders', 'folder', { selectable: false }),
      box('Folders/Work', 'folder'),
    ])
    expect(text).toContain('Folders/Work')
    expect(text).not.toMatch(/^- Folders$/m)
    expect(text).toContain('## Folders (1)')
  })

  it('leaves out a group entirely when it is empty', () => {
    const text = format([box('INBOX', 'system')])
    expect(text).not.toContain('Labels')
    expect(text).not.toContain('## Folders')
  })

  it('does not append blank lines at the end', () => {
    expect(format([box('INBOX', 'system')])).toBe(format([box('INBOX', 'system')]).trimEnd())
  })
})
