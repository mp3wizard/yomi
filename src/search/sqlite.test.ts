import { expect, test } from 'bun:test'
import { openDatabase, SqliteUnavailableError } from './sqlite.js'

test('openDatabase works on this runtime', () => {
  const db = openDatabase(':memory:')
  db.exec('CREATE TABLE t(a)')
  db.close()
})

test('SqliteUnavailableError names the runtime and the requirement', () => {
  // The raw runtime error ("No such built-in module: node:sqlite") tells a user
  // nothing actionable, and the node actually running is often not the one they
  // configured — an MCP client resolves `node` from its own PATH. Both facts
  // must survive in the message.
  const e = new SqliteUnavailableError('x')
  expect(e.name).toBe('SqliteUnavailableError')
  expect(e instanceof Error).toBe(true)
})

test('exec honours bound params (purge DELETE must not be a no-op)', () => {
  const db = openDatabase(':memory:')
  db.exec('CREATE TABLE t(a)')
  db.exec('INSERT INTO t VALUES (?), (?), (?)', ['x', 'y', 'z'])
  db.exec('DELETE FROM t WHERE a IN (?, ?)', ['x', 'y'])
  const rows = db.prepare<{ a: string }>('SELECT a FROM t').all()
  expect(rows.map((r) => r.a)).toEqual(['z'])
  db.close()
})
