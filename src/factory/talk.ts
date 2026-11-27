/**
 * The review talk: a Claude Code session in Orca in which the owner and Claude talk one job and its comments through, and which can propose a change
 * to the super agent's decision guideline (epic R8, architecture AD-18). The review page's "Start review talk" button starts it; the talk itself runs
 * in Orca, not here and not in DSH.
 * On the owner's click this file prepares a talk folder for the job, writes the whole opening message into it as `opening.md`, and then runs exactly
 * two Orca commands (`OrcaLauncher`, AD-7's review-talk exception): `orca repo add` for the folder, skipped when Orca has it already, and
 * `orca agent launch`, which starts Claude Code in that folder with one fixed line as its first message. Nothing is typed into the session afterwards.
 * This code writes nothing to the job log, to a project's `.factory/` folder or to the guideline folder.
 * The folder, `~/.config/zees-factory/review-talks/<project>-job-<n>-<short hash>/`, holds:
 *   .claude/settings.json  deny rules only, so the talk can read and look things up but not write, edit or run a command (`TalkFolder.SETTINGS`)
 *   .mcp.json              the one factory tool server, `propose_guideline_change` (`TalkFolder.mcpOf`)
 *   job.md                 the job as the page shows it: each step's line and its detail
 *   comments.md            the owner's comments on the job and its steps
 *   guideline.md           the current guideline, or a note that there is none yet
 *   opening.md             the opening message: the title, the folder guard, what the talk is for, the lookup rule, the job, the comments, the guideline
 *   talk.json              the project, the job and the start date: the only state, and the sign that the talk was started
 * Every file goes through the factory's own mask first (PRD NFR-3, the review talk's path): the talk folder holds masked copies only, also when a
 * record on disk was already masked. Without a working mask nothing is written.
 * Proposals the talk sends back (`POST /review/proposal`, in `review.ts`) are kept here in memory, the newest per job, until a newer one replaces it.
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  FactoryRecordsModule, RecordsRefusal, type AutomaticAnswer, type GuidelineRead, type JobLogLine, type RecordedJob, type RecordsSource, type StepDetail, type StepOutcome, type StepSource,
  type StepWhy, type TimelineStep,
} from './records.ts'

/** Represents a talk that could not be started, with the HTTP status the review page answers: 409 for a job with no comment, 503 when it cannot be prepared. */
export class TalkRefusal extends Error {
  readonly status: 409 | 503
  constructor(status: 409 | 503, message: string) { super(message); this.status = status }
}

/** The words the review page uses for a step, so the talk's files name each step as the page does. `ReviewPage` itself has this shape. */
export interface StepWords {
  readonly HEADINGS: Readonly<Record<JobLogLine['kind'], string>>
  readonly AUTOMATIC: Readonly<Record<AutomaticAnswer['answer'], string>>
  readonly DECISIONS: Readonly<Record<Extract<StepWhy, { by: 'super_agent' }>['decision'], string>>
  readonly OUTCOMES: Readonly<Record<StepOutcome['outcome'], string>>
  readonly PARTS: Readonly<{ asked: string; why: string; looked_at: string; next: string; cost: string }>
  readonly NOT_RECORDED: string
  readonly CHECKED: string
}

/** What `talk.json` holds: the talk's project and job, the title line its opening message starts with, and when it was (last) started. */
export interface TalkState { project: string; job_id: string; number: number; title: string; started: string }

/** Where the propose server is and how it reaches the review page: what `.mcp.json` starts. */
export interface TalkServer { node: string; server: string; url: string; tokenFile: string }

/** The owner's comments on one job, the newest per step and for the whole job, in timeline order: the whole job's first. */
export class TalkComments {
  /** Why a job with no comment has no talk: the start's refusal, and the hint beside the review page's disabled button. */
  static readonly NONE = 'Comment on the job or a step first.'
  readonly entries: readonly { step?: TimelineStep; text: string }[]
  constructor(job: RecordedJob) {
    const newest = new Map<string, string>()
    for (const review of job.reviews) newest.set(review.step_id ?? '', review.comment)
    const entries: { step?: TimelineStep; text: string }[] = []
    const whole = newest.get('')
    if (whole !== undefined && whole.trim() !== '') entries.push({ text: whole })
    for (const step of job.steps) {
      if (step.automatic) continue
      const text = newest.get(step.line.step_id)
      if (text !== undefined && text.trim() !== '') entries.push({ step, text })
    }
    this.entries = entries
  }
}

