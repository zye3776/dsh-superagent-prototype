/**
 * The job of one run of the factory plugin: from when DSH starts the plugin until it stops it. `FactoryJob` holds the job's `job_id` and is the one
 * caller of `JobRecorder` in the plugin. The plugin's own code calls it at each place the super agent acts: the `/assess` route after a decision
 * (`answered`), the main session's watcher for each message (`messageIn`, `messageOut`), and the plugin's cleanup (`stop`). The calls for a started or
 * steered session and a technical fork's answer are ready for the stories that will make them.
 * This file imports only Node's own modules and `records.ts`, and uses only TypeScript that Node can strip (no constructor parameter properties),
 * so a test can run it in a process of its own with plain Node straight from source.
 */
import { randomUUID } from 'node:crypto'
import { RecordsRefusal, type JobLogKind, type JobRecorder, type JobStep } from './records.ts'

/** What `/assess` tells the job about one decision it wrote. `seconds` is the time the judge took. */
export interface JobAnswer { project: string; requestId: string; decisionId: string; decision: string; tokens?: number; seconds?: number }
/**
 * Says which decision guideline version is in force for `job_start`: the version the session `sessionId` runs under, or, without an id, the current
 * one, written as `v<N>`; `undefined` when there is none. It never rejects.
 */
export interface JobGuideline { versionOf(sessionId?: string): Promise<string | undefined> }

/**
 * Represents one job and writes its lines to the job log, in the order they are asked for, each through one promise chain.
 * - `job_start` is written once, at the first call of any method (`stop` too), so it is always the job's first line. It goes to the folder DSH was
 *   started in when that is a listed project, and carries the main session's id when `noteMainSession` came first. DSH opens its sessions only after
 *   it starts, so the id cannot be known when the plugin starts. With a `guideline`, it also carries the decision guideline version that session
 *   runs under, or the current one when no main session was noted.
 * - `job_start`, `job_stop` and the two message kinds go to that same project (the "home" project); the other kinds go to the project they concern.
 *   Without a home project the home lines are left out: `JobRecorder.start` has already said why, once.
 * - Nothing is written after `stop`. No method ever rejects: a line that is refused is told to `warn`, and each message is told only once.
 */
export class FactoryJob {
  static readonly SUPER_AGENT = 'super agent'
  static readonly STOP_SUMMARY = 'The super agent\'s factory plugin stopped.'
  readonly id: string
  private readonly recorder: JobRecorder
  private readonly folder: string | undefined
  private readonly warn: (message: string) => void
  private readonly guideline: JobGuideline | undefined
  private chain: Promise<void> = Promise.resolve()
  private started = false
  private stopped = false
  private home: string | undefined
  private mainSession: string | undefined
  private readonly warned = new Set<string>()
  constructor(recorder: JobRecorder, folder: string | undefined, warn: (message: string) => void, newId: () => string = randomUUID, guideline?: JobGuideline) {
    this.recorder = recorder
    this.guideline = guideline
    this.folder = folder
    this.warn = warn
    this.id = newId()
  }

  /** Notes the main session's id for `job_start`, when the job has not started yet, and starts it. Only the first id counts. */
  noteMainSession(sessionId: string): Promise<void> {
    this.mainSession ??= sessionId
    return this.enqueue(async () => {})
  }
  /** A permission request answered by the judge: `ref` is the decision's id, `ms` the judge's time. */
  answered(answer: JobAnswer): Promise<void> {
    return this.step({ kind: 'permission_answer', project: answer.project, summary: `Permission request ${answer.requestId}: ${answer.decision}`, ref: answer.decisionId,
      tokens: answer.tokens, ms: answer.seconds === undefined ? undefined : Math.round(answer.seconds * 1000) })
  }
  /** A message into the main session, from `from`. A message without text writes nothing. */
  messageIn(from: string, text: string): Promise<void> {
    return this.message(text, { kind: 'message_in', from, to: FactoryJob.SUPER_AGENT })
  }
  /** A message out of the main session, to `to`. A message without text writes nothing. */
  messageOut(to: string, text: string): Promise<void> {
    return this.message(text, { kind: 'message_out', from: FactoryJob.SUPER_AGENT, to })
  }
  /** A session the super agent started in `project`; `ref` is its `orca_id` in `starts.jsonl`. */
  sessionStarted(project: string, orcaId: string, summary: string): Promise<void> {
    return this.step({ kind: 'session_start', project, summary, ref: orcaId })
  }
  /** A message the super agent sent to steer a running session in `project`. */
  sessionSteered(project: string, summary: string): Promise<void> {
    return this.step({ kind: 'session_steer', project, summary })
  }
  /** A technical fork the super agent answered in `project`; `ref` is the decision's id. */
  forkAnswered(project: string, decisionId: string, summary: string): Promise<void> {
    return this.step({ kind: 'fork_answer', project, summary, ref: decisionId })
  }
  /** Ends the job with `job_stop`. A second call, and every call after it, writes nothing. */
  stop(): Promise<void> {
    if (this.stopped) return this.chain
    const done = this.homeStep({ kind: 'job_stop', summary: FactoryJob.STOP_SUMMARY })
    this.stopped = true
    return done
  }

  private message(text: string, step: { kind: JobLogKind; from: string; to: string }): Promise<void> {
    const summary = text.trim()
    if (summary === '') return this.chain
    return this.homeStep({ ...step, summary })
  }
  /** A line for the home project, which is known only once `job_start` is written. */
  private homeStep(step: Omit<JobStep, 'project' | 'jobId'>): Promise<void> {
    return this.enqueue(async () => { if (this.home !== undefined) await this.recorded({ ...step, project: this.home, jobId: this.id }) })
  }
  private step(step: Omit<JobStep, 'jobId'>): Promise<void> {
    return this.enqueue(() => this.recorded({ ...step, jobId: this.id }))
  }
  /** Runs `task` after every earlier one, with `job_start` written first. Nothing is run once the job has stopped. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    if (this.stopped) return this.chain
    this.chain = this.chain.then(async () => {
      await this.begin()
      await task()
    }).catch(() => { /* `recorded` and `begin` never reject; this only keeps the chain alive */ })
    return this.chain
  }
  private async begin(): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.folder === undefined) return
    let guidelineVersion: string | undefined
    try { guidelineVersion = await this.guideline?.versionOf(this.mainSession) } catch { /* the line is written without it */ }
    const line = await this.recorder.start(this.folder, message => { this.once(message) }, { jobId: this.id, dshSessionId: this.mainSession, guidelineVersion })
    this.home = line?.project
  }
  private async recorded(step: JobStep): Promise<void> {
    try { await this.recorder.record(step) } catch (error) {
      // A refusal's message is this package's own words. Any other error's text is left out: it could quote what was to be masked.
      this.once(`No ${step.kind} line was written: ${error instanceof RecordsRefusal ? error.message : 'the line could not be appended'}`)
    }
  }
  private once(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    // A log that fails must not stop the work it reports on.
    try { this.warn(message) } catch { /* nothing more can be said */ }
  }
}
