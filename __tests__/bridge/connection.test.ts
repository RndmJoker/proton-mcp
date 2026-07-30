import { describe, it, expect } from 'vitest'
import { determineKind, isLocal } from '../../src/bridge/connection.js'

describe('determineKind', () => {
  it('recognises system mailboxes', () => {
    for (const p of ['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash', 'All Mail', 'Starred']) {
      expect(determineKind(p)).toBe('system')
    }
  })

  it('recognises user folders including nesting', () => {
    expect(determineKind('Folders')).toBe('folder')
    expect(determineKind('Folders/Receipts')).toBe('folder')
    expect(determineKind('Folders/Receipts/Invoices')).toBe('folder')
  })

  it('recognises labels', () => {
    expect(determineKind('Labels')).toBe('label')
    expect(determineKind('Labels/Important')).toBe('label')
  })

  it('is not fooled by names that merely start alike', () => {
    // A system mailbox called "Foldersomething" would not be a user folder.
    expect(determineKind('Foldersomething')).toBe('system')
    expect(determineKind('Labelsomething')).toBe('system')
  })
})

describe('isLocal', () => {
  it('recognises the addresses that keep traffic on this machine', () => {
    expect(isLocal('127.0.0.1')).toBe(true)
    expect(isLocal('::1')).toBe(true)
    expect(isLocal('localhost')).toBe(true)
  })

  it('treats everything else as not local', () => {
    // This decides whether certificate verification stays on.
    expect(isLocal('192.168.1.10')).toBe(false)
    expect(isLocal('bridge.example.com')).toBe(false)
    expect(isLocal('127.0.0.2')).toBe(false)
  })
})
