/**
 * The review talk: a Claude Desktop session in which the owner and Claude talk one job and its comments through, and which can propose a change to the
 * super agent's decision guideline (epic R8, architecture AD-18). The review page's "Start review talk" button starts it; the talk itself runs in Claude
 * Desktop, not here and not in DSH.
 * On the owner's click this file prepares a talk folder for the job and the page hands the browser a `claude://code/new?folder=…&q=…` link, the first
 * message already written. Claude Desktop asks the owner to confirm the folder, and nothing is sent until the owner presses send. This code starts no
 * session, and writes nothing to the job log, to a project's `.factory/` folder or to the guideline folder.
 * The folder, `~/.config/zees-factory/review-talks/<project>-job-<n>-<short hash>/`, holds:
 *   .claude/settings.json  deny rules only, so the talk can read and look things up but not write, edit or run a command (`TalkFolder.SETTINGS`)
 *   .mcp.json              the one factory tool server, `propose_guideline_change` (`TalkFolder.mcpOf`)
 *   job.md                 the job as the page shows it: each step's line and its detail
 *   comments.md            the owner's comments on the job and its steps
 *   guideline.md           the current guideline, or a note that there is none yet
 *   talk.json              the project, the job and the start date: the only state, and the sign that the talk was started
 * Every file, and the link's message, goes through the factory's own mask first (PRD NFR-3, the review talk's path): the talk folder holds masked
 * copies only, also when a record on disk was already masked. Without a working mask nothing is written.
 * Proposals the talk sends back (`POST /review/proposal`, in `review.ts`) are kept here in memory, the newest per job, until a newer one replaces it.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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
  /** The first line of the opening message, and the talk's name in Claude Desktop. */
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
 * The talk's opening message, the `q` of its link: the title line, what the talk is for, the lookup rule, the comments, the job and the guideline.
 * Claude Desktop cuts a longer `q` at about 14,000 characters, so a message that would pass `MAX_CHARS` keeps the title line, what the talk is for, the
 * lookup rule and the comments, and names the files that hold the rest; comments longer than that are cut and point to their file too.
 * Its parts are the masked texts of the files, and the whole message goes through the mask once more when it is done (`ReviewTalks.start`).
 */
export class TalkOpening {
  static readonly MAX_CHARS = 14_000
  static readonly LOOKUP_RULE = 'Lookups: you may look things up, such as a library\'s documentation. A lookup sends out only a tool or library name and a general question, '
    + 'never job text, comments, project code or a file path.'
  static readonly CUT = '… (the rest is in comments.md)'

  /** The message for a job whose files hold `texts`, each already masked. */
  static build(job: RecordedJob, texts: { title: string; job: string; comments: string; guideline: string }, read: GuidelineRead): string {
    const version = read.current === null ? 'there is none yet, so a proposal would be version 1' : `version ${read.current.version}`
    const head = [texts.title, '',
      `This review talk is about job ${job.number} of ${TalkTexts.nameOf(job.project)} (job id ${job.job_id}), which the super agent led. The owner has commented on it. `
      + `Talk the comments through with the owner. When you both agree on a change to the super agent's decision guideline (${version}), call the tool `
      + `propose_guideline_change with job_id "${job.job_id}" and the whole new guideline text. The owner then sees it on the review page beside the current `
      + 'version, and nothing is saved until the owner accepts it there. In this talk you can read and look things up, but not write, edit or run a command.',
      '', TalkOpening.LOOKUP_RULE, '', 'This folder holds the same texts as files: job.md (the job), comments.md (the owner\'s comments) and guideline.md (the current guideline).']
    const comments = ['', '## The owner\'s comments', '', texts.comments.trimEnd()]
    const rest = ['', '## The job', '', texts.job.trimEnd(), '', read.current === null ? '## The guideline' : `## The current guideline, version ${read.current.version}`, '',
      texts.guideline.trimEnd()]
    const whole = [...head, ...comments, ...rest].join('\n')
    if (whole.length <= TalkOpening.MAX_CHARS) return whole
    const short = [...head, '', 'The job and the guideline are too long for this message: read job.md and guideline.md in this folder.'].join('\n')
    const withComments = [short, ...comments].join('\n')
    if (withComments.length <= TalkOpening.MAX_CHARS) return withComments
    const room = TalkOpening.MAX_CHARS - short.length - TalkOpening.CUT.length - 40
    return [short, '', '## The owner\'s comments', '', `${texts.comments.slice(0, Math.max(0, room)).trimEnd()}${TalkOpening.CUT}`].join('\n')
  }
}

