/** The job log writer and the comment writer on a temporary project: every line goes through the records module first, and without a working one nothing is written. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FactoryRecordFile, FactoryRecordsModule, JobRecorder, RecordsRefusal, ReviewWriter, type JobLogLine, type JobStep, type ReviewLine } from '../src/factory/records.ts'
import * as plugin from '../src/factory/index.ts'
import { PLANTED, REDACTED, recordsModule } from './fixtures/factory-records.ts'

const NOW = '2026-11-26T08:09:10.123Z'
let root = '', project = ''
const file = (name: string, of: string = project) => join(of, FactoryRecordFile.FOLDER, name)
const lines = (name: string, of: string = project) => readFileSync(file(name, of), 'utf8').split('\n').filter(line => line !== '')
const action = (fields: Partial<JobLogLine> = {}): JobLogLine => ({ ts: NOW, project, job_id: 'job-1', step_id: 'step-1', kind: 'job_start',
  summary: `Started with ${PLANTED}.`, ...fields })
const review = (fields: Partial<ReviewLine> = {}): ReviewLine => ({ ts: NOW, project, job_id: 'job-1', comment: `Never print ${PLANTED}.`, ...fields })
const records = (source?: string) => new FactoryRecordsModule(recordsModule(root, source))
/** A recorder with a fixed clock and counted ids. */
function recorder(source = records(), projects: string[] = [project]): JobRecorder {
  let ids = 0
  return new JobRecorder(source, projects, () => new Date(NOW), () => `id-${++ids}`)
}
/** The status and message of the refusal a failed step gives. */
async function refusal(step: () => Promise<unknown>): Promise<[number, string]> {
  try { await step() } catch (error) {
    if (error instanceof RecordsRefusal) return [error.status, error.message]
    throw error
  }
  throw new Error('nothing was refused')
}

