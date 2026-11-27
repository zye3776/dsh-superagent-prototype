/**
 * Trend reports (architecture AD-18, ticket R10): for one guideline version, the super agent's own review of the patterns and failures in its actions
 * while that version was in force, written from the jobs that ran under it and the owner's comments on them, naming the version before it.
 *
 * The fork's own code builds the whole question from the records (`TrendPrompt`) and asks a one-off, read-only model thread for the report
 * (`TrendWriter`). That thread is a fresh judge Session: DSH's `read-only` preset, the judge's tool limit and guard, and, like every thread DSH
 * creates, the current guideline in its system prompt (`GuidelineSection`). The model only answers; it starts nothing. The report is saved as
 * `guideline/v<N>-trends.md` by the save path of `save.ts`: in the same commit as the next version when that one is accepted, or on its own when the
 * owner asks for the current version's report on the page.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { AskedJudge, JudgeOpener } from './judge.ts'
import { RecordsRefusal, type GuidelineVersion, type RecordedJob, type TrendReport } from './records.ts'

/** A trend report's file, `guideline/v<N>-trends.md`: its name, its text, and how it is read back. */
export class TrendReportFile {
  static readonly NAME = /^v(\d+)-trends\.md$/
  static nameOf(version: number): string { return `v${version}-trends.md` }
  /** The file's path inside the repository, as git names it. */
  static pathOf(version: number): string { return `guideline/${TrendReportFile.nameOf(version)}` }

  /** A report file: front matter `version`, `date`, `jobs`, `compared_with` (when there is a version before it) and `written`; then the text. */
  static textOf(meta: { version: number; date: string; jobs: number; compared_with: number | null; written: 'accepted' | 'asked' }, text: string): string {
    const front = ['---', `version: ${meta.version}`, `date: ${meta.date.replace(/\s+/g, ' ').trim()}`, `jobs: ${meta.jobs}`,
      ...(meta.compared_with === null ? [] : [`compared_with: ${meta.compared_with}`]), `written: ${meta.written}`, '---']
    return `${front.join('\n')}\n${text}${text.endsWith('\n') ? '' : '\n'}`
  }

  /** One report from a file named `name` with the text `file`, or `null` for a name that is not a report's. A field it does not say is `null`. */
  static parse(name: string, file: string): TrendReport | null {
    const match = TrendReportFile.NAME.exec(name)
    if (match === null) return null
    const version = Number(match[1])
    const lines = file.split('\n')
    const isFence = (line: string) => line.replace(/\r$/, '') === '---'
    const closing = isFence(lines[0] ?? '') ? lines.findIndex((line, index) => index > 0 && isFence(line)) : -1
    const report: TrendReport = { version, date: null, jobs: null, compared_with: null, written: null, text: file }
    if (closing < 0) return report
    const fields = new Map<string, string>()
    for (const line of lines.slice(1, closing)) {
      const found = /^([^:\s]+):(.*)$/.exec(line.replace(/\r$/, ''))
      const value = found?.[2]!.trim()
      if (found && value !== '') fields.set(found[1]!, value!)
    }
    const count = (value: string | undefined) => value !== undefined && /^\d+$/.test(value) ? Number(value) : null
    const written = fields.get('written')
    return {
      version, date: fields.get('date') ?? null, jobs: count(fields.get('jobs')), compared_with: count(fields.get('compared_with')),
      written: written === 'accepted' || written === 'asked' ? written : null, text: lines.slice(closing + 1).join('\n'),
    }
  }
}

/** What one report is written from: the version, the version before it (`null` for the first), and the jobs that ran under the version. */
export interface TrendInput { version: GuidelineVersion; before: GuidelineVersion | null; jobs: readonly RecordedJob[] }

/**
 * The one message the report thread is asked: what to write, the version and the one before it, then each job's steps and the owner's comments, all
 * from the masked records. A step's summary is cut at `STEP_CHARS` and the whole message at `MAX_CHARS`, with a line saying so.
 */
export class TrendPrompt {
  static readonly STEP_CHARS = 300
  static readonly MAX_CHARS = 100_000
  static readonly CUT = '[The rest of the jobs is left out: the message reached its length limit.]'

  /** The jobs that ran under version `version` (their `job_start` named `v<N>`), oldest first, across every listed project. */
  static jobsUnder(projects: readonly { jobs: readonly RecordedJob[] }[], version: number): RecordedJob[] {
    return projects.flatMap(each => each.jobs).filter(job => job.guideline_version === `v${version}`)
      .sort((left, right) => left.started < right.started ? -1 : left.started > right.started ? 1 : 0)
  }

  static textOf(input: TrendInput): string {
    const { version, before, jobs } = input
    const head = [
      `Write the trend report for the owner's decision guideline v${version.version}: your own review of the patterns and failures in your actions while v${version.version} was in force.`,
      'Write it from the jobs below and the owner\'s comments on them, in plain English, readable in a few minutes, with no praise or blame.',
      before === null ? 'This is the first version: there is none before it to compare with.' : `Say what changed compared with v${before.version}, the version before it.`,
      'Cover what went well, what still goes wrong, and what the owner\'s comments say most. Name jobs by project and number.',
      'Answer with the report text only, in markdown, without a title. Use no tool, start nothing and change nothing: everything you need is in this message.',
      '',
      `## Guideline v${version.version}`,
      version.text.trim(),
      '',
      ...(before === null ? [] : [`## Guideline v${before.version}, the version before it`, before.text.trim(), '']),
      `## Jobs under v${version.version} (${jobs.length})`,
      ...(jobs.length === 0 ? ['No job ran under this version.'] : []),
    ].join('\n')
    let text = head
    for (const job of jobs) {
      const part = `\n${TrendPrompt.jobText(job)}`
      if (text.length + part.length > TrendPrompt.MAX_CHARS) { text += `\n${TrendPrompt.CUT}`; break }
      text += part
    }
    return text
  }