/** Writes a job, its comments and the guideline as the plain texts of the talk's files. Nothing here is masked yet: `TalkFolder` masks every text it writes. */
export class TalkTexts {
  private readonly words: StepWords
  constructor(words: StepWords) { this.words = words }

  /** The project's folder name, which is what the owner calls it. */
  static nameOf(project: string): string { return basename(project) || project }
  /** The first line of the opening message, and the talk's name: the first line of its Orca tab's first message. */
  static title(job: RecordedJob): string { return `Review talk · ${TalkTexts.nameOf(job.project)} job ${job.number}` }

  /** `job.md`: the job's facts, then each step's line and its detail, in timeline order. */
  job(job: RecordedJob, details: ReadonlyMap<TimelineStep, StepDetail>): string {
    const out = [`# ${TalkTexts.nameOf(job.project)} job ${job.number}`, '',
      `- Project: ${job.project}`, `- Job id: ${job.job_id}`, `- Started: ${job.started}`,
      `- Stopped: ${job.stopped ?? `ended without a stop; its last step was at ${job.last}`}`,
      `- Guideline version: ${job.guideline_version ?? this.words.NOT_RECORDED}`, '', '## Steps']
    job.steps.forEach((step, index) => {
      out.push('', `### ${index + 1}. ${step.ts} · ${this.heading(step)}`)
      if (step.automatic) {
        out.push(`Asked: ${TalkTexts.inputText(step.answer.tool_input)}`)
        if (step.answer.reason !== '') out.push(`Reason given: ${step.answer.reason}`)
        out.push(`${this.words.AUTOMATIC[step.answer.answer]} · ${this.words.CHECKED}`)
      } else {
        const line = step.line
        if (line.from !== undefined && line.to !== undefined) out.push(`From ${line.from} to ${line.to}.`)
        out.push(line.summary)
      }
      const detail = details.get(step)
      if (detail !== undefined) out.push(...this.detail(detail))
    })
    return `${out.join('\n')}\n`
  }

  /** `comments.md`: the comment on the whole job, then each step's, each under what it is about. */
  comments(job: RecordedJob, comments: TalkComments): string {
    const out = [`# The owner's comments on ${TalkTexts.nameOf(job.project)} job ${job.number}`]
    for (const entry of comments.entries) {
      const step = entry.step
      out.push('', step === undefined ? '## On the whole job' : `## On step ${job.steps.indexOf(step) + 1} · ${step.ts} · ${this.heading(step)}`, entry.text)
    }
    return `${out.join('\n')}\n`
  }

  /** `guideline.md`: the current version's whole text as written, or a note that there is none yet and that a proposal would be version 1. */
  static guideline(read: GuidelineRead): string {
    if (read.current === null) return `${TalkTexts.noGuideline(read)}\n`
    return read.current.text.endsWith('\n') ? read.current.text : `${read.current.text}\n`
  }
  static noGuideline(read: GuidelineRead): string {
    return `There is no guideline yet${read.folder === null ? ' (the guideline folder was not found)' : ''}. A proposal would be version 1.`
  }

  private heading(step: TimelineStep): string {
    return step.automatic ? `${step.answer.tool_name} · ${this.words.AUTOMATIC[step.answer.answer]}` : this.words.HEADINGS[step.line.kind] ?? step.line.kind
  }

