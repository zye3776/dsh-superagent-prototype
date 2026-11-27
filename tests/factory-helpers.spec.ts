/** The judge's helpers (story 2.25): how one helper is run, timed, stopped and read, with a stand-in spawner and, for the process group, with Node itself. */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HelperRunner, NodeSpawner, type HelperCommandBuilder, type HelperJob } from '../src/factory/helpers.ts'
import { claudeOutput, codexOutput, fakeSpawner, type FakeRun } from './fixtures/judge.ts'

const COMMAND: HelperCommandBuilder = {
  claude: (model = 'haiku') => ({ argv: ['claude', '-p', '--model', model], settings: {} }),
  codexMcpListArgv: () => ['codex', 'mcp', 'list', '--json'],
  mcpNames: stdout => { try { const parsed = JSON.parse(stdout) as unknown; return Array.isArray(parsed) ? parsed.map(item => String((item as { name: unknown }).name)) : null } catch { return null } },
  codex: names => ['codex', 'exec', ...names, '-'],
  prompt: (question, text) => text === undefined ? question : `${question}\n${text}`,
}

let project = ''
beforeEach(() => { project = mkdtempSync(join(tmpdir(), 'factory-helpers-')) })
afterEach(() => { rmSync(project, { recursive: true, force: true }); vi.useRealTimers() })

/** A job for `project` that every read check allows, unless one is given. */
const job = (args: HelperJob['args'], deadline: number, readAllowed: HelperJob['readAllowed'] = () => true, signal?: AbortSignal): HelperJob =>
  ({ args, project, deadline, readAllowed, ...signal === undefined ? {} : { signal } })
const runner = (answer: (argv: readonly string[]) => FakeRun, now: () => number = Date.now) => {
  const fake = fakeSpawner(argv => answer(argv))
  return { fake, runner: new HelperRunner(COMMAND, fake.spawner, now) }
}