/** The link that opens Claude Desktop on the talk folder with the opening message written: `claude://code/new?folder=…&q=…`, every value URL-encoded. */
export class TalkLink {
  static readonly BASE = 'claude://code/new'
  static of(folder: string, message: string): string {
    // `encodeURIComponent`, not `URLSearchParams`: the latter writes a space as `+`, which the link's reader may not read back as a space.
    return `${TalkLink.BASE}?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(message)}`
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
  /** The name of the talk's one MCP server, as Claude Desktop lists it. */
  static readonly SERVER_NAME = 'zees-factory-propose'
  static readonly FILES = { settings: join('.claude', 'settings.json'), mcp: '.mcp.json', job: 'job.md', comments: 'comments.md', guideline: 'guideline.md', state: 'talk.json' } as const
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
   * Then the folder is made its own git repository (once) and every file written is committed, a fresh talk as a new commit on top. Claude Desktop
   * then takes the folder itself as the project, not a repository above it (the owner's home folder can be one), so a session it starts in a git
   * worktree still holds the talk's files, its deny rules and its propose server. No remote is set; nothing is pushed. When git fails the start is
   * refused and `talk.json` is removed again, so the talk does not count as started.
   */
  write(files: { mcp: string; job: string; comments: string; guideline: string; state: TalkState }, mask: (text: string) => string): void {
    const plain: [string, string][] = [[TalkFolder.FILES.settings, TalkFolder.SETTINGS], [TalkFolder.FILES.mcp, files.mcp], [TalkFolder.FILES.job, files.job],
      [TalkFolder.FILES.comments, files.comments], [TalkFolder.FILES.guideline, files.guideline], [TalkFolder.FILES.state, `${JSON.stringify(files.state, null, 2)}\n`]]
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
      rmSync(join(this.path, TalkFolder.FILES.state), { force: true })
      throw new TalkRefusal(503, 'The review talk could not be prepared: the talk folder could not be committed to its own git repository')
    }
  }

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

/** What `ReviewTalks.start` did: opened a talk (with the link to hand the browser), or found one already started and opened nothing. */
export type TalkStart = { opened: true; link: string; state: TalkState } | { opened: false; state: TalkState }

export interface ReviewTalksOptions {
  /** The factory's records module: the mask, the step reader and the guideline reader. */
  records: RecordsSource
  /** The shared token's file, which the propose server reads on every call. */
  tokenFile: string
  /** How the page names a step. */
  words: StepWords
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
  private readonly serverFile: string | undefined
  private readonly node: string
  private readonly home: string
  private readonly now: () => Date
  constructor(options: ReviewTalksOptions) {
    this.records = options.records
    this.tokenFile = options.tokenFile
    this.texts = new TalkTexts(options.words)
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
   * Prepares the talk of `job`, whose propose tool will post to `address`, and returns the link that opens it. A job whose talk was started already gets
   * nothing new unless `fresh` is set: then its files are written again from the records of now, with a new date.
   * Refuses with 409 when the owner has not commented on the job, and with 503 when it cannot be prepared (no mask, no propose server, no folder); then
   * nothing is marked as started.
   */
  async start(job: RecordedJob, address: string, fresh: boolean): Promise<TalkStart> {
    const comments = new TalkComments(job)
    if (comments.entries.length === 0) throw new TalkRefusal(409, TalkComments.NONE)
    const folder = TalkFolder.of(this.root, job)
    const existing = folder.state()
    if (existing !== undefined && !fresh) return { opened: false, state: existing }
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
    folder.write({ mcp, job: texts.job, comments: texts.comments, guideline: texts.guideline, state }, mask)
    return { opened: true, link: TalkLink.of(folder.path, mask(TalkOpening.build(job, texts, read))), state: folder.state() ?? { ...state, title } }
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
}