  /** A step's five parts as lines, each under the page's label; a part no record holds reads "Not recorded". */
  private detail(detail: StepDetail): string[] {
    const { PARTS, NOT_RECORDED } = this.words
    const part = (label: string, value: string | undefined) => `- ${label}: ${value ?? NOT_RECORDED}`
    const { asked, why, looked_at: read, next, cost } = detail
    return [
      part(PARTS.asked, asked === null ? undefined : asked.kind === 'message' ? `${asked.from} to ${asked.to}: ${asked.text}` : asked.kind === 'step' ? asked.text
        : `${asked.tool_name} · ${TalkTexts.inputText(asked.tool_input)} · ${asked.reason === '' ? 'the worker gave no reason' : `reason given by the worker: ${asked.reason}`}`),
      part(PARTS.why, why === null ? undefined : why.by === 'fixed_checks' ? `${this.words.AUTOMATIC[why.answer]} · ${this.words.CHECKED}`
        : [`${this.words.DECISIONS[why.decision] ?? why.decision} · risk ${why.risk}`, why.reason, why.choice === null ? '' : `Chosen: ${why.choice}`,
          why.alternative === '' ? '' : `Instead: ${why.alternative}`, why.cites === '' ? '' : `Rests on: ${why.cites}`].filter(text => text !== '').join(' · ')),
      part(PARTS.looked_at, read === null ? undefined : read.length === 0 ? 'nothing was read' : read.map(each => `${each.path} (${each.used ? 'used' : 'not used'})`).join(', ')),
      part(PARTS.next, next === null ? undefined : `${this.words.OUTCOMES[next.outcome] ?? next.outcome}${next.detail === '' ? '' : ` · ${next.detail}`}`),
      part(PARTS.cost, cost === null ? undefined : `${cost.tokens} tokens · ${cost.seconds.toFixed(1)} s`),
    ]
  }

  /** A tool's input as the owner reads it: a command as it is, anything else as JSON. */
  private static inputText(input: unknown): string {
    const command = input !== null && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string' ? (input as { command: string }).command : undefined
    return command ?? JSON.stringify(input) ?? String(input)
  }
}

/**
 * The talk's opening message, written to the talk folder as `opening.md`, with no length cut: the title line, the folder guard, what the talk is for,
 * the lookup rule, the job, the owner's comments and the guideline (AD-18). The folder guard comes first: in any folder but the talk folder the deny
 * rules and the propose server do not apply, so Claude stops at once with a plain message instead of talking the job through.
 * Its parts are the masked texts of the files, and the whole message goes through the mask once more as a file of its own (`TalkFolder.write`).
 */
export class TalkOpening {
  static readonly LOOKUP_RULE = 'Lookups: you may look things up, such as a library\'s documentation. A lookup sends out only a tool or library name and a general question, '
    + 'never job text, comments, project code or a file path.'

  /**
   * The folder guard for the talk folder named `folder`: Claude reads its working folder from its own environment, so the guard needs no tool. Only
   * the talk folder itself passes; any other folder, a git worktree of it included, stops the talk.
   */
  static folderCheck(folder: string): string {
    return `Before anything else, check your working folder, as your environment states it. It must be the talk folder ${folder}, under `
      + `~/.config/zees-factory/review-talks/. If it is any other folder, reply only: "${TalkOpening.WRONG_FOLDER}" `
      + 'and do nothing else: read no file, call no tool and do not discuss the job.'
  }

  static readonly WRONG_FOLDER = 'This review talk opened in the wrong folder, so it is stopping here. Close this session and start the talk again from the review page.'

  /** The whole opening message, with no length cut, for a job whose files hold `texts`, each already masked, written to the talk folder named `folder`. */
  static build(job: RecordedJob, folder: string, texts: { title: string; job: string; comments: string; guideline: string }, read: GuidelineRead): string {
    const version = read.current === null ? 'there is none yet, so a proposal would be version 1' : `version ${read.current.version}`
    return [texts.title, '', TalkOpening.folderCheck(folder), '',
      `This review talk is about job ${job.number} of ${TalkTexts.nameOf(job.project)} (job id ${job.job_id}), which the super agent led. The owner has commented on it. `
      + `Talk the comments through with the owner. When you both agree on a change to the super agent's decision guideline (${version}), call the tool `
      + `propose_guideline_change with job_id "${job.job_id}" and the whole new guideline text. The owner then sees it on the review page beside the current `
      + 'version, and nothing is saved until the owner accepts it there. In this talk you can read and look things up, but not write, edit or run a command.',
      '', TalkOpening.LOOKUP_RULE, '', 'This folder holds the same texts as files: job.md (the job), comments.md (the owner\'s comments) and guideline.md (the current guideline).',
      '', '## The job', '', texts.job.trimEnd(), '', '## The owner\'s comments', '', texts.comments.trimEnd(),
      '', read.current === null ? '## The guideline' : `## The current guideline, version ${read.current.version}`, '',
      texts.guideline.trimEnd(), ''].join('\n')
  }
}