describe('HelperRunner', () => {
  it('kills a helper that never exits at its deadline and gives no evidence and no reads', async () => {
    const { fake, runner: helpers } = runner(() => 'hang')
    const result = await helpers.run(job({ engine: 'claude', question: 'q' }, Date.now() + 30))
    expect(result).toEqual({ text: 'The helper gave no evidence (it ran past its time limit and was stopped). Decide without it.', reads: [], evidence: false })
    expect(fake.starts.map(start => start.killed)).toEqual([true])
  })

  it('gives each helper at most 15 seconds from its own start, even when the question leaves more', async () => {
    vi.useFakeTimers()
    const { fake, runner: helpers } = runner(() => 'hang', () => 1_000)
    const result = helpers.run(job({ engine: 'claude', question: 'q' }, 1_000 + 20_000))
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fake.starts[0]!.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.starts[0]!.killed).toBe(true)
    expect((await result).evidence).toBe(false)
  })

  it('starts nothing when no time is left or the question was already answered', async () => {
    const { fake, runner: helpers } = runner(() => ({ code: 0, stdout: claudeOutput('a') }))
    expect((await helpers.run(job({ engine: 'claude', question: 'q' }, Date.now() - 1))).text).toMatch(/no time was left/)
    const stopped = new AbortController()
    stopped.abort()
    expect((await helpers.run(job({ engine: 'claude', question: 'q' }, Date.now() + 5_000, () => true, stopped.signal))).text).toMatch(/answered before it started/)
    expect(fake.starts).toEqual([])
  })

  it('returns a Claude helper\'s answer and the full paths of what it read: Read paths, and Grep and Glob paths, which default to the project', async () => {
    const { runner: helpers } = runner(() => ({ code: 0, stdout: claudeOutput('found it', [
      { name: 'Read', input: { file_path: 'src/a.ts' } }, { name: 'Grep', input: { pattern: 'x' } }, { name: 'Glob', input: { pattern: '*', path: '/elsewhere' } },
      { name: 'Read', input: { file_path: 'src/a.ts' } }]) }))
    const checked: unknown[] = []
    const result = await helpers.run(job({ engine: 'claude', question: 'q' }, Date.now() + 5_000, call => { checked.push(call); return true }))
    expect(result).toEqual({ text: 'found it', reads: [join(project, 'src', 'a.ts'), project, '/elsewhere'], evidence: true })
    expect(checked).toEqual([{ name: 'read', arguments: { file_path: 'src/a.ts' } }, { name: 'glob', arguments: { path: project } },
      { name: 'glob', arguments: { path: '/elsewhere' } }, { name: 'read', arguments: { file_path: 'src/a.ts' } }])
  })

  it('gives no evidence for a refused read, a failed run, an answer it cannot read, or a tool a helper should not have', async () => {
    const cases: [FakeRun, RegExp, ((call: unknown) => boolean)?][] = [
      [{ code: 0, stdout: claudeOutput('a', [{ name: 'Read', input: { file_path: '.env' } }]) }, /secret list/, () => false],
      [{ code: 1, stdout: claudeOutput('a') }, /ended with an error/],
      [{ code: 0, stdout: 'not json' }, /could not be read/],
      [{ code: 0, stdout: JSON.stringify([{ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'x' }]) }, /could not be read/],
      [{ code: 0, stdout: claudeOutput('a', [{ name: 'Bash', input: { command: 'ls' } }]) }, /could not be read/],
      [{ code: 0, stdout: claudeOutput('a', [{ name: 'Read', input: { file_path: 7 } }]) }, /could not be read/],
      ['missing', /^The claude helper is unavailable \(the claude program was not found\)/],
    ]
    for (const [run, why, allowed] of cases) {
      const { runner: helpers } = runner(() => run)
      const result = await helpers.run(job({ engine: 'claude', question: 'q' }, Date.now() + 5_000, allowed))
      expect(result.text, JSON.stringify(run)).toMatch(why)
      expect([result.reads, result.evidence]).toEqual([[], false])
    }
  })

  it('gives no evidence for a lone result object, whose reads cannot be checked, and caps an answer at 6000 characters', async () => {
    const long = 'x'.repeat(7_000)
    const lone = runner(() => ({ code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: long }) }))
    const unread = await lone.runner.run(job({ engine: 'claude', question: 'q' }, Date.now() + 5_000))
    expect([unread.text, unread.evidence]).toEqual(['The helper gave no evidence (its answer could not be read). Decide without it.', false])
    const { runner: helpers } = runner(() => ({ code: 0, stdout: claudeOutput(long) }))
    const result = await helpers.run(job({ engine: 'claude', question: 'q' }, Date.now() + 5_000))
    expect(result.text).toBe(`${'x'.repeat(6_000)}\n[cut at 6000 characters]`)
  })

  it('checks a Glob pattern or Grep glob that starts with / or ~ as a path, and gives no evidence when it names a secret place', async () => {
    for (const call of [{ name: 'Glob', input: { pattern: '/Users/x/.ssh/*' } }, { name: 'Grep', input: { pattern: 'k', glob: '~/.ssh/*' } }]) {
      const { runner: helpers } = runner(() => ({ code: 0, stdout: claudeOutput('found keys', [call]) }))
      const checked: unknown[] = []
      const result = await helpers.run(job({ engine: 'claude', question: 'q' }, Date.now() + 5_000, item => {
        checked.push(item)
        return !JSON.stringify(item).includes('.ssh')
      }))
      expect([result.text, result.reads, result.evidence]).toEqual(['The helper gave no evidence (it tried to read a file on the secret list). Decide without it.', [], false])
      expect(checked).toContainEqual({ name: 'glob', arguments: { path: (call.input as { pattern?: string; glob?: string }).glob ?? call.input.pattern } })
    }
    // A relative pattern stays within the searched path, which is checked already.
    const { runner: helpers } = runner(() => ({ code: 0, stdout: claudeOutput('ok', [{ name: 'Glob', input: { pattern: '**/*.ts' } }]) }))
    expect((await helpers.run(job({ engine: 'claude', question: 'q' }, Date.now() + 5_000))).evidence).toBe(true)
  })

  it('runs a Codex helper in a fresh empty folder with its MCP servers named, and reads its agent messages', async () => {
    const { fake, runner: helpers } = runner(argv => argv[1] === 'mcp' ? { code: 0, stdout: '[{"name":"one"}]' } : { code: 0, stdout: codexOutput('it is safe') })
    const result = await helpers.run(job({ engine: 'codex', question: 'q', text: 'echo hi' }, Date.now() + 5_000))
    expect(result).toEqual({ text: 'it is safe', reads: [], evidence: true })
    expect(fake.starts.map(start => start.argv)).toEqual([['codex', 'mcp', 'list', '--json'], ['codex', 'exec', 'one', '-']])
    expect(fake.starts[1]!.input).toBe('q\necho hi')
    expect(fake.starts[0]!.cwd).not.toBe(project)
    expect(HelperRunner.codexOutput('{"type":"turn.started"}\n')).toBeUndefined()
    expect(HelperRunner.codexOutput('garbage\n')).toBeUndefined()
  })

  it('gives no evidence when codex exec exits with an error, even with an answer printed', async () => {
    const { runner: helpers } = runner(argv => argv[1] === 'mcp' ? { code: 0, stdout: '[]' } : { code: 1, stdout: codexOutput('it is safe') })
    const result = await helpers.run(job({ engine: 'codex', question: 'q', text: 't' }, Date.now() + 5_000))
    expect(result).toEqual({ text: 'The helper gave no evidence (it ended with an error). Decide without it.', reads: [], evidence: false })
  })

  it('gives a Codex helper without text, or whose servers cannot be listed, no run', async () => {
    const { fake, runner: helpers } = runner(() => ({ code: 0, stdout: 'null' }))
    expect((await helpers.run(job({ engine: 'codex', question: 'q' }, Date.now() + 5_000))).text).toMatch(/needs the text/)
    expect((await helpers.run(job({ engine: 'codex', question: 'q', text: 't' }, Date.now() + 5_000))).text).toMatch(/could not be turned off, and it was not started/)
    expect(fake.starts.map(start => start.argv[1])).toEqual(['mcp'])
  })
})

