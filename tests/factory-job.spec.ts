/** One run of the plugin as a job on a temporary project: the lines it writes, their order, when `job_start` is written, and a run that is killed. */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AssessRoute, DecisionsFile, StubJudge } from '../src/factory/assess.ts'
import { DecisionWriter, FactoryMaskModule } from '../src/factory/decisions.ts'
import { FactoryJob } from '../src/factory/job.ts'
import { MainSessionWatch } from '../src/factory/mainsession.ts'
import { FactoryRecordFile, FactoryRecordsModule, JobRecorder, type JobLogLine } from '../src/factory/records.ts'
import { recordsModule } from './fixtures/factory-records.ts'

let root = '', project = '', other = ''
/** The job log lines of one project, parsed, in file order. */
function read(of: string = project): JobLogLine[] {
  const path = join(of, FactoryRecordFile.FOLDER, FactoryRecordFile.ACTIONS)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as JobLogLine)
}
/** A job whose clock steps one second per line and whose ids are counted: the job's own id is `job-1`. */
function job(options: { folder?: string | undefined; projects?: string[]; source?: string; warnings?: string[] } = {}): FactoryJob {
  let ticks = 0, steps = 0, jobs = 0
  const recorder = new JobRecorder(new FactoryRecordsModule(recordsModule(root, options.source)), options.projects ?? [project, other],
    () => new Date(Date.UTC(2026, 10, 26, 8, 0, ticks++)), () => `step-${++steps}`)
  return new FactoryJob(recorder, 'folder' in options ? options.folder : project, message => { options.warnings?.push(message) }, () => `job-${++jobs}`)
}
const answer = (fields: { project?: string; requestId?: string; decisionId?: string } = {}) =>
  ({ project: fields.project ?? project, requestId: fields.requestId ?? 'request-1', decisionId: fields.decisionId ?? 'decision-1', decision: 'approve', tokens: 40, seconds: 1.25 })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-job-')))
  project = join(root, 'project')
  other = join(root, 'other')
  for (const folder of [project, other]) mkdirSync(join(folder, FactoryRecordFile.FOLDER), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

it('begins with job_start carrying the main session id, then writes every line in call order with one job id and rising times', async () => {
  const running = job()
  expect(running.id).toBe('job-1')
  // Not awaited one by one: the job keeps the order it was called in.
  await Promise.all([running.noteMainSession('session-1'), running.messageIn('owner', 'Build story 3.'), running.answered(answer()),
    running.messageOut('owner', 'Story 3 is built.'), running.stop()])
  const lines = read()
  expect(lines.map(line => line.kind)).toEqual(['job_start', 'message_in', 'permission_answer', 'message_out', 'job_stop'])
  expect(new Set(lines.map(line => line.job_id))).toEqual(new Set(['job-1']))
  expect(new Set(lines.map(line => line.step_id)).size).toBe(5)
  expect(lines.map(line => line.ts)).toEqual([...lines.map(line => line.ts)].sort())
  expect(new Set(lines.map(line => line.ts)).size).toBe(5)
  expect(lines.every(line => line.project === project)).toBe(true)
  expect(lines[0]).toMatchObject({ kind: 'job_start', dsh_session_id: 'session-1' })
  expect(lines[0]).not.toHaveProperty('guideline_version')
  expect(lines[1]).toMatchObject({ summary: 'Build story 3.', from: 'owner', to: 'super agent' })
  expect(lines[2]).toMatchObject({ summary: 'Permission request request-1: approve', ref: 'decision-1', tokens: 40, ms: 1250 })
  expect(lines[3]).toMatchObject({ summary: 'Story 3 is built.', from: 'super agent', to: 'owner' })
  expect(lines[4]!.summary.trim()).not.toBe('')
})

it('starts the job without a session id when another step comes first, and writes job_start only once', async () => {
  const running = job()
  await running.answered(answer())
  await running.noteMainSession('session-1')
  await running.messageIn('owner', 'Hello.')
  const lines = read()
  expect(lines.map(line => line.kind)).toEqual(['job_start', 'permission_answer', 'message_in'])
  expect(lines[0]).not.toHaveProperty('dsh_session_id')
})

it('writes job_start and job_stop for a run with nothing in it, and nothing after it stopped', async () => {
  const running = job()
  expect(read()).toEqual([])
  await running.stop()
  await running.stop()
  await running.messageIn('owner', 'Too late.')
  await running.answered(answer())
  expect(read().map(line => line.kind)).toEqual(['job_start', 'job_stop'])
})

it('writes a permission answer to its own project and the job\'s own lines to the folder DSH was started in', async () => {
  const running = job()
  await running.answered(answer({ project: other }))
  await running.stop()
  expect(read().map(line => line.kind)).toEqual(['job_start', 'job_stop'])
  expect(read(other)).toEqual([expect.objectContaining({ kind: 'permission_answer', project: other, job_id: 'job-1', ref: 'decision-1' })])
})

it('writes no line of its own when DSH was started outside the listed projects, says so once, and still records answers', async () => {
  const warnings: string[] = []
  const running = job({ folder: root, warnings })
  await running.messageIn('owner', 'Hello.')
  await running.answered(answer())
  await running.messageOut('owner', 'Hi.')
  await running.stop()
  expect(read()).toEqual([expect.objectContaining({ kind: 'permission_answer', job_id: 'job-1' })])
  expect(read(root)).toEqual([])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('not a listed project')
})

it('writes no line of its own when the start folder is unknown, and says nothing more', async () => {
  const warnings: string[] = []
  const running = job({ folder: undefined, warnings })
  await running.noteMainSession('session-1')
  await running.answered(answer())
  await running.stop()
  expect(read()).toEqual([expect.objectContaining({ kind: 'permission_answer' })])
  expect(warnings).toEqual([])
})

it('never rejects when a line is refused, and warns once for each reason', async () => {
  const warnings: string[] = []
  const running = job({ source: 'export const nothing = 1\n', warnings })
  await expect(running.answered(answer())).resolves.toBeUndefined()
  await expect(running.answered(answer({ requestId: 'request-2' }))).resolves.toBeUndefined()
  await expect(running.stop()).resolves.toBeUndefined()
  expect(read()).toEqual([])
  expect(warnings.filter(warning => warning.includes('permission_answer'))).toHaveLength(1)
  expect(new Set(warnings).size).toBe(warnings.length)
})

it('writes no message line for a message without text', async () => {
  const running = job()
  await running.noteMainSession('session-1')
  await running.messageIn('owner', '   ')
  await running.messageOut('owner', '')
  expect(read().map(line => line.kind)).toEqual(['job_start'])
})

it('accepts the kinds later stories will call: a session started, a session steered and a technical fork answered', async () => {
  const running = job()
  await running.sessionStarted(other, 'orca-1', 'Started a worker for story 3.4.')
  await running.sessionSteered(other, 'Asked the worker to commit its work.')
  await running.forkAnswered(other, 'decision-2', 'Chose to keep one recorder.')
  const lines = read(other)
  expect(lines.map(line => line.kind)).toEqual(['session_start', 'session_steer', 'fork_answer'])
  expect(lines[0]).toMatchObject({ ref: 'orca-1', summary: 'Started a worker for story 3.4.', job_id: 'job-1' })
  expect(lines[1]).not.toHaveProperty('ref')
  expect(lines[2]).toMatchObject({ ref: 'decision-2', summary: 'Chose to keep one recorder.' })
})

it('leaves no job_stop when the process is killed, and the reader still returns the job, ending at its last line', async () => {
  const records = recordsModule(root)
  const child = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, 'fixtures', 'factory-job-child.mjs'), records, project],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += String(chunk) })
  await new Promise<void>((done, fail) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) done() })
    child.on('exit', code => { fail(new Error(`the child ended before it was ready (${code}): ${errors}`)) })
  })
  const ended = new Promise(done => { child.on('exit', done) })
  child.kill('SIGKILL')
  await ended
  const { actions } = (await new FactoryRecordsModule(records).reader()).read(project)
  expect(actions.map(line => line.kind)).toEqual(['job_start', 'permission_answer'])
  expect(new Set(actions.map(line => line.job_id)).size).toBe(1)
  expect(actions.at(-1)).toMatchObject({ kind: 'permission_answer', ref: 'decision-1' })
}, 20_000)