/**
 * One job's talk folder: where it is, whether the talk was started and when, and writing its files.
 * Every file goes through `write`, which masks every text first and writes nothing at all when one cannot be masked.
 */
export class TalkFolder {
  /** Outside every repository, next to the factory's settings. */
  static readonly ROOT = join(homedir(), '.config', 'zees-factory', 'review-talks')
  /** The talk's Claude Code settings: deny rules only, nothing else. A deny rule wins over any allow rule. */
  static readonly SETTINGS = `${JSON.stringify({ permissions: { deny: ['Write', 'Edit', 'NotebookEdit', 'Bash'] } }, null, 2)}\n`
  /** The name of the talk's one MCP server, as Claude Code lists it. */
  static readonly SERVER_NAME = 'zees-factory-propose'
  static readonly FILES = { settings: join('.claude', 'settings.json'), mcp: '.mcp.json', job: 'job.md', comments: 'comments.md', guideline: 'guideline.md', opening: 'opening.md',
    state: 'talk.json' } as const
  /**
   * The git settings of the talk folder's own repository, given on every call so nothing comes from the owner's own git setup: a fixed author, no
   * signing, no hooks, `main` as the first branch. The owner's global and system config files are not read at all (`GIT_CONFIG_GLOBAL`,
   * `GIT_CONFIG_NOSYSTEM`), and no `GIT_*` variable of DSH's own environment reaches git.
   */
  static readonly GIT_CONFIG = ['-c', 'user.name=zees-factory', '-c', 'user.email=zees-factory@localhost', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main'] as const
  readonly path: string
  constructor(path: string) { this.path = path }

  /** The folder of `job` under `root`: `<project>-job-<n>-<short hash>`, the hash of the project's path and the job's id, so two projects never share one. */
  static of(root: string, job: RecordedJob): TalkFolder {
    const name = TalkTexts.nameOf(job.project).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'project'
    const hash = createHash('sha256').update(`${job.project}\n${job.job_id}`, 'utf8').digest('hex').slice(0, 8)
    return new TalkFolder(join(root, `${name}-job-${job.number}-${hash}`))
  }

  /**
   * The text of `.mcp.json`: the one stdio server, started with the Node that runs DSH, the built propose server, the review page's proposal address
   * and the token file's path. The token itself is never in it. A path inside the owner's home folder is written as `${HOME}/…`, which Claude Code
   * expands in `command` and `args` (Claude Code docs, MCP page, "Environment variable expansion in .mcp.json"), so the file says nothing of who the
   * owner is and the mask leaves it as it is.
   */
  static mcpOf(server: TalkServer, home: string = homedir()): string {
    const path = (value: string) => TalkFolder.homeAsVariable(value, home)
    return `${JSON.stringify({ mcpServers: { [TalkFolder.SERVER_NAME]: {
      command: path(server.node), args: [path(server.server), '--url', server.url, '--token-file', path(server.tokenFile)],
    } } }, null, 2)}\n`
  }

  /** A path with the owner's home folder at its start written as `${HOME}`. */
  static homeAsVariable(path: string, home: string): string {
    const trimmed = home.replace(/\/+$/, '')
    if (trimmed === '') return path
    if (path === trimmed) return '${HOME}'
    return path.startsWith(`${trimmed}/`) ? `\${HOME}${path.slice(trimmed.length)}` : path
  }

  /** The talk's state from `talk.json`, or `undefined` when the talk was never started (or its state cannot be read). */
  state(): TalkState | undefined {
    try {
      if (!lstatSync(this.path).isDirectory()) return undefined
      const value = JSON.parse(readFileSync(join(this.path, TalkFolder.FILES.state), 'utf8')) as Partial<TalkState> | null
      if (value === null || typeof value !== 'object' || typeof value.started !== 'string' || typeof value.title !== 'string') return undefined
      return { project: String(value.project ?? ''), job_id: String(value.job_id ?? ''), number: Number(value.number ?? 0), title: value.title, started: value.started }
    } catch { return undefined }
  }

  /**
   * Writes the talk's files. `mask` cleans one text and throws when it cannot. Every text is masked before the first byte is written, so a mask that
   * fails leaves no folder behind. The two pinned files must come through the mask unchanged, since a changed one would no longer start the tool or
   * deny anything; if not, nothing is written. `talk.json` is written last: until it is there, the talk does not count as started.
   * Then the folder is made its own git repository (once) and every file written is committed, a fresh talk as a new commit on top. Orca adds the
   * folder with `--kind git`, and as its own repository it is the project itself, not a repository above it (the owner's home folder can be one).
   * No remote is set; nothing is pushed. When git fails the start is refused and `talk.json` is removed again, so the talk does not count as started.
   */
  write(files: { mcp: string; job: string; comments: string; guideline: string; opening: string; state: TalkState }, mask: (text: string) => string): void {
    const plain: [string, string][] = [[TalkFolder.FILES.settings, TalkFolder.SETTINGS], [TalkFolder.FILES.mcp, files.mcp], [TalkFolder.FILES.job, files.job],
      [TalkFolder.FILES.comments, files.comments], [TalkFolder.FILES.guideline, files.guideline], [TalkFolder.FILES.opening, files.opening], [TalkFolder.FILES.state, `${JSON.stringify(files.state, null, 2)}\n`]]
    const masked = plain.map(([name, text]) => [name, mask(text)] as const)
    for (const [name, text] of masked.slice(0, 2)) {
      if (text !== plain.find(([each]) => each === name)![1]) throw new TalkRefusal(503, `The review talk could not be prepared: the mask changed ${name}`)
    }
    try {
      // A symlink in the folder's place could send the files elsewhere, so each folder is checked before anything is made inside it.
      for (const folder of [this.path, join(this.path, '.claude')]) {
        mkdirSync(folder, { recursive: true, mode: 0o700 })
        if (!lstatSync(folder).isDirectory()) throw new Error('not a folder')
      }
      for (const [name, text] of masked) TalkFolder.put(join(this.path, name), text)
    } catch (error) {
      if (error instanceof TalkRefusal) throw error
      throw new TalkRefusal(503, `The review talk could not be prepared: the talk folder could not be written (${(error as NodeJS.ErrnoException).code ?? 'not a folder'})`)
    }
    try {
      this.git('init', '--quiet')
      this.git('add', '--', ...masked.map(([name]) => name))
      this.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', `Review talk files, started ${files.state.started}`)
    } catch {
      this.unstart()
      throw new TalkRefusal(503, 'The review talk could not be prepared: the talk folder could not be committed to its own git repository')
    }
  }

  /** Removes `talk.json`, so the talk no longer counts as started. Every other file stays. */
  unstart(): void { rmSync(join(this.path, TalkFolder.FILES.state), { force: true }) }

  /** Runs one git command inside the talk folder, with `GIT_CONFIG` and an environment that holds none of the owner's git settings. */
  private git(...args: string[]): void {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
    execFileSync('git', [...TalkFolder.GIT_CONFIG, ...args], { cwd: this.path, env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      stdio: 'ignore', timeout: 15_000 })
  }

  /** Replaces one file's text. NOFOLLOW makes the open fail on a symlink, and the opened file must be a regular file. */
  private static put(file: string, text: string): void {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    try {
      if (!fstatSync(fd).isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISFILE' })
      writeSync(fd, text, null, 'utf8')
    } finally { closeSync(fd) }
  }
}

/** How one program ended: its output, or the reason it failed. */
export type OrcaRun = { ok: true; stdout: string } | { ok: false; error: string }

/** Where a program runs: its working folder, and variables set on top of DSH's own environment (`undefined` removes one). */
export interface RunOptions { cwd?: string; env?: Readonly<Record<string, string | undefined>> }

/**
 * Runs one program with plain arguments, never through a shell, within a time limit. `OrcaLauncher` runs Orca through it, and the guideline's save
 * path (`save.ts`) runs git and glab through it; tests give a fake.
 */
export interface OrcaRunner {
  run(program: string, args: readonly string[], timeoutMs: number, options?: RunOptions): Promise<OrcaRun>
}

/** The real runner: `execFile`, so the arguments reach the program as they are and nothing is read by a shell. It never blocks DSH while it waits. */
export class ExecFileRunner implements OrcaRunner {
  run(program: string, args: readonly string[], timeoutMs: number, options: RunOptions = {}): Promise<OrcaRun> {
    const env = options.env === undefined ? undefined : ExecFileRunner.envOf(options.env)
    return new Promise(done => {
      execFile(program, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(env === undefined ? {} : { env }) }, (error, stdout, stderr) => {
        if (error === null) { done({ ok: true, stdout }); return }
        const timedOut = (error as { killed?: boolean }).killed === true && (error as { signal?: string | null }).signal === 'SIGKILL'
        const said = [stderr, stdout].map(text => text.trim()).find(text => text !== '')
        done({ ok: false, error: timedOut ? `no answer within ${timeoutMs / 1000} seconds` : said ?? error.message })
      })
    })
  }
  /** DSH's own environment with `changes` on top; a change to `undefined` leaves that variable out. */
  static envOf(changes: Readonly<Record<string, string | undefined>>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base }
    for (const [name, value] of Object.entries(changes)) { if (value === undefined) delete env[name]; else env[name] = value }
    return env
  }
}

