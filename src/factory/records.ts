/**
 * The job log and the owner's comments: how a line reaches `<project>/.factory/actions.jsonl` or `<project>/.factory/reviews.jsonl`, and how both are read back.
 * A job is one stretch of the super agent's work. `JobRecorder` builds and writes its lines, one for every kind the factory lists; so far the plugin itself
 * writes only the `job_start` line of the job that begins when it starts. `ReviewWriter` writes the owner's comment on a whole job or on one step, for the
 * review page (`review.ts`).
 * The shapes, the mask and the reader are the factory's own: this package does not copy them. It loads the factory's built file `lib/dist/jobLog.js` from the
 * absolute path in the plugin's `recordsModule` setting, passes every line through its mask before the line is appended, and reads the files with its reader.
 * Without a working module nothing is written and nothing is read.
 * This file imports only Node's own modules and uses only TypeScript that Node can strip (no constructor parameter properties), so the factory's
 * contract test and a test's child process can run it with Node straight from source.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** What a job log line can say happened. The factory's `lib/jobLog` holds the list (`JobLogSchema.KINDS`); this type follows it. */
export type JobLogKind = 'job_start' | 'job_stop' | 'permission_answer' | 'fork_answer' | 'message_in' | 'message_out' | 'session_start' | 'session_steer'
/**
 * One line of `actions.jsonl`, the job log, in the shape the factory's `lib/jobLog` checks. Which optional fields a line may or must have depends on its kind:
 * `ref` on the two answer kinds and `session_start`, `from` and `to` on the two message kinds, `dsh_session_id` and `guideline_version` on `job_start`.
 */
export interface JobLogLine {
  ts: string; project: string; job_id: string; step_id: string; kind: JobLogKind; summary: string
  ref?: string; tokens?: number; ms?: number; from?: string; to?: string; dsh_session_id?: string; guideline_version?: string
}
/** One line of `reviews.jsonl`: the owner's comment on a whole job, or on one step of it when `step_id` is there. */
export interface ReviewLine { ts: string; project: string; job_id: string; step_id?: string; comment: string }
/**
 * What the code at the place an action happens knows about it, for `JobRecorder.record`: the recorder adds the time and a new `step_id`.
 * Leave out what is not known: a cost that was not measured, or a session id the plugin has not learnt yet.
 */
export interface JobStep {
  kind: JobLogKind; project: string; jobId: string; summary: string
  ref?: string; tokens?: number; ms?: number; from?: string; to?: string; dshSessionId?: string; guidelineVersion?: string
}
/** What the factory's reader gives for one project: its job log lines and its comment lines, each list in file order. */
export interface ReadJobLog { actions: JobLogLine[]; reviews: ReviewLine[] }
/**
 * A request the fixed checks (the gate's static rules) answered on their own, read from the project's `requests.jsonl`: what was asked and the answer,
 * `allow` ("automatic yes") or `refuse` ("automatic no"). The shape is the factory's (`lib/jobLog`, `AutomaticAnswer`); this type follows it.
 */
export interface AutomaticAnswer {
  ts: string; request_id: string; session_id: string; tool_name: string; tool_input: unknown; reason: string; answer: 'allow' | 'refuse'
}
/** One row of a job's timeline: a job log line, or an automatic answer given while the job ran. */
export type TimelineStep = { automatic: false; ts: string; line: JobLogLine } | { automatic: true; ts: string; answer: AutomaticAnswer }
/**
 * One job as the factory's `JobsReader` gives it: `number` counts the project's jobs from its oldest (1); `stopped` is null when the job ended without a
 * `job_stop` line; `last` is its last line's time; `steps` are in time order; `reviews` are its comment lines in file order.
 */
export interface RecordedJob {
  project: string; job_id: string; number: number; started: string; stopped: string | null; last: string; guideline_version?: string
  steps: TimelineStep[]; reviews: ReviewLine[]
}
/** One target project as the factory's `JobsReader` gives it: its jobs, newest first, and the automatic answers that fell in no job, in time order. */
export interface ProjectJobs { project: string; jobs: RecordedJob[]; outside: AutomaticAnswer[] }
/** What a step asked or said: a permission request in full, a message with its sender and receiver, or another step's own words. */
export type StepAsked =
  | { kind: 'request'; tool_name: string; tool_input: unknown; reason: string; session_id: string }
  | { kind: 'message'; text: string; from: string; to: string }
  | { kind: 'step'; text: string }