  private static jobText(job: RecordedJob): string {
    const cut = (value: string) => {
      const line = value.replace(/\s+/g, ' ').trim()
      return line.length > TrendPrompt.STEP_CHARS ? `${line.slice(0, TrendPrompt.STEP_CHARS)}…` : line
    }
    const steps = job.steps.map(step => step.automatic
      ? `- ${step.ts} automatic ${step.answer.answer}: ${cut(`${step.answer.tool_name} ${step.answer.reason}`)}`
      : `- ${step.ts} ${step.line.kind}${step.line.from === undefined && step.line.to === undefined ? '' : ` (${step.line.from ?? '?'} → ${step.line.to ?? '?'})`} [${step.line.step_id}]: ${cut(step.line.summary)}`)
    const comments = job.reviews.map(review => `- ${review.step_id === undefined ? 'on the whole job' : `on step ${review.step_id}`}: ${cut(review.comment)}`)
    return [`### ${basename(job.project) || job.project} job ${job.number}, ${job.started} to ${job.stopped ?? 'no stop'}`, ...steps,
      comments.length === 0 ? 'The owner left no comment on this job.' : 'The owner\'s comments:', ...comments].join('\n')
  }
}

/** A written report: its file's body (not yet masked) and how many jobs it was written from. */
export interface WrittenTrend { body: string; jobs: number }
/** Writes one report. `TrendWriter` is the real one; tests give a stand-in that asks no model. */
export interface TrendAuthor { write(input: TrendInput, signal?: AbortSignal): Promise<WrittenTrend> }

/**
 * Asks a fresh read-only model thread for one report and gives the report's body: the fork's own title line and the line that names the version
 * before it, then the model's text, then the `Spent:` and `Providers:` lines of the Reports convention. Every failure is a `RecordsRefusal(503)` in
 * plain words, so nothing is saved: no thread could be opened, no answer came in time, or the answer was empty.
 */
export class TrendWriter implements TrendAuthor {
  static readonly TIMEOUT_MS = 300_000
  /** The `Providers:` line's value when the thread's Session names no provider: where the model is set. */
  static readonly PROVIDERS = 'dsh (the model set in its factory profile)'
  static readonly SESSION_PREFIX = 'trend-report-'
  constructor(private readonly options: { opener: JudgeOpener; projects: readonly string[]; timeoutMs?: number }) {}

  async write(input: TrendInput, signal: AbortSignal = AbortSignal.timeout(this.options.timeoutMs ?? TrendWriter.TIMEOUT_MS)): Promise<WrittenTrend> {
    const folder = input.jobs[0]?.project ?? this.options.projects[0]
    if (folder === undefined) throw new RecordsRefusal(503, 'no target project is listed to run the report thread in')
    // A new id each time, so the thread is always a fresh one and never one kept from an earlier report.
    let thread: AskedJudge
    try { thread = await TrendWriter.inTime(this.options.opener.open(folder, `${TrendWriter.SESSION_PREFIX}v${input.version.version}-${randomUUID()}`), signal) }
    catch (error) { throw new RecordsRefusal(503, signal.aborted ? 'the report thread did not answer in time' : error instanceof RecordsRefusal ? error.message : 'the report thread could not be opened') }
    let text: string, tokens: number, model: { provider: string; model: string } | undefined
    try { ({ text, tokens, model } = await thread.consult(TrendPrompt.textOf(input), signal)) }
    catch { throw new RecordsRefusal(503, signal.aborted ? 'the report thread did not answer in time' : 'the report thread could not be asked') }
    if (text.trim() === '') throw new RecordsRefusal(503, 'the report thread gave no answer')
    return { body: TrendWriter.bodyOf(input, text, tokens, model === undefined ? undefined : `${model.provider} (${model.model})`), jobs: input.jobs.length }
  }

  /** The report's body around the model's `text`: the title, the version before it named, and the closing lines. `providers` defaults to `PROVIDERS`. */
  static bodyOf(input: Pick<TrendInput, 'version' | 'before'>, text: string, tokens: number, providers: string = TrendWriter.PROVIDERS): string {
    const compared = input.before === null ? 'This is the first version; there is none before it.' : `Compared with v${input.before.version}.`
    return [`# Trend report for guideline v${input.version.version}`, '', compared, '', text.trim(), '',
      `Spent: ${tokens.toLocaleString('en-US')} tokens`, `Providers: ${providers}`, ''].join('\n')
  }

  /** `open`, unless `signal` gives up first; an open that ends later has nobody waiting for it. */
  private static async inTime<T>(open: Promise<T>, signal: AbortSignal): Promise<T> {
    const late = Promise.withResolvers<never>()
    const giveUp = () => { late.reject(new Error('late')) }
    if (signal.aborted) giveUp()
    signal.addEventListener('abort', giveUp, { once: true })
    try { return await Promise.race([open, late.promise]) } finally {
      open.catch(() => {})
      late.promise.catch(() => {})
      signal.removeEventListener('abort', giveUp)
    }
  }
}