/**
 * Opens a prepared talk folder in Orca with exactly the two commands AD-7's review-talk exception allows, and nothing else:
 *   orca repo add --path <talk folder> --kind git          (skipped when `orca repo list --json` already lists the folder)
 *   orca agent launch --agent claude --worktree path:<talk folder> --surface terminal --focus --prompt <fixed line>
 * The only variable parts are the talk folder, which must sit directly under the talk root with a plain name, and the title line in the prompt.
 * Nothing is typed into the session afterwards.
 */
export class OrcaLauncher {
  /** What the owner's click is refused with when no `orca` program was found (AD-18, "Finding Orca"). */
  static readonly NOT_FOUND = 'Orca\'s command-line tool was not found'
  /** The fixed text after the title line in the talk's first message (AD-18). */
  static readonly PROMPT = 'Read opening.md in this folder and follow it.'
  /** The last place `find` looks, where Homebrew puts Orca on a Mac. */
  static readonly HOMEBREW = '/opt/homebrew/bin/orca'
  static readonly NAME = /^[A-Za-z0-9._-]+$/
  static readonly ADD_MS = 15_000
  static readonly LAUNCH_MS = 60_000
  /** The `orca` program, or `undefined` when none was found. */
  readonly program: string | undefined
  private readonly root: string
  private readonly runner: OrcaRunner

