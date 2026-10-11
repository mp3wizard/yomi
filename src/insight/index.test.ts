import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the index at a throwaway file before store.ts reads its path.
process.env.YOMI_INDEX_DB_PATH = join(
  mkdtempSync(join(tmpdir(), 'yomi-index-')),
  'index.db',
)
const { upsertEmbeddings, upsertMessages } = await import(
  '../search/store.js'
)
const { computeInsights } = await import('./index.js')

const embedder = { modelLabel: 'insight-test', embed: async () => [] }

function seed(chatId: string, messageId: string, createdTime: number) {
  upsertMessages([
    {
      chatId,
      chatName: chatId,
      messageId,
      fromMid: 'u-hub',
      fromName: 'Hub Person',
      text: `hello ${messageId}`,
      createdTime,
    },
  ])
  upsertEmbeddings([{ messageId, vector: [1, 0] }], embedder.modelLabel)
}

test('excluded chats feed neither connectors nor the window', () => {
  // u-hub speaks in two chats, which makes them a connector, but one of the
  // two chats is excluded.
  seed('c-open', 'm1', 1_000)
  seed('c-excluded', 'm2', 2_000)
  const base = { selfMid: 'u-self', embedder }

  const all = computeInsights(base)
  expect(all.connectors.map((c) => c.name)).toContain('Hub Person')
  expect(all.window.messages).toBe(2)

  const scoped = computeInsights({
    ...base,
    excludedChatIds: new Set(['c-excluded']),
  })
  expect(scoped.connectors).toEqual([])
  expect(scoped.window.messages).toBe(1)
  expect(scoped.window.toMs).toBe(1_000)
})
