import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the index at a throwaway file before store.ts reads its path.
process.env.YOMI_INDEX_DB_PATH = join(
  mkdtempSync(join(tmpdir(), 'yomi-index-')),
  'index.db',
)
const { getDb } = await import('./store.js')
const { addExcludedChatIds, deleteMessagesForChats } = await import(
  './scope.js'
)
const { collectMessages } = await import('./collector.js')

/** exclude_chats, as the MCP handler runs it: denylist, then purge. */
function excludeChat(chatId: string) {
  addExcludedChatIds([chatId])
  deleteMessagesForChats([chatId])
}

/** Just enough of LineProtocolService for collectMessages; names come from cache. */
function fakeService(onFetch: (chatId: string) => void) {
  return {
    profile: { mid: 'u-self', displayName: 'Me' },
    nameCache: new Map([
      ['u-a', 'A'],
      ['u-b', 'B'],
      ['u-c', 'C'],
      ['u-peer', 'Peer'],
    ]),
    chatCache: new Map(),
    async getRecentMessages(chatId: string) {
      onFetch(chatId)
      return [{ id: `${chatId}-1`, from: 'u-peer', text: 'hi', createdTime: 1 }]
    },
  } as any
}

function rowsFor(table: 'messages' | 'embeddings', messageId: string): number {
  const sql = `SELECT COUNT(*) as c FROM ${table} WHERE messageId = ?`
  return getDb().prepare<{ c: number }>(sql).get(messageId)?.c ?? 0
}

test('a chat excluded while collection is in flight is not written back', async () => {
  // exclude_chats lands during the fetch for u-b, after collectMessages took
  // its denylist snapshot and after the purge had nothing to remove.
  const service = fakeService((chatId) => {
    if (chatId === 'u-b') {
      excludeChat('u-b')
    }
  })
  await collectMessages(service, { chatIds: ['u-a', 'u-b'] })
  expect(rowsFor('messages', 'u-a-1')).toBe(1)
  expect(rowsFor('messages', 'u-b-1')).toBe(0)
})

test('a chat excluded while its messages embed gets no vectors', async () => {
  const embedder = {
    modelLabel: 'test-model',
    async embed(texts: string[]) {
      excludeChat('u-c')
      return texts.map(() => [1, 0])
    },
  }
  await collectMessages(fakeService(() => {}), {
    chatIds: ['u-c'],
    embedder,
  })
  expect(rowsFor('messages', 'u-c-1')).toBe(0)
  expect(rowsFor('embeddings', 'u-c-1')).toBe(0)
})