  constructor(options: { program: string | undefined; root?: string; runner?: OrcaRunner }) {
    this.program = options.program
    this.root = resolve(options.root ?? TalkFolder.ROOT)
    this.runner = options.runner ?? new ExecFileRunner()
  }

  /**
   * The `orca` program, looked up once when DSH starts: the profile's `review.orca` setting, then each folder on `PATH`, then `HOMEBREW`. Only an
   * absolute path to an executable file counts. A setting that is given is the only place looked at, so a wrong one is refused, never replaced by
   * another `orca`. `undefined` when there is none.
   */
  static find(setting: string | undefined, path: string | undefined = process.env.PATH): string | undefined {
    if (setting !== undefined && setting !== '') return OrcaLauncher.runnable(setting) ? setting : undefined
    const onPath = (path ?? '').split(delimiter).filter(folder => isAbsolute(folder)).map(folder => join(folder, 'orca'))
    return [...onPath, OrcaLauncher.HOMEBREW].find(OrcaLauncher.runnable)
  }

  private static runnable(file: string): boolean {
    try { return isAbsolute(file) && statSync(file).isFile() && (accessSync(file, constants.X_OK), true) } catch { return false }
  }

  /** The talk's first message: its title line and the fixed text, on one line. */
  static promptOf(title: string): string { return `${title.replace(/\s+/g, ' ').trim()}. ${OrcaLauncher.PROMPT}` }

  /** Refuses with 503 when there is no `orca` program, so a start is refused before anything is written. */
  check(): void { if (this.program === undefined) throw new TalkRefusal(503, OrcaLauncher.NOT_FOUND) }