beforeEach(() => {
  // The real path, because the folder a program is started in is reported as the system names it.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-records-')))
  project = join(root, 'project')
  mkdirSync(join(project, FactoryRecordFile.FOLDER), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

it('masks a job log line, appends the masked line last and returns the text it wrote', async () => {
  writeFileSync(file('actions.jsonl'), '{"earlier":true}\n')
  const text = await recorder().write(action())
  expect(JSON.parse(text)).toEqual(action({ summary: `Started with ${REDACTED}.` }))
  expect(lines('actions.jsonl')).toEqual(['{"earlier":true}', text])
  expect(readFileSync(file('actions.jsonl'), 'utf8')).not.toContain(PLANTED)
  expect(Object.keys(JSON.parse(text) as object)).toEqual(['ts', 'project', 'job_id', 'step_id', 'kind', 'summary'])
  expect(existsSync(file('reviews.jsonl'))).toBe(false)
})

it('masks a comment line and appends it to reviews.jsonl, a changed comment as a new line', async () => {
  const writer = new ReviewWriter(records())
  const first = await writer.write(review())
  const second = await writer.write(review({ ts: '2026-11-26T09:00:00.000Z', comment: 'Changed my mind.' }))
  expect(JSON.parse(first)).toEqual(review({ comment: `Never print ${REDACTED}.` }))
  expect(lines('reviews.jsonl')).toEqual([first, second])
  expect(Object.keys(JSON.parse(first) as object)).toEqual(['ts', 'project', 'job_id', 'comment'])
  expect(existsSync(file('actions.jsonl'))).toBe(false)
})

it('builds the line of every kind from what its caller knows, stamped with the time and a new step_id', async () => {
  const steps: JobStep[] = [
    { kind: 'job_start', project, jobId: 'job-1', summary: 'Started.', dshSessionId: 'dsh-1', guidelineVersion: 'v1', tokens: 0, ms: 5 },
    { kind: 'job_stop', project, jobId: 'job-1', summary: 'Stopped.' },
    { kind: 'permission_answer', project, jobId: 'job-1', summary: 'Allowed bun test.', ref: 'decision-1', tokens: 1200, ms: 3400 },
    { kind: 'fork_answer', project, jobId: 'job-1', summary: 'Chose the smaller fix.', ref: 'decision-2' },
    { kind: 'message_in', project, jobId: 'job-1', summary: `Can I push ${PLANTED}?`, from: 'worker', to: 'super agent' },
    { kind: 'message_out', project, jobId: 'job-1', summary: 'Not yet.', from: 'super agent', to: 'worker' },
    { kind: 'session_start', project, jobId: 'job-1', summary: 'Started a worker.', ref: 'orca-7' },
    { kind: 'session_steer', project, jobId: 'job-1', summary: 'Told the worker to rerun the tests.' },
  ]
  const rec = recorder()
  const written = []
  for (const step of steps) written.push(JSON.parse(await rec.record(step)) as JobLogLine)
  expect(written.map(line => line.kind)).toEqual(steps.map(step => step.kind))
  expect(written.map(line => line.step_id)).toEqual(steps.map((_, i) => `id-${i + 1}`))
  expect(written[0]).toEqual({ ts: NOW, project, job_id: 'job-1', step_id: 'id-1', kind: 'job_start', summary: 'Started.', tokens: 0, ms: 5, dsh_session_id: 'dsh-1', guideline_version: 'v1' })
  expect(written[2]).toMatchObject({ ref: 'decision-1', tokens: 1200, ms: 3400 })
  expect(written[4]).toEqual({ ts: NOW, project, job_id: 'job-1', step_id: 'id-5', kind: 'message_in', summary: `Can I push ${REDACTED}?`, from: 'worker', to: 'super agent' })
  // What the caller does not know is left out, not written empty.
  expect(Object.keys(written[1] as object)).toEqual(['ts', 'project', 'job_id', 'step_id', 'kind', 'summary'])
  expect(lines('actions.jsonl')).toHaveLength(steps.length)
})

it('writes a comment on one step with its step_id before the comment', async () => {
  const text = await new ReviewWriter(records()).write(review({ step_id: 'step-3' }))
  expect(Object.keys(JSON.parse(text) as object)).toEqual(['ts', 'project', 'job_id', 'step_id', 'comment'])
  expect(JSON.parse(text)).toEqual(review({ step_id: 'step-3', comment: `Never print ${REDACTED}.` }))
})

it('begins a job when the plugin starts in a listed project that has its .factory folder', async () => {
  const warn = vi.fn()
  const started = await recorder().start(project, warn)
  expect(started).toEqual({ ts: NOW, project, job_id: 'id-1', step_id: 'id-2', kind: 'job_start', summary: JobRecorder.START_SUMMARY })
  expect(lines('actions.jsonl').map(line => JSON.parse(line) as JobLogLine)).toEqual([started])
  expect(warn).not.toHaveBeenCalled()
  // A second start is a second job: a new job_id, and the first line stays.
  const again = await new JobRecorder(records(), [`${project}/`]).start(project, warn)
  expect(again?.job_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(again?.step_id).not.toBe(again?.job_id)
  expect(lines('actions.jsonl')).toHaveLength(2)
})

it('finds the listed project when the start folder reaches it through a symlink', async () => {
  symlinkSync(project, join(root, 'link'))
  const warn = vi.fn()
  expect((await recorder().start(join(root, 'link'), warn))?.project).toBe(project)
  expect((await recorder(records(), [join(root, 'link')]).start(project, warn))?.project).toBe(join(root, 'link'))
  expect(warn).not.toHaveBeenCalled()
})

it('writes no line, warns once and does not throw when the plugin starts anywhere else', async () => {
  const other = join(root, 'other')
  mkdirSync(other)
  const bare = join(root, 'bare')
  mkdirSync(bare)
  const linked = join(root, 'linked')
  mkdirSync(linked)
  symlinkSync(join(project, FactoryRecordFile.FOLDER), join(linked, FactoryRecordFile.FOLDER))
  const noExport = recordsModule(root, 'export const Other = 1\n')
  const cases: [string, JobRecorder, string, string][] = [
    ['not listed', recorder(), other, 'is not a listed project'],
    ['a folder inside a listed project', recorder(), join(project, FactoryRecordFile.FOLDER), 'is not a listed project'],
    ['no project listed', recorder(records(), []), project, 'is not a listed project'],
    ['no .factory folder', recorder(records(), [bare]), bare, `has no ${FactoryRecordFile.FOLDER} folder yet`],
    ['a symlink at .factory', recorder(records(), [linked]), linked, `has no ${FactoryRecordFile.FOLDER} folder yet`],
    ['no records module', recorder(new FactoryRecordsModule()), project, 'No recordsModule is configured'],
    ['a relative records module', recorder(new FactoryRecordsModule('lib/dist/jobLog.js')), project, 'not an absolute path'],
    ['a missing records module', recorder(new FactoryRecordsModule(join(root, 'missing.mjs'))), project, 'could not be loaded'],
    ['a module without the mask', recorder(new FactoryRecordsModule(noExport)), project, 'does not export JobLogMask.forProject'],
    ['a mask that throws', recorder(records(`export const JobLogMask = { forProject: () => ({ maskAction: () => { throw new Error('${PLANTED}') }, maskReview: line => line }) }\n`)), project, 'could not be masked'],
  ]
  for (const [name, starting, folder, reason] of cases) {
    const warn = vi.fn()
    expect(await starting.start(folder, warn), name).toBeUndefined()
    expect(warn, name).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0], name).toContain('No job_start line was written')
    expect(warn.mock.calls[0]![0], name).toContain(reason)
    expect(warn.mock.calls[0]![0], name).not.toContain(PLANTED)
  }
  expect(existsSync(file('actions.jsonl'))).toBe(false)
  // A log that fails does not make the start fail either.
  await expect(recorder().start(other, () => { throw new Error('no log') })).resolves.toBeUndefined()
})

it('refuses with 503, and writes nothing, when the records module does not work', async () => {
  const sources: [FactoryRecordsModule, string][] = [
    [new FactoryRecordsModule(), 'No recordsModule is configured, so no job log line or comment is written or read'],
    [new FactoryRecordsModule(''), 'No recordsModule is configured, so no job log line or comment is written or read'],
    [new FactoryRecordsModule('relative/jobLog.js'), 'The configured recordsModule is not an absolute path, so no job log line or comment is written or read'],
    [new FactoryRecordsModule(join(root, 'missing.mjs')), 'The configured recordsModule could not be loaded, so no job log line or comment is written or read'],
    [records('this is not JavaScript ('), 'The configured recordsModule could not be loaded, so no job log line or comment is written or read'],
    [records('export const JobLogMask = {}\n'), 'The configured recordsModule does not export JobLogMask.forProject, so no record is written'],
    [records('export const JobLogMask = { forProject: () => { throw new Error("no") } }\n'), 'The configured recordsModule could not build a mask for the project, so no record is written'],
    [records('export const JobLogMask = { forProject: () => ({ maskAction: line => line }) }\n'), 'The configured recordsModule gave no masker for the project, so no record is written'],
    [records('export const JobLogMask = { forProject: () => ({ maskAction: () => null, maskReview: () => "text" }) }\n'), 'could not be masked, so it is not written'],
  ]
  for (const [source, message] of sources) {
    const [actionStatus, actionMessage] = await refusal(() => recorder(source).write(action()))
    expect([actionStatus, actionMessage]).toEqual([503, expect.stringContaining(message)])
    const [reviewStatus, reviewMessage] = await refusal(() => new ReviewWriter(source).write(review()))
    expect([reviewStatus, reviewMessage]).toEqual([503, expect.stringContaining(message)])
  }
  expect([existsSync(file('actions.jsonl')), existsSync(file('reviews.jsonl'))]).toEqual([false, false])
})

it('builds one masker for each project and keeps it', async () => {
  const counting = records(`let built = []
export const JobLogMask = { forProject: project => { built.push(project); return { maskAction: line => ({ ...line, summary: String(built.length) }), maskReview: line => line } } }\n`)
  const other = join(root, 'other')
  mkdirSync(join(other, FactoryRecordFile.FOLDER), { recursive: true })
  const writer = recorder(counting, [project, other])
  await writer.write(action())
  await writer.write(action())
  await writer.write(action({ project: other }))
  expect(lines('actions.jsonl').map(line => (JSON.parse(line) as JobLogLine).summary)).toEqual(['1', '1'])
  expect(lines('actions.jsonl', other).map(line => (JSON.parse(line) as JobLogLine).summary)).toEqual(['2'])
})

it('never creates .factory and never writes through a symlink', async () => {
  const bare = join(root, 'bare')
  mkdirSync(bare)
  expect(await refusal(() => recorder().write(action({ project: bare })))).toEqual([409, 'The project has no .factory folder yet'])
  expect(await refusal(() => new ReviewWriter(records()).write(review({ project: bare })))).toEqual([409, 'The project has no .factory folder yet'])
  expect(existsSync(join(bare, FactoryRecordFile.FOLDER))).toBe(false)
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, join(bare, FactoryRecordFile.FOLDER))
  expect(await refusal(() => recorder().write(action({ project: bare })))).toEqual([409, 'The project has no .factory folder yet'])
  writeFileSync(join(elsewhere, 'target'), 'orig\n')
  symlinkSync(join(elsewhere, 'target'), file('actions.jsonl'))
  symlinkSync(join(elsewhere, 'target'), file('reviews.jsonl'))
  expect(await refusal(() => recorder().write(action()))).toEqual([409, 'Refusing to write through a symlink at actions.jsonl'])
  expect(await refusal(() => new ReviewWriter(records()).write(review()))).toEqual([409, 'Refusing to write through a symlink at reviews.jsonl'])
  expect(readFileSync(join(elsewhere, 'target'), 'utf8')).toBe('orig\n')
  // A named pipe at the file's place is refused at once: the open does not wait for a reader, which would hold all of DSH.
  rmSync(file('actions.jsonl'))
  execFileSync('mkfifo', [file('actions.jsonl')])
  expect(await refusal(() => recorder().write(action()))).toEqual([409, 'Refusing to write to actions.jsonl: it is not a regular file'])
})

it('warns without the error\'s own text when the job_start line cannot be appended for another reason', async () => {
  // A folder at the file's place: the open fails with an error that is no refusal.
  mkdirSync(file('actions.jsonl'))
  const warn = vi.fn()
  await expect(recorder().start(project, warn)).resolves.toBeUndefined()
  expect(warn.mock.calls).toEqual([['No job_start line was written: the line could not be appended']])
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/EISDIR|illegal operation|actions\.jsonl/)
})