/** Why the step went as it did: the super agent's decision and its reasoning, or the fixed checks' own answer. */
export type StepWhy =
  | { by: 'super_agent'; decision: 'approve' | 'deny' | 'ask_owner'; choice: string | null; risk: 'low' | 'medium' | 'high'; reason: string; alternative: string; cites: string }
  | { by: 'fixed_checks'; answer: AutomaticAnswer['answer'] }
/** What happened after a request, read from the worker's transcript: it ran and succeeded or failed, was refused, the owner said no, or it cannot be told yet. */
export interface StepOutcome { outcome: 'ran_ok' | 'ran_failed' | 'refused' | 'owner_no' | 'unknown'; tool_use_id: string | null; detail: string }
/**
 * One step's detail as the factory's `StepDetailReader` gives it, read through the step's pointers from the records that hold each part. A part is `null`
 * when no record holds it for this step. The shape is the factory's (`lib/jobLog`, `StepDetail`); this type follows it.
 */
export interface StepDetail {
  asked: StepAsked | null; looked_at: { path: string; used: boolean }[] | null; why: StepWhy | null; next: StepOutcome | null; cost: { tokens: number; seconds: number } | null
}

/**
 * Represents a record that could not be written or read, with the HTTP status the review page answers.
 * 409 is a project that cannot take the line (no `.factory/` folder, or a symlink in the way); 503 is a records module that is missing or does not work.
 * Nothing is written in either case.
 */
export class RecordsRefusal extends Error {
  readonly status: 409 | 503
  constructor(status: 409 | 503, message: string) { super(message); this.status = status }
}

/**
 * Appends lines to one record file in a project's `.factory/` folder, and never rewrites or removes one.
 * It never creates `.factory/`: only the factory's own record writer does, so a project without the folder is refused.
 * A symlink at the folder's or the file's place is refused too, so a line cannot land in another folder, and so is anything there that is not a
 * regular file, such as a named pipe, which could otherwise hold the open, and with it all of DSH, forever.
 * It writes the line as it is given: `JobRecorder` and `ReviewWriter` are the ones that mask it first.
 */
