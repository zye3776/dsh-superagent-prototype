/**
 * The judge's helpers (story 2.25): short Claude Code and Codex sessions on weaker models, each answering one narrow question for the judge.
 * The judge's `ask_helper` tool calls `HelperRunner.run`; the judge's own shell never starts a helper. Every command line and prompt comes from the factory's
 * `HelperCommand` (in `lib/dist/judgeGuard.js`), so this file adds no flag of its own:
 *   - a Claude helper (`claude -p`) runs in the judged project with only Read, Grep and Glob and a deny rule for every secret path. Its JSON output lists each
 *     tool call; every path it read is checked again with the factory guard (so a link to a secret counts), and its reads are returned for the decision.
 *   - a Codex helper (`codex exec`) runs in a fresh empty folder, removed afterwards, with every MCP server turned off by name and no file or shell tool. It
 *     answers only from the text the judge handed it. When its MCP servers cannot be listed, it is not started.
 * Each helper is killed (its whole process group, SIGKILL) at its deadline, which the judge sets. A helper that was killed, failed, printed what cannot be read,
 * printed more than `MAX_OUTPUT_BYTES` or read a file on the secret list gives the judge a "no evidence" text and no reads. A helper never throws.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** The part of the factory's `HelperCommand` this file uses. */
export interface HelperCommandBuilder {
  claude(model?: string): { argv: string[]; settings: unknown }
  codexMcpListArgv(): string[]
  mcpNames(stdout: string): string[] | null
  codex(mcpNames: readonly string[]): string[]
  prompt(question: string, text?: string): string
}
/** The arguments of one `ask_helper` call, as the guard allowed them. */
export interface HelperArgs { engine: 'claude' | 'codex'; question: string; model?: string; text?: string }
/** What a helper gave: the text for the judge, the full paths it read (Claude only, and only with evidence), and whether the text is evidence at all. */
export interface HelperResult { text: string; reads: string[]; evidence: boolean }
/** How one process ended: its exit code (`null` when killed by a signal), its standard output, and why it could not run, if so. */
export interface HelperExit { code: number | null; stdout: string; overflow: boolean; failure?: 'missing' | 'failed' }
/** One started process. `kill` ends its whole process group at once. */
export interface HelperProcess { readonly done: Promise<HelperExit>; kill(): void }
/** Starts one process: `argv[0]` with the rest as its arguments, in `cwd`, with `input` on its standard input. */
export interface HelperSpawner { start(argv: readonly string[], options: { cwd: string; input: string; maxBytes: number }): HelperProcess }
/** Says whether one helper read may stand: the factory guard's tool (`read`, or `glob` for a searched path) and the path as the helper wrote it. */
export type ReadCheck = (call: { name: 'read' | 'glob'; arguments: Record<string, unknown> }) => boolean
/** One helper to run: the arguments, the judged project, the time by which it must have ended, and a signal that ends it early. */
export interface HelperJob { args: HelperArgs; project: string; deadline: number; signal?: AbortSignal; readAllowed: ReadCheck }

/**
 * Starts processes with Node's `spawn`, each as the leader of its own process group (`detached`), so `kill` can end the helper and everything it started with
 * one SIGKILL to the group (`-pid`). Standard output is kept up to `maxBytes`; past that the group is killed and the exit says `overflow`.
 */
export class NodeSpawner implements HelperSpawner {
  constructor(private readonly spawnOf: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn,
    private readonly signal: (pid: number, signal: NodeJS.Signals) => void = (pid, name) => { process.kill(pid, name) }) {}

