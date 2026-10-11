import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAddGenericPasswordLine, KeychainService } from './keychain.js'

/** A stand-in `security` that appends its argv and stdin to a log; never the real Keychain. */
function fakeSecurity(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'yomi-keychain-'))
  const bin = join(dir, 'security')
  const log = join(dir, 'log')
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf 'ARGV %s\\n' "$*" >> '${log}'\nif [ "$1" = "-i" ]; then cat >> '${log}'; fi\n`,
  )
  chmodSync(bin, 0o755)
  return { bin, log }
}

test('quotes values for the security -i parser', () => {
  expect(buildAddGenericPasswordLine('svc', 'line', 'a"b\\c d')).toBe(
    'add-generic-password -U -s "svc" -a "line" -w "a\\"b\\\\c d"\n',
  )
  expect(buildAddGenericPasswordLine('svc', 'line', 'x\ny')).toBeNull()
  const long = 'x'.repeat(5000)
  expect(buildAddGenericPasswordLine('svc', 'line', long)).toBeNull()
})

test('the credential blob goes on stdin, never on argv, and without -A', async () => {
  const { bin, log } = fakeSecurity()
  const blob = JSON.stringify({ line_auth_token: 'DUMMY-AUTH "quoted"' })
  const result = await new KeychainService(bin).setCredential('line', blob)
  expect(result.success).toBe(true)
  const lines = readFileSync(log, 'utf8').split('\n')
  expect(lines[0]).toBe('ARGV -i')
  expect(lines.filter((l) => l.startsWith('ARGV')).join()).not.toContain(
    'DUMMY-AUTH',
  )
  const expected = buildAddGenericPasswordLine(
    'dev.rikai.yomi.credentials',
    'line',
    blob,
  )
  expect(lines[1]).toBe(expected?.trimEnd())
  expect(lines[1]).not.toContain(' -A')
})

test('an oversize blob is not spawned on argv; the stale item is removed', async () => {
  const { bin, log } = fakeSecurity()
  const blob = `SECRET${'x'.repeat(5000)}`
  const result = await new KeychainService(bin).setCredential('line', blob)
  expect(result.success).toBe(false)
  const text = readFileSync(log, 'utf8')
  expect(text).not.toContain('SECRET')
  expect(text).toContain('ARGV delete-generic-password')
})