/** A child process stand-in for `NodeSpawner`: it never exits unless told to. */
class FakeChild extends EventEmitter {
  readonly pid = 4242
  readonly stdout = new PassThrough()
  readonly stdin = new PassThrough()
  readonly kill = vi.fn()
}

describe('NodeSpawner', () => {
  it('starts the helper as its own process group and kills the whole group with SIGKILL', () => {
    const child = new FakeChild()
    const signals: [number, string][] = []
    const spawnOf = vi.fn(() => child as never)
    const started = new NodeSpawner(spawnOf, (pid, signal) => { signals.push([pid, signal]) }).start(['claude', '-p'], { cwd: project, input: 'q', maxBytes: 10 })
    expect(spawnOf).toHaveBeenCalledWith('claude', ['-p'], { cwd: project, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    started.kill()
    expect(signals).toEqual([[-4242, 'SIGKILL']])
  })

  it('kills the group once the output passes the cap, and says so', async () => {
    const child = new FakeChild()
    const signals: number[] = []
    const started = new NodeSpawner(() => child as never, pid => { signals.push(pid) }).start(['claude'], { cwd: project, input: '', maxBytes: 4 })
    child.stdout.emit('data', Buffer.from('12345'))
    child.emit('close', null)
    expect(await started.done).toEqual({ code: null, stdout: '', overflow: true })
    expect(signals).toEqual([-4242])
  })

  it('says a program is missing when it is not on the PATH', async () => {
    const started = new NodeSpawner().start(['factory-no-such-program-25'], { cwd: project, input: '', maxBytes: 100 })
    expect((await started.done).failure).toBe('missing')
  })

  it('hands the input to a real process and reads its output, and a real kill ends a process that would run on', async () => {
    const echo = new NodeSpawner().start([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], { cwd: project, input: 'hello', maxBytes: 100 })
    expect(await echo.done).toEqual({ code: 0, stdout: 'hello', overflow: false })
    const sleeper = new NodeSpawner().start([process.execPath, '-e', 'setTimeout(() => {}, 60_000)'], { cwd: project, input: '', maxBytes: 100 })
    sleeper.kill()
    expect((await sleeper.done).code).toBeNull()
  })
})