/** The `/assess` route of a run, deciding with the stub judge and writing decisions through a mask that changes nothing. */
function assessRoute(running: FactoryJob): AssessRoute {
  const mask = join(root, 'plain-mask.mjs')
  writeFileSync(mask, 'export const DecisionMask = { forProject: () => ({ mask: line => line }) }\n')
  return new AssessRoute([project], undefined, new StubJudge(), undefined, new DecisionWriter(new FactoryMaskModule(mask)), undefined, running)
}
const request = (id: string) => ({ request_id: id, session_id: 'worker-1', project, tool_name: 'Bash', tool_input: { command: 'ls' } })

it('records a sample run through the plugin\'s own parts: two answered requests, a message each way, and the stop', async () => {
  const running = job()
  const ctx = new Context()
  new MainSessionWatch(running).install(ctx)
  const route = assessRoute(running)
  // Only `id` and `header` of a Session are read.
  const main = { id: 'main-1', header: {} } as unknown as Session
  const emit = (event: unknown) => { ctx.emit('session/event', main, event as SessionEvent) }
  emit({ type: 'user/message', data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Build story 3.' }], source: { kind: 'user' } } })
  await route.assess(request('request-1'))
  await route.assess(request('request-2'))
  emit({ type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'Both requests are answered.' }] } } })
  emit({ type: 'turn/end', data: { turn: 1, reason: 'done' } })
  await running.stop()
  const lines = read()
  expect(lines.map(line => line.kind)).toEqual(['job_start', 'message_in', 'permission_answer', 'permission_answer', 'message_out', 'job_stop'])
  expect(new Set(lines.map(line => line.job_id))).toEqual(new Set([running.id]))
  expect(lines.map(line => line.ts)).toEqual([...new Set(lines.map(line => line.ts))].sort())
  expect(lines[0]).toMatchObject({ dsh_session_id: 'main-1' })
  const decisions = readFileSync(join(project, DecisionsFile.FOLDER, DecisionsFile.FILE), 'utf8').split('\n').filter(line => line !== '')
    .map(line => JSON.parse(line) as { decision_id: string })
  expect(decisions).toHaveLength(2)
  expect(lines.filter(line => line.kind === 'permission_answer').map(line => line.ref)).toEqual(decisions.map(decision => decision.decision_id))
  expect(lines[4]).toMatchObject({ summary: 'Both requests are answered.', from: 'super agent', to: 'owner' })
})

it('answers a request as before when its job log line is refused', async () => {
  const warnings: string[] = []
  const running = job({ source: 'export const nothing = 1\n', warnings })
  const written = JSON.parse(await assessRoute(running).assess(request('request-1'))) as { request_id: string; decision: string }
  expect(written).toMatchObject({ request_id: 'request-1', decision: 'ask_owner' })
  expect(existsSync(join(project, DecisionsFile.FOLDER, DecisionsFile.FILE))).toBe(true)
  expect(read()).toEqual([])
  expect(warnings.some(warning => warning.includes('No permission_answer line was written'))).toBe(true)
})