it('gives the reader of the records module, built once, and refuses with 503 without one', async () => {
  writeFileSync(file('actions.jsonl'), `${JSON.stringify(action())}\nnot json\n`)
  const source = records()
  const reader = await source.reader()
  expect(reader.read(project)).toEqual({ actions: [action()], reviews: [] })
  expect(await source.reader()).toBe(reader)
  expect(await refusal(() => new FactoryRecordsModule().reader())).toEqual([503, 'No recordsModule is configured, so no job log line or comment is written or read'])
  expect(await refusal(() => records('export const JobLogMask = {}\n').reader())).toEqual([503, 'The configured recordsModule does not export JobLogReader, so no record is read'])
  expect(await refusal(() => records('export class JobLogReader { constructor() { throw new Error("no") } }\n').reader())).toEqual([503, 'The configured recordsModule could not build a reader, so no record is read'])
  expect(await refusal(() => records('export class JobLogReader {}\n').reader())).toEqual([503, 'The configured recordsModule gave no reader, so no record is read'])
})

it('is wired into the plugin: a run writes job_start and job_stop to the folder DSH was started in, or warns once', async () => {
  expect(plugin.Config({ recordsModule: '/factory/lib/dist/jobLog.js' })).toMatchObject({ recordsModule: '/factory/lib/dist/jobLog.js' })
  expect(() => plugin.Config({ recordsModule: 'relative/jobLog.js' })).toThrow()
  expect([plugin.JobRecorder, plugin.ReviewWriter, plugin.FactoryRecordsModule]).toEqual([JobRecorder, ReviewWriter, FactoryRecordsModule])
  const warn = vi.fn()
  const on = vi.fn()
  // The cleanups the plugin leaves, run as DSH runs them when it stops the plugin.
  const cleanups: (() => unknown)[] = []
  const ctx = { webServer: { host: '127.0.0.1', port: 3083, register: () => () => {} }, effect: (effect: () => () => unknown) => { cleanups.push(effect()) },
    // No connection service: the review page's hold on DSH's sign-in is never handed one.
    logger: { info: vi.fn(), warn }, on, inject: () => () => {} }
  const stop = async () => { for (const cleanup of cleanups.splice(0)) await cleanup() }
  const cwd = vi.spyOn(process, 'cwd')
  try {
    cwd.mockReturnValue(project)
    // The stand-in module takes its own folder for the factory's: the guideline's current version there is 2.
    mkdirSync(join(root, 'guideline'))
    writeFileSync(join(root, 'guideline', 'v1.md'), 'Version one.')
    writeFileSync(join(root, 'guideline', 'v2.md'), 'Version two.')
    plugin.apply(ctx as never, plugin.Config({ projects: [project], recordsModule: recordsModule(root) }))
    expect(on).toHaveBeenCalledWith('session/event', expect.any(Function))
    expect(on).toHaveBeenCalledWith('agent/created', expect.any(Function))
    // A session DSH creates through the plugin's own listener starts with the guideline's current version.
    const created = on.mock.calls.find(([name]) => name === 'agent/created')![1] as (payload: { agent: unknown }) => Promise<unknown>
    const session = new Context()
    try {
      await session.plugin(SystemPrompt)
      await created({ agent: { id: 'main-1', ctx: session } })
      expect((await session.systemPrompt.assemble()).sections.find(section => section.name === plugin.GuidelineSection.NAME)?.text).toContain('Version two.')
    } finally { await session.fiber.dispose() }
    // Nothing is written until something happens or the plugin stops.
    expect(existsSync(file('actions.jsonl'))).toBe(false)
    await stop()
    const [start, end] = lines('actions.jsonl').map(line => JSON.parse(line) as JobLogLine)
    expect(start).toMatchObject({ project, kind: 'job_start', job_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, guideline_version: 'v2' })
    expect(end).toMatchObject({ project, kind: 'job_stop', job_id: start!.job_id })
    expect(warn).not.toHaveBeenCalled()
    // Started in a folder that is not listed: no line, one warning, and the plugin still starts and stops.
    cwd.mockReturnValue(root)
    plugin.apply(ctx as never, plugin.Config({ projects: [project], recordsModule: recordsModule(root) }))
    await stop()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual(['dsh-superagent-factory: %s', expect.stringContaining('is not a listed project')])
    // No records module: the same, and sessions start without the decision guideline, which is read with it.
    cwd.mockReturnValue(project)
    plugin.apply(ctx as never, plugin.Config({ projects: [project] }))
    await stop()
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls[1]![1]).toMatch(/^Sessions start without a decision guideline: No recordsModule is configured/)
    expect(warn.mock.calls[2]![1]).toContain('No recordsModule is configured')
    expect(lines('actions.jsonl')).toHaveLength(2)
    // The start folder was deleted, so asking for it throws: one warning, and the plugin still starts and stops.
    cwd.mockImplementation(() => { throw new Error('ENOENT: no such file or directory, uv_cwd') })
    expect(() => { plugin.apply(ctx as never, plugin.Config({ projects: [project], recordsModule: recordsModule(root) })) }).not.toThrow()
    await stop()
    expect(warn).toHaveBeenCalledTimes(4)
    expect(warn.mock.calls[3]).toEqual(['dsh-superagent-factory: %s', 'No job_start line was written: the folder DSH was started in is gone'])
    expect(lines('actions.jsonl')).toHaveLength(2)
  } finally { cwd.mockRestore() }
})