  /** Opens the talk folder `folder`, whose talk is called `title`, in Orca. A failed step is a 503 that names the step and Orca's first line. */
  async launch(folder: string, title: string): Promise<void> {
    this.check()
    const program = this.program!
    const name = basename(folder)
    if (resolve(dirname(folder)) !== this.root || !OrcaLauncher.NAME.test(name) || resolve(folder) !== folder) {
      throw new TalkRefusal(503, 'Orca could not start the talk: the talk folder is not a plain folder directly under the review talks folder')
    }
    const failed = (step: string, error: string) => new TalkRefusal(503, `Orca could not start the talk (${step}: ${error.split(/\r?\n/)[0]!.trim()})`)
    const listed = await this.runner.run(program, ['repo', 'list', '--json'], OrcaLauncher.ADD_MS)
    if (!listed.ok) throw failed('repo list', listed.error)
    if (!OrcaLauncher.lists(listed.stdout, folder)) {
      const added = await this.runner.run(program, ['repo', 'add', '--path', folder, '--kind', 'git'], OrcaLauncher.ADD_MS)
      if (!added.ok) throw failed('repo add', added.error)
    }
    const launched = await this.runner.run(program,
      ['agent', 'launch', '--agent', 'claude', '--worktree', `path:${folder}`, '--surface', 'terminal', '--focus', '--prompt', OrcaLauncher.promptOf(title)], OrcaLauncher.LAUNCH_MS)
    if (!launched.ok) throw failed('agent launch', launched.error)
  }

  /** Whether the answer of `orca repo list --json` (`{ result: { repos: [{ path }] } }`) holds `folder`, by its path as given or as resolved on disk. */
  static lists(answer: string, folder: string): boolean {
    let repos: unknown
    try { repos = (JSON.parse(answer) as { result?: { repos?: unknown } } | null)?.result?.repos } catch { return false }
    if (!Array.isArray(repos)) return false
    const real = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }
    const wanted = new Set([resolve(folder), real(folder)])
    return repos.some(repo => typeof (repo as { path?: unknown } | null)?.path === 'string' && (wanted.has(resolve((repo as { path: string }).path))
      || wanted.has(real((repo as { path: string }).path))))
  }
}

/** What `ReviewTalks.start` did: opened a talk in Orca, or found one already started and opened nothing. */
export type TalkStart = { opened: true; state: TalkState } | { opened: false; state: TalkState }

export interface ReviewTalksOptions {
  /** The factory's records module: the mask, the step reader and the guideline reader. */
  records: RecordsSource
  /** The shared token's file, which the propose server reads on every call. */
  tokenFile: string
  /** How the page names a step. */
  words: StepWords
  /** Opens a prepared talk folder in Orca. Required, so nothing starts a real session by default. */
  orca: OrcaLauncher
  /** Where talk folders go. Defaults to `TalkFolder.ROOT`. */
  root?: string
  /** The built propose server. Defaults to `proposeServer.js` next to the records module's built file. */
  serverFile?: string
  /** The Node that starts the propose server. Defaults to the one that runs DSH. */
  node?: string
  home?: string
  now?: () => Date
}

/** Starts a job's review talk, or says it was started already. One talk per job, remembered by its folder's `talk.json`. */
export class ReviewTalks {
  readonly root: string
  private readonly records: RecordsSource
  private readonly tokenFile: string
  private readonly texts: TalkTexts
  private readonly orca: OrcaLauncher
  private readonly serverFile: string | undefined
  private readonly node: string
  private readonly home: string
  private readonly now: () => Date
  constructor(options: ReviewTalksOptions) {
    this.records = options.records
    this.tokenFile = options.tokenFile
    this.texts = new TalkTexts(options.words)
    this.orca = options.orca
    this.root = options.root ?? TalkFolder.ROOT
    const recordsPath = options.records instanceof FactoryRecordsModule ? options.records.path : undefined
    this.serverFile = options.serverFile ?? (recordsPath === undefined || recordsPath === '' ? undefined : join(recordsPath, '..', 'proposeServer.js'))
    this.node = options.node ?? process.execPath
    this.home = options.home ?? homedir()
    this.now = options.now ?? (() => new Date())
  }

  /** The talk of `job` when it was started, else `undefined`. Reads one small file; writes nothing. */
  stateOf(job: RecordedJob): TalkState | undefined { return TalkFolder.of(this.root, job).state() }

