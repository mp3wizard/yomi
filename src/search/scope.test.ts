import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the index at a throwaway file before store.ts reads its path.
process.env.YOMI_INDEX_DB_PATH = join(
  mkdtempSync(join(tmpdir(), 'yomi-index-')),
  'index.db',
)
const { getDb, upsertMessages } = await import('./store.js')
const { deleteMessagesForChats } = await import('./scope.js')

function row(chatId: string, messageId: string) {
  return {
    chatId,
    chatName: chatId,
    messageId,
    fromMid: 'u-peer',
    fromName: 'Peer',
    text: `secret ${messageId}`,
    createdTime: 1,
  }
}

function countIn(chatId: string): number {
  const sql = 'SELECT COUNT(*) as c FROM messages WHERE chatId = ?'
  return getDb().prepare<{ c: number }>(sql).get(chatId)?.c ?? 0
}

test('purging a chat deletes its rows and reports what was deleted', () => {
  upsertMessages([
    row('c-purge', 'p1'),
    row('c-purge', 'p2'),
    row('c-keep', 'k1'),
  ])
  expect(deleteMessagesForChats(['c-purge'])).toBe(2)
  expect(countIn('c-purge')).toBe(0)
  expect(countIn('c-keep')).toBe(1)
  // Nothing left to delete: a repeat purge must not claim success again.
  expect(deleteMessagesForChats(['c-purge'])).toBe(0)
})