  start(argv: readonly string[], options: { cwd: string; input: string; maxBytes: number }): HelperProcess {
    const [command, ...args] = argv
    let child: ChildProcess
    const killGroup = () => {
      const pid = child?.pid
      if (pid === undefined) return
      try { this.signal(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already gone */ } }
    }
    const done = new Promise<HelperExit>(resolveExit => {
      try { child = this.spawnOf(command ?? '', args, { cwd: options.cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'] }) }
      catch { resolveExit({ code: null, stdout: '', overflow: false, failure: 'failed' }); return }
      const chunks: Buffer[] = []
      let size = 0, overflow = false, settled = false
      const settle = (exit: HelperExit) => { if (!settled) { settled = true; resolveExit(exit) } }
      child.stdout?.on('data', (chunk: Buffer) => {
        if (overflow) return
        size += chunk.length
        if (size > options.maxBytes) { overflow = true; killGroup(); return }
        chunks.push(chunk)
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        settle({ code: null, stdout: '', overflow: false, failure: error.code === 'ENOENT' ? 'missing' : 'failed' })
      })
      child.on('close', (code: number | null) => { settle({ code, stdout: Buffer.concat(chunks).toString('utf8'), overflow }) })
      // A helper that ends before it read all of its input closes the pipe; that is no error of ours.
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input)
    })
    return { done, kill: killGroup }
  }
}

/** Runs one helper for the judge, within its deadline, and turns what it printed into the judge's text and the files it read. */
export class HelperRunner {
  /** The longest a helper may run, from its own start, in milliseconds. */
  static readonly HELPER_MS = 15_000
  /** The most standard output kept from one helper: 1 MiB. */
  static readonly MAX_OUTPUT_BYTES = 1024 * 1024
  /** The longest answer text the judge is given, in characters. */
  static readonly MAX_TEXT = 6000
  /** The factory guard's name for each Claude tool whose path is checked: Read reads a file; Grep and Glob search below a path, checked as that path. */
  private static readonly CHECKED: Readonly<Record<string, { guard: 'read' | 'glob'; key: string }>> = {
    Read: { guard: 'read', key: 'file_path' }, Grep: { guard: 'glob', key: 'path' }, Glob: { guard: 'glob', key: 'path' },
  }

  constructor(private readonly command: HelperCommandBuilder, private readonly spawner: HelperSpawner = new NodeSpawner(),
    private readonly now: () => number = Date.now) {}

  /** A text that tells the judge the helper gave nothing to go on, and why. */
  static noEvidence(why: string): HelperResult {
    return { text: `The helper gave no evidence (${why}). Decide without it.`, reads: [], evidence: false }
  }

  /** The helper's answer, or a "no evidence" text. Never throws. */
  async run(job: HelperJob): Promise<HelperResult> {
    try {
      const deadline = Math.min(job.deadline, this.now() + HelperRunner.HELPER_MS)
      return job.args.engine === 'claude' ? await this.claude(job, deadline) : await this.codex(job, deadline)
    } catch {
      return HelperRunner.noEvidence('the helper could not be run')
    }
  }

  private async claude(job: HelperJob, deadline: number): Promise<HelperResult> {
    const { argv } = this.command.claude(job.args.model)
    const exit = await this.within(argv, job.project, this.command.prompt(job.args.question), deadline, job.signal)
    if ('result' in exit) return exit.result
    if (exit.code !== 0) return HelperRunner.noEvidence('it ended with an error')
    const parsed = HelperRunner.claudeOutput(exit.stdout, job.project)
    if (parsed === undefined) return HelperRunner.noEvidence('its answer could not be read')
    for (const read of parsed.calls) {
      if (!job.readAllowed({ name: read.guard, arguments: read.guard === 'read' ? { file_path: read.path } : { path: read.path } })) {
        return HelperRunner.noEvidence('it tried to read a file on the secret list')
      }
    }
    const reads: string[] = []
    for (const read of parsed.calls) if (!reads.includes(read.full)) reads.push(read.full)
    return { text: HelperRunner.capped(parsed.text), reads, evidence: true }
  }

  private async codex(job: HelperJob, deadline: number): Promise<HelperResult> {
    if (job.args.text === undefined) return HelperRunner.noEvidence('a Codex helper needs the text to answer from')
    // A fresh empty folder: the helper finds no project file and no project config there.
    const folder = mkdtempSync(join(tmpdir(), 'factory-helper-'))
    try {
      const listed = await this.within(this.command.codexMcpListArgv(), folder, '', deadline, job.signal)
      if ('result' in listed) return listed.result
      const names = listed.code === 0 ? this.command.mcpNames(listed.stdout) : null
      if (names === null) return HelperRunner.noEvidence('its MCP servers could not be listed, so they could not be turned off, and it was not started')
      const exit = await this.within(this.command.codex(names), folder, this.command.prompt(job.args.question, job.args.text), deadline, job.signal)
      if ('result' in exit) return exit.result
      if (exit.code !== 0) return HelperRunner.noEvidence('it ended with an error')
      const text = HelperRunner.codexOutput(exit.stdout)
      if (text === undefined) return HelperRunner.noEvidence('its answer could not be read')
      return { text: HelperRunner.capped(text), reads: [], evidence: true }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /**
   * Runs one process until it ends, its deadline passes or `signal` aborts, whichever comes first; at the deadline or the abort its process group is killed.
   * Returns its exit, or the result to hand the judge when it did not end by itself.
   */
  private async within(argv: readonly string[], cwd: string, input: string, deadline: number, signal?: AbortSignal): Promise<HelperExit | { result: HelperResult }> {
    if (signal?.aborted) return { result: HelperRunner.noEvidence('the question was answered before it started') }
    const left = deadline - this.now()
    if (left <= 0) return { result: HelperRunner.noEvidence('no time was left to run it') }
    const started = this.spawner.start(argv, { cwd, input, maxBytes: HelperRunner.MAX_OUTPUT_BYTES })
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const stopped = new Promise<'late' | 'aborted'>(resolveStop => {
      timer = setTimeout(() => { resolveStop('late') }, left)
      onAbort = () => { resolveStop('aborted') }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const first = await Promise.race([started.done, stopped])
      if (first === 'late' || first === 'aborted') {
        started.kill()
        return { result: HelperRunner.noEvidence(first === 'late' ? 'it ran past its time limit and was stopped' : 'the question was answered before it finished, so it was stopped') }
      }
      if (first.failure === 'missing') return { result: { text: `The ${argv[0]} helper is unavailable (the ${argv[0]} program was not found). Decide without it.`, reads: [], evidence: false } }
      if (first.failure !== undefined) return { result: HelperRunner.noEvidence('it could not be started') }
      if (first.overflow) return { result: HelperRunner.noEvidence('it printed too much') }
      return first
    } finally {
      clearTimeout(timer)
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Reads `claude -p --output-format json` output: a JSON array of events (or a single result object). Each `assistant` event's `tool_use` blocks of Read,
   * Grep and Glob give the paths it read (Grep's and Glob's default to the project); the `result` event gives the answer. `undefined` when there is no
   * successful result with text, or a tool call names no usable path.
   */
  static claudeOutput(stdout: string, project: string): { text: string; calls: { guard: 'read' | 'glob'; path: string; full: string }[] } | undefined {
    let parsed: unknown
    try { parsed = JSON.parse(stdout) } catch { return undefined }
    const events = Array.isArray(parsed) ? parsed : [parsed]
    const calls: { guard: 'read' | 'glob'; path: string; full: string }[] = []
    let text: string | undefined
    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue
      const { type, message, subtype, is_error: isError, result } = event as Record<string, unknown>
      if (type === 'assistant') {
        const content = (message as { content?: unknown } | null)?.content
        for (const block of Array.isArray(content) ? content : []) {
          const { type: blockType, name, input } = (block ?? {}) as Record<string, unknown>
          if (blockType !== 'tool_use' || typeof name !== 'string') continue
          const checked = HelperRunner.CHECKED[name]
          // Any other tool should not exist in a helper; a call of one makes the whole answer unusable.
          if (checked === undefined) return undefined
          const value = (input as Record<string, unknown> | null)?.[checked.key]
          if (value !== undefined && typeof value !== 'string') return undefined
          const path = value === undefined || value === '' ? project : value
          calls.push({ guard: checked.guard, path, full: HelperRunner.fullPath(path, project) })
        }
      }
      if (type === 'result') text = subtype === 'success' && isError !== true && typeof result === 'string' ? result : undefined
    }
    return text === undefined || text.trim() === '' ? undefined : { text: text.trim(), calls }
  }

  /** Reads `codex exec --json` output: one JSON event per line; the text of its `agent_message` items, joined. `undefined` when there is none. */
  static codexOutput(stdout: string): string | undefined {
    const texts: string[] = []
    for (const line of stdout.split('\n')) {
      if (line.trim() === '') continue
      let event: unknown
      try { event = JSON.parse(line) } catch { return undefined }
      const { type, item } = (event ?? {}) as { type?: unknown; item?: { type?: unknown; text?: unknown } }
      if (type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') texts.push(item.text)
    }
    const text = texts.join('\n').trim()
    return text === '' ? undefined : text
  }

  /** `path` as a full path, as the judge makes its own (`JudgeSession.pathOf`): `~` is the home folder, and a relative path starts at the project. */
  private static fullPath(path: string, project: string): string {
    if (path === '~') return homedir()
    if (path.startsWith('~/')) return join(homedir(), path.slice(2))
    return isAbsolute(path) ? resolve(path) : resolve(project, path)
  }

  private static capped(text: string): string {
    return text.length <= HelperRunner.MAX_TEXT ? text : `${text.slice(0, HelperRunner.MAX_TEXT)}\n[cut at ${HelperRunner.MAX_TEXT} characters]`
  }
}