  /**
   * Prepares the talk of `job`, whose propose tool will post to `address`, and opens it in Orca. A job whose talk was started already gets nothing new
   * unless `fresh` is set: then its files are written again from the records of now, with a new date, and the talk is opened again.
   * Refuses with 409 when the owner has not commented on the job, and with 503 when Orca was not found, when the talk cannot be prepared (no mask, no
   * propose server, no folder) or when an Orca step fails; then nothing is marked as started, and after a failed Orca step the other files stay.
   */
  async start(job: RecordedJob, address: string, fresh: boolean): Promise<TalkStart> {
    const comments = new TalkComments(job)
    if (comments.entries.length === 0) throw new TalkRefusal(409, TalkComments.NONE)
    const folder = TalkFolder.of(this.root, job)
    const existing = folder.state()
    if (existing !== undefined && !fresh) return { opened: false, state: existing }
    this.orca.check()
    const cannot = (why: string) => new TalkRefusal(503, `The review talk could not be prepared: ${why}`)
    if (this.serverFile === undefined || !existsSync(this.serverFile)) throw cannot('the propose server\'s built file is not next to the job log file')
    const mask = await this.maskFor(job.project, cannot)
    let read: GuidelineRead
    let steps: StepSource
    try { [read, steps] = [(await this.records.guidelineReader()).read(), await this.records.stepReader()] }
    catch (error) { throw cannot(error instanceof RecordsRefusal ? error.message : 'the records could not be read') }
    const details = new Map(job.steps.map(step => [step, steps.read(job.project, step)] as const))
    const title = mask(TalkTexts.title(job))
    const texts = { title, job: mask(this.texts.job(job, details)), comments: mask(this.texts.comments(job, comments)), guideline: mask(TalkTexts.guideline(read)) }
    const state: TalkState = { project: job.project, job_id: job.job_id, number: job.number, title, started: this.now().toISOString() }
    const mcp = TalkFolder.mcpOf({ node: this.node, server: this.serverFile, url: address, tokenFile: this.tokenFile }, this.home)
    const opening = TalkOpening.build(job, basename(folder.path), texts, read)
    folder.write({ mcp, job: texts.job, comments: texts.comments, guideline: texts.guideline, opening, state }, mask)
    try { await this.orca.launch(folder.path, title) } catch (error) {
      folder.unstart()
      throw error instanceof TalkRefusal ? error : new TalkRefusal(503, 'Orca could not start the talk')
    }
    return { opened: true, state: folder.state() ?? state }
  }

  /** The project's mask over one plain text, from the factory's records module. Any failure is a 503 that repeats nothing of the text. */
  private async maskFor(project: string, cannot: (why: string) => TalkRefusal): Promise<(text: string) => string> {
    let masker
    try { masker = await this.records.maskerFor(project) } catch { throw cannot('the factory\'s mask cannot be had') }
    const maskText = masker.maskText
    if (typeof maskText !== 'function') throw cannot('the factory\'s built job log file cannot mask a plain text; rebuild it and restart DSH')
    return text => {
      let masked: unknown
      try { masked = maskText.call(masker, text) } catch { throw cannot('the factory\'s mask failed') }
      if (typeof masked !== 'string') throw cannot('the factory\'s mask failed')
      return masked
    }
  }
}

/** One guideline change a review talk proposed: the whole new text, for one job, and when it came. */
export interface GuidelineProposal { project: string; job_id: string; number: number; text: string; ts: string }

/** The proposals that wait for the owner's answer, in memory: the newest per job, until a newer one for that job replaces it. Nothing is saved. */
export class GuidelineProposals {
  private readonly byJob = new Map<string, GuidelineProposal>()
  private static keyOf(project: string, jobId: string): string { return `${project}\n${jobId}` }
  /** Keeps `proposal`, in place of the one before it for the same job. */
  put(proposal: GuidelineProposal): void {
    const key = GuidelineProposals.keyOf(proposal.project, proposal.job_id)
    // Deleted first, so the newest also comes last in the map's order.
    this.byJob.delete(key)
    this.byJob.set(key, proposal)
  }
  /** The proposal waiting for one job, or `undefined`. */
  of(project: string, jobId: string): GuidelineProposal | undefined { return this.byJob.get(GuidelineProposals.keyOf(project, jobId)) }
  /** Every waiting proposal, newest first. */
  newest(): GuidelineProposal[] { return [...this.byJob.values()].reverse() }
  /** Drops the proposal of one job, only when it is still the one made at `ts`; returns whether it did. A newer one stays. */
  remove(project: string, jobId: string, ts: string): boolean {
    const key = GuidelineProposals.keyOf(project, jobId)
    if (this.byJob.get(key)?.ts !== ts) return false
    return this.byJob.delete(key)
  }
}