export class FactoryRecordFile {
  static readonly FOLDER = '.factory'
  static readonly ACTIONS = 'actions.jsonl'
  static readonly REVIEWS = 'reviews.jsonl'
  readonly project: string
  readonly file: typeof FactoryRecordFile.ACTIONS | typeof FactoryRecordFile.REVIEWS
  constructor(project: string, file: typeof FactoryRecordFile.ACTIONS | typeof FactoryRecordFile.REVIEWS) { this.project = project; this.file = file }
  /** Whether the project has a real `.factory/` folder. lstat does not follow a symlink, so a link to a folder does not count as the folder. */
  static hasFolder(project: string): boolean {
    try { return lstatSync(join(project, FactoryRecordFile.FOLDER)).isDirectory() } catch { return false }
  }
  /** Appends the line after whatever the file already holds, and returns the exact text written, without its line break. */
  append(line: object): string {
    if (!FactoryRecordFile.hasFolder(this.project)) throw new RecordsRefusal(409, `The project has no ${FactoryRecordFile.FOLDER} folder yet`)
    const text = JSON.stringify(line)
    let fd: number
    const irregular = () => new RecordsRefusal(409, `Refusing to write to ${this.file}: it is not a regular file`)
    // Append-only, and NOFOLLOW makes the open fail when the file's place holds a symlink. NONBLOCK keeps a named pipe there from hanging the call.
    try { fd = openSync(join(this.project, FactoryRecordFile.FOLDER, this.file), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ELOOP') throw new RecordsRefusal(409, `Refusing to write through a symlink at ${this.file}`)
      // A named pipe that nobody reads from answers a non-blocking open with ENXIO.
      if (code === 'ENXIO') throw irregular()
      throw error
    }
    try {
      // Checked on the opened file, so it cannot be swapped between the check and the write.
      if (!fstatSync(fd).isFile()) throw irregular()
      writeSync(fd, `${text}\n`, null, 'utf8')
    } finally { closeSync(fd) }
    return text
  }
}

/**
 * Cleans one line of either file: the result holds no secret and nothing that says who the owner is. Each method throws when the line is not in its shape.
 * `maskText` cleans one plain text with the same mask, for the review talk's files and the opening message of its link (`talk.ts`). It is optional so a
 * built file from before the review talk still masks comments; the review talk refuses to start without it.
 */
export interface RecordsMasker { maskAction(line: JobLogLine): JobLogLine; maskReview(line: ReviewLine): ReviewLine; maskText?(text: string): string }
/** Reads one project's job log and comments. It skips what it cannot read and never throws. */
export interface RecordsReader { read(project: string): ReadJobLog }
/** Reads every listed project's records back as jobs, one entry per project in the order given. It skips what it cannot read and never throws. */
export interface JobsSource { read(projects: readonly string[]): ProjectJobs[] }
/** Reads one step's detail, for a step of a job of `project` as `JobsSource` gave it. It skips what it cannot read and never throws. */
export interface StepSource { read(project: string, step: TimelineStep): StepDetail }
/** One version of the super agent's decision guideline, as the factory's `GuidelineReader` reads it from `guideline/v<N>.md` in the factory repository. */
export interface GuidelineVersion { version: number; date: string | null; from_job: string | null; from_version: number | null; text: string }
/**
 * The guideline's versions, newest first, and the current one (the highest number). With none, `reason` says why: there is no version yet, or the factory
 * repository was not found (`folder` is then null).
 */
export interface GuidelineRead { folder: string | null; versions: GuidelineVersion[]; current: GuidelineVersion | null; reason: string | null }
/** Reads the guideline's versions. It never throws. */
export interface GuidelineSource { read(): GuidelineRead }
/** Gives the masker of one project and the four readers. Each rejects with `RecordsRefusal(503)` when there is none. */
export interface RecordsSource {
  maskerFor(project: string): Promise<RecordsMasker>; reader(): Promise<RecordsReader>; jobsReader(): Promise<JobsSource>; stepReader(): Promise<StepSource>
  guidelineReader(): Promise<GuidelineSource>
}
/**
 * What the factory's built job log file exports: `JobLogMask.forProject(project)` gives the masker of that project, `new JobLogReader()` the reader of
 * one project's lines, `new JobsReader()` the reader of the projects' jobs, `new StepDetailReader()` the reader of one step's detail, and
 * `new GuidelineReader()` the reader of the decision guideline's versions, which finds the factory repository itself.
 */
interface RecordsModuleExports { JobLogMask?: { forProject?: unknown }; JobLogReader?: unknown; JobsReader?: unknown; StepDetailReader?: unknown; GuidelineReader?: unknown }

/**
 * The factory's job log code, loaded from its built file `lib/dist/jobLog.js`.
 * The file is imported on first use, not at start, so the plugin starts without it; a masker is built once for each project and each reader once.
 * Any failure is a 503: no path given, a path that is not absolute, a file that does not load, a file without `JobLogMask.forProject`, `JobLogReader`,
 * `JobsReader`, `StepDetailReader` or `GuidelineReader` (each checked only when it is needed), or a masker or reader that cannot be built.
 * Like the mask file of the decisions (`FactoryMaskModule`), Node keeps the file once it has loaded it, so a rebuilt file takes effect only after DSH restarts.
 * The refusal says which step failed and never repeats the error's own text, which could quote what was to be masked.
 */
export class FactoryRecordsModule implements RecordsSource {
  private readonly maskers = new Map<string, RecordsMasker>()
  private kept: RecordsReader | undefined
  private keptJobs: JobsSource | undefined
  private keptSteps: StepSource | undefined
  private keptGuideline: GuidelineSource | undefined
  readonly path: string | undefined
  constructor(path?: string) { this.path = path }
  async maskerFor(project: string): Promise<RecordsMasker> {
    const known = this.maskers.get(project)
    if (known) return known
    const loaded = await this.load()
    const forProject = loaded.JobLogMask?.forProject
    if (typeof forProject !== 'function') throw new RecordsRefusal(503, 'The configured recordsModule does not export JobLogMask.forProject, so no record is written')
    let masker: unknown
    try { masker = forProject.call(loaded.JobLogMask, project) }
    catch { throw new RecordsRefusal(503, 'The configured recordsModule could not build a mask for the project, so no record is written') }
    if (masker === null || typeof masker !== 'object' || typeof (masker as RecordsMasker).maskAction !== 'function' || typeof (masker as RecordsMasker).maskReview !== 'function') {
      throw new RecordsRefusal(503, 'The configured recordsModule gave no masker for the project, so no record is written')
    }
    this.maskers.set(project, masker as RecordsMasker)
    return masker as RecordsMasker
  }
  async reader(): Promise<RecordsReader> {
    this.kept ??= await this.build('JobLogReader', 'reader')
    return this.kept
  }
  async jobsReader(): Promise<JobsSource> {
    this.keptJobs ??= await this.build('JobsReader', 'jobs reader')
    return this.keptJobs
  }
  async stepReader(): Promise<StepSource> {
    this.keptSteps ??= await this.build('StepDetailReader', 'step reader')
    return this.keptSteps
  }
  async guidelineReader(): Promise<GuidelineSource> {
    this.keptGuideline ??= await this.build('GuidelineReader', 'guideline reader')
    return this.keptGuideline
  }
  /** Builds the reader class the module exports as `name`, with no arguments; every reader has one method, `read`. */
  private async build<Reader extends { read(...args: never[]): unknown }>(name: 'JobLogReader' | 'JobsReader' | 'StepDetailReader' | 'GuidelineReader', what: string): Promise<Reader> {
    const Class = (await this.load())[name]
    if (typeof Class !== 'function') throw new RecordsRefusal(503, `The configured recordsModule does not export ${name}, so no record is read`)
    let reader: unknown
    try { reader = new (Class as new () => unknown)() }
    catch { throw new RecordsRefusal(503, `The configured recordsModule could not build a ${what}, so no record is read`) }
    if (reader === null || typeof reader !== 'object' || typeof (reader as Reader).read !== 'function') {
      throw new RecordsRefusal(503, `The configured recordsModule gave no ${what}, so no record is read`)
    }
    return reader as Reader
  }
  private async load(): Promise<RecordsModuleExports> {
    if (this.path === undefined || this.path === '') throw new RecordsRefusal(503, 'No recordsModule is configured, so no job log line or comment is written or read')
    if (!isAbsolute(this.path)) throw new RecordsRefusal(503, 'The configured recordsModule is not an absolute path, so no job log line or comment is written or read')
    try { return await import(pathToFileURL(this.path).href) as RecordsModuleExports }
    catch { throw new RecordsRefusal(503, 'The configured recordsModule could not be loaded, so no job log line or comment is written or read') }
  }
}

/**
 * Writes the job log: builds a line from what the caller knows (`record`), masks it, then appends the masked line to its project's `actions.jsonl`.
 * `lineOf` is the one place in this package that names the fields of a job log line; the factory's contract test runs it for every kind.
 * `start` is what the plugin calls once when it starts: it begins a new job in the folder DSH was started in, when that folder is a listed project
 * that already has its `.factory/` folder. In every other case it writes nothing, says why in one warning and lets DSH start.
 */
export class JobRecorder {
  /** What the `job_start` line says. */
  static readonly START_SUMMARY = 'The super agent\'s factory plugin started.'
  private readonly projects: readonly string[]
  private readonly records: RecordsSource
  private readonly now: () => Date
  private readonly newId: () => string
  constructor(records: RecordsSource, projects: readonly string[], now: () => Date = () => new Date(), newId: () => string = randomUUID) {
    this.records = records
    this.now = now
    this.newId = newId
    // Normalised, as the `/assess` route does, so an entry written with a trailing slash still names the same folder.
    this.projects = projects.filter(project => isAbsolute(project)).map(project => resolve(project))
  }
  /** The job log line for `step`, stamped with the time now and a new `step_id`. A field the step does not have is left out, never written empty. */
  lineOf(step: JobStep): JobLogLine {
    const line: JobLogLine = { ts: this.now().toISOString(), project: step.project, job_id: step.jobId, step_id: this.newId(), kind: step.kind, summary: step.summary }
    const known: Omit<JobLogLine, 'ts' | 'project' | 'job_id' | 'step_id' | 'kind' | 'summary'> = {
      ref: step.ref, tokens: step.tokens, ms: step.ms, from: step.from, to: step.to, dsh_session_id: step.dshSessionId, guideline_version: step.guidelineVersion,
    }
    for (const [name, value] of Object.entries(known)) if (value !== undefined) Object.assign(line, { [name]: value })
    return line
  }
  /** Builds the line for `step`, masks it and appends it. Returns the exact text written, without its line break. Rejects with `RecordsRefusal`, and then nothing is written. */
  async record(step: JobStep): Promise<string> {
    return this.write(this.lineOf(step))
  }
  /** Masks one line and appends it. Returns the exact text written, without its line break. Rejects with `RecordsRefusal`, and then nothing is written. */
  async write(line: JobLogLine): Promise<string> {
    const masker = await this.records.maskerFor(line.project)
    let masked: JobLogLine
    try { masked = masker.maskAction(line) }
    catch { throw new RecordsRefusal(503, 'The job log line could not be masked, so it is not written') }
    if (masked === null || typeof masked !== 'object' || Array.isArray(masked)) throw new RecordsRefusal(503, 'The job log line could not be masked, so it is not written')
    return new FactoryRecordFile(line.project, FactoryRecordFile.ACTIONS).append(masked)
  }
  /**
   * Begins a job in `folder`, the folder DSH was started in: one `job_start` line with a new `step_id`. The line takes `job.jobId` when given, else a
   * new `job_id`, and `job.dshSessionId` and `job.guidelineVersion` when given.
   * Returns the line as it was handed to the mask, or `undefined` when none was written; `warn` is then called once with the reason. It never throws.
   */
  async start(folder: string, warn: (message: string) => void, job: { jobId?: string; dshSessionId?: string; guidelineVersion?: string } = {}): Promise<JobLogLine | undefined> {
    let reason: string
    try {
      const project = this.listed(folder)
      if (project === undefined) reason = `the folder DSH was started in (${folder}) is not a listed project`
      else if (!FactoryRecordFile.hasFolder(project)) reason = `${project} has no ${FactoryRecordFile.FOLDER} folder yet`
      else {
        const line = this.lineOf({ kind: 'job_start', project, jobId: job.jobId ?? this.newId(), summary: JobRecorder.START_SUMMARY,
          dshSessionId: job.dshSessionId, guidelineVersion: job.guidelineVersion })
        await this.write(line)
        return line
      }
    } catch (error) {
      // A refusal's message is this file's own words. Any other error's text is left out: it could quote what was to be masked.
      reason = error instanceof RecordsRefusal ? error.message : 'the line could not be appended'
    }
    // A log that fails must not stop DSH either.
    try { warn(`No job_start line was written: ${reason}`) } catch { /* nothing more can be said */ }
    return undefined
  }
  /** The listed project that `folder` is, or `undefined`. Compared as the system names each folder, so `/tmp/x` and `/private/tmp/x` are one folder on macOS. */
  private listed(folder: string): string | undefined {
    const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
    const started = real(folder)
    return this.projects.find(project => real(project) === started)
  }
}

/**
 * Writes the owner's comment on a whole job, or on one step when the line has a `step_id`: masks the line, then appends the masked line to its project's `reviews.jsonl`.
 * A changed comment is a new line; the newest line of a job is the one that counts. A line that cannot be masked is not written.
 */
export class ReviewWriter {
  private readonly records: RecordsSource
  constructor(records: RecordsSource) { this.records = records }
  /** Returns the exact text written, without its line break. Rejects with `RecordsRefusal`, and then nothing is written. */
  async write(line: ReviewLine): Promise<string> {
    const masker = await this.records.maskerFor(line.project)
    let masked: ReviewLine
    try { masked = masker.maskReview(line) }
    catch { throw new RecordsRefusal(503, 'The comment could not be masked, so it is not written') }
    if (masked === null || typeof masked !== 'object' || Array.isArray(masked)) throw new RecordsRefusal(503, 'The comment could not be masked, so it is not written')
    return new FactoryRecordFile(line.project, FactoryRecordFile.REVIEWS).append(masked)
  }
}
