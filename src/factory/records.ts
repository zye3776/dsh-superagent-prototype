/**
 * The job log and the owner's comments: how a line reaches `<project>/.factory/actions.jsonl` or `<project>/.factory/reviews.jsonl`, and how both are read back.
 * A job is one stretch of the super agent's work. `JobRecorder` writes its lines, for now only the `job_start` line of the job that begins when the plugin
 * starts; `ReviewWriter` writes the owner's comment on a whole job, for the review page (`review.ts`).
 * The shapes, the mask and the reader are the factory's own: this package does not copy them. It loads the factory's built file `lib/dist/jobLog.js` from the
 * absolute path in the plugin's `recordsModule` setting, passes every line through its mask before the line is appended, and reads the files with its reader.
 * Without a working module nothing is written and nothing is read.
 * This file imports only Node's own modules, so the factory's contract test can run it with Node straight from source.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One line of `actions.jsonl`, the job log, in the shape the factory's `lib/jobLog` checks. `kind` has one value so far. */
export interface JobLogLine { ts: string; project: string; job_id: string; step_id: string; kind: 'job_start'; summary: string }
/** One line of `reviews.jsonl`: the owner's comment on a whole job. */
export interface ReviewLine { ts: string; project: string; job_id: string; comment: string }
/** What the factory's reader gives for one project: its job log lines and its comment lines, each list in file order. */
export interface ReadJobLog { actions: JobLogLine[]; reviews: ReviewLine[] }

/**
 * Represents a record that could not be written or read, with the HTTP status the review page answers.
 * 409 is a project that cannot take the line (no `.factory/` folder, or a symlink in the way); 503 is a records module that is missing or does not work.
 * Nothing is written in either case.
 */
export class RecordsRefusal extends Error { constructor(readonly status: 409 | 503, message: string) { super(message) } }

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
  constructor(readonly project: string, readonly file: typeof FactoryRecordFile.ACTIONS | typeof FactoryRecordFile.REVIEWS) {}
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

/** Cleans one line of either file: the result holds no secret and nothing that says who the owner is. Each method throws when the line is not in its shape. */
export interface RecordsMasker { maskAction(line: JobLogLine): JobLogLine; maskReview(line: ReviewLine): ReviewLine }
/** Reads one project's job log and comments. It skips what it cannot read and never throws. */
export interface RecordsReader { read(project: string): ReadJobLog }
/** Gives the masker of one project and the reader. Each rejects with `RecordsRefusal(503)` when there is none. */
export interface RecordsSource { maskerFor(project: string): Promise<RecordsMasker>; reader(): Promise<RecordsReader> }
/** What the factory's built job log file exports: `JobLogMask.forProject(project)` gives the masker of that project, `new JobLogReader()` the reader. */
interface RecordsModuleExports { JobLogMask?: { forProject?: unknown }; JobLogReader?: unknown }

/**
 * The factory's job log code, loaded from its built file `lib/dist/jobLog.js`.
 * The file is imported on first use, not at start, so the plugin starts without it; a masker is built once for each project and the reader once.
 * Any failure is a 503: no path given, a path that is not absolute, a file that does not load, a file without `JobLogMask.forProject` or `JobLogReader`,
 * or a masker or reader that cannot be built.
 * Like the mask file of the decisions (`FactoryMaskModule`), Node keeps the file once it has loaded it, so a rebuilt file takes effect only after DSH restarts.
 * The refusal says which step failed and never repeats the error's own text, which could quote what was to be masked.
 */
export class FactoryRecordsModule implements RecordsSource {
  private readonly maskers = new Map<string, RecordsMasker>()
  private kept: RecordsReader | undefined
  constructor(readonly path?: string) {}
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
    if (this.kept) return this.kept
    const Reader = (await this.load()).JobLogReader
    if (typeof Reader !== 'function') throw new RecordsRefusal(503, 'The configured recordsModule does not export JobLogReader, so no record is read')
    let reader: unknown
    try { reader = new (Reader as new () => unknown)() }
    catch { throw new RecordsRefusal(503, 'The configured recordsModule could not build a reader, so no record is read') }
    if (reader === null || typeof reader !== 'object' || typeof (reader as RecordsReader).read !== 'function') {
      throw new RecordsRefusal(503, 'The configured recordsModule gave no reader, so no record is read')
    }
    this.kept = reader as RecordsReader
    return this.kept
  }
  private async load(): Promise<RecordsModuleExports> {
    if (this.path === undefined || this.path === '') throw new RecordsRefusal(503, 'No recordsModule is configured, so no job log line or comment is written or read')
    if (!isAbsolute(this.path)) throw new RecordsRefusal(503, 'The configured recordsModule is not an absolute path, so no job log line or comment is written or read')
    try { return await import(pathToFileURL(this.path).href) as RecordsModuleExports }
    catch { throw new RecordsRefusal(503, 'The configured recordsModule could not be loaded, so no job log line or comment is written or read') }
  }
}

/**
 * Writes the job log: masks a line, then appends the masked line to its project's `actions.jsonl`.
 * `start` is what the plugin calls once when it starts: it begins a new job in the folder DSH was started in, when that folder is a listed project
 * that already has its `.factory/` folder. In every other case it writes nothing, says why in one warning and lets DSH start.
 */
export class JobRecorder {
  /** What the `job_start` line says. */
  static readonly START_SUMMARY = 'The super agent\'s factory plugin started.'
  private readonly projects: readonly string[]
  constructor(private readonly records: RecordsSource, projects: readonly string[], private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID) {
    // Normalised, as the `/assess` route does, so an entry written with a trailing slash still names the same folder.
    this.projects = projects.filter(project => isAbsolute(project)).map(project => resolve(project))
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
   * Begins a new job in `folder`, the folder DSH was started in: one `job_start` line with a new `job_id` and `step_id`.
   * Returns the line as it was handed to the mask, or `undefined` when none was written; `warn` is then called once with the reason. It never throws.
   */
  async start(folder: string, warn: (message: string) => void): Promise<JobLogLine | undefined> {
    let reason: string
    try {
      const project = this.listed(folder)
      if (project === undefined) reason = `the folder DSH was started in (${folder}) is not a listed project`
      else if (!FactoryRecordFile.hasFolder(project)) reason = `${project} has no ${FactoryRecordFile.FOLDER} folder yet`
      else {
        const line: JobLogLine = { ts: this.now().toISOString(), project, job_id: this.newId(), step_id: this.newId(), kind: 'job_start', summary: JobRecorder.START_SUMMARY }
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
 * Writes the owner's comment on a whole job: masks the line, then appends the masked line to its project's `reviews.jsonl`.
 * A changed comment is a new line; the newest line of a job is the one that counts. A line that cannot be masked is not written.
 */
export class ReviewWriter {
  constructor(private readonly records: RecordsSource) {}
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
