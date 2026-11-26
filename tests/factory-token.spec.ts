/** The rules of the token file the `/assess` route shares with the factory, on a temporary folder. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SharedTokenFile } from '../src/factory/token.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-'
let folder = ''
/** Writes a token file with the given content and mode, and returns what the route would read from it. */
function read(content: string, mode = 0o600): string | undefined {
  const path = join(folder, 'token')
  rmSync(path, { force: true })
  writeFileSync(path, content)
  // Set after writing: the mode given to writeFileSync is cut down by the umask.
  chmodSync(path, mode)
  return new SharedTokenFile(path).read()
}

beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'factory-token-')) })
afterEach(() => { rmSync(folder, { recursive: true, force: true }) })

it('reads the token of an owner-only file, with or without an ending line break, again on every call', () => {
  expect(read(TOKEN)).toBe(TOKEN)
  expect(read(`${TOKEN}\n`)).toBe(TOKEN)
  expect(read(TOKEN, 0o400)).toBe(TOKEN)
  expect(read('a'.repeat(32))).toBe('a'.repeat(32))
  const file = new SharedTokenFile(join(folder, 'token'))
  expect(file.read()).toBe('a'.repeat(32))
  writeFileSync(file.path, 'b'.repeat(40))
  expect(file.read()).toBe('b'.repeat(40))
})

it('has no token when the file is missing, a symlink, a folder, or usable by the group or by others', () => {
  expect(new SharedTokenFile(join(folder, 'missing')).read()).toBeUndefined()
  expect(read(TOKEN)).toBe(TOKEN)
  symlinkSync(join(folder, 'token'), join(folder, 'link'))
  expect(new SharedTokenFile(join(folder, 'link')).read()).toBeUndefined()
  mkdirSync(join(folder, 'directory'), { mode: 0o700 })
  expect(new SharedTokenFile(join(folder, 'directory')).read()).toBeUndefined()
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o601]) expect([mode, read(TOKEN, mode)]).toEqual([mode, undefined])
})

it('has no token when the file does not hold exactly one token', () => {
  const contents = ['', '\n', 'a'.repeat(31), `${'a'.repeat(31)}\n`, `${TOKEN} `, ` ${TOKEN}`, `${TOKEN}\n\n`, `${TOKEN}\r\n`, `${TOKEN}\n${TOKEN}`,
    `${'a'.repeat(31)}+`, `${'a'.repeat(31)}/`, `${'a'.repeat(31)}é`, 'a'.repeat(5000)]
  for (const content of contents) expect([content, read(content)]).toEqual([content, undefined])
})

it('compares two tokens as equal only when they are the same', () => {
  expect(SharedTokenFile.same(TOKEN, TOKEN)).toBe(true)
  expect(SharedTokenFile.same(TOKEN, `${TOKEN.slice(0, -1)}x`)).toBe(false)
  expect(SharedTokenFile.same(TOKEN, TOKEN.slice(0, -1))).toBe(false)
  expect(SharedTokenFile.same(TOKEN, `${TOKEN}a`)).toBe(false)
  expect(SharedTokenFile.same(TOKEN, '')).toBe(false)
})

it('keeps the default file outside every project and names the header the factory uses', () => {
  expect(SharedTokenFile.DEFAULT_PATH.endsWith('/.config/zees-factory/superagent-token')).toBe(true)
  expect(SharedTokenFile.HEADER).toBe('x-factory-token')
})
