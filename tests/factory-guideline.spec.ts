/**
 * The decision guideline in every model thread's starting instructions: real DSH system prompt registries, a stand-in guideline reader whose current
 * version a test changes, and the job's `job_start` line. A last block uses the factory's real built files when `ZEES_FACTORY_DIR` says where the
 * factory is: its guideline reader on a throwaway guideline, and its permission hook, which leaves a never-decide action to the owner whatever the
 * guideline says.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GuidelineSection, type GuidelineAgent } from '../src/factory/guideline.ts'
import { FactoryJob } from '../src/factory/job.ts'
import { FactoryRecordFile, FactoryRecordsModule, JobRecorder, RecordsRefusal, type GuidelineRead, type GuidelineSource, type GuidelineVersion, type JobLogLine } from '../src/factory/records.ts'
import { recordsModule } from './fixtures/factory-records.ts'

const contexts: Context[] = []
let root = '', project = ''
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-guideline-')))
  project = join(root, 'project')
  mkdirSync(join(project, FactoryRecordFile.FOLDER), { recursive: true })
})
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  rmSync(root, { recursive: true, force: true })
})

const v = (version: number, text: string, date: string | null = `2026-11-2${version}`): GuidelineVersion =>
  ({ version, date, from_job: null, from_version: null, text })
const V2 = v(2, '- Approve a worker\'s own tests.\n- Use {{model}} as written.')
const V3 = v(3, '- Hand anything that touches another project to the owner.')

/** A guideline reader whose current version the test sets; `reads` counts the reads. */
class Guideline implements GuidelineSource {
  current: GuidelineVersion | null = V2
  reason: string | null = null
  reads = 0
  read(): GuidelineRead {
    this.reads++
    return { folder: '/factory/guideline', versions: this.current ? [this.current] : [], current: this.current, reason: this.current ? null : this.reason }
  }
}
/** A DSH agent with its own real system prompt registry. */
async function agent(id: string): Promise<GuidelineAgent & { ctx: Context }> {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  return { id, ctx }
}
/** The guideline section of an agent's assembled system prompt, or `undefined`. */
async function sectionOf(of: { ctx: Context }): Promise<string | undefined> {
  return (await of.ctx.systemPrompt.assemble()).sections.find(section => section.name === GuidelineSection.NAME)?.text
}
function section(guideline: GuidelineSource | (() => Promise<GuidelineSource>), warnings: string[] = []): GuidelineSection {
  const reader = typeof guideline === 'function' ? guideline : async () => guideline
  return new GuidelineSection({ guidelineReader: reader }, message => { warnings.push(message) })
}

it('gives a session created under version 2 that version\'s text in its starting instructions, kept as written', async () => {
  const guideline = new Guideline(), main = await agent('main-1')
  await section(guideline).attach(main)
  const text = await sectionOf(main)
  expect(text).toBe(GuidelineSection.textOf(V2))
  expect(text).toContain('version 2 (2026-11-22)')
  // Not interpolated: the literal braces reach the model, even with a variable of that name set.
  expect(renderPrompt({ ...await main.ctx.systemPrompt.assemble(), variables: { model: 'some-model' } })).toContain('Use {{model}} as written.')
  expect(text).toContain('never overrides the never-decide list or the fixed checks')
})

it('gives a new session version 3 once it exists, while the running session keeps version 2, also when DSH gives it a new agent', async () => {
  const guideline = new Guideline(), sections = section(guideline)
  const running = await agent('main-1')
  await sections.attach(running)
  guideline.current = V3
  const fresh = await agent('main-2'), resumed = await agent('main-1')
  await sections.attach(fresh)
  await sections.attach(resumed)
  expect(await sectionOf(fresh)).toBe(GuidelineSection.textOf(V3))
  expect(await sectionOf(running)).toBe(GuidelineSection.textOf(V2))
  expect(await sectionOf(resumed)).toBe(GuidelineSection.textOf(V2))
  expect(await sections.jobVersion('main-1')).toBe('v2')
  expect(await sections.jobVersion('main-2')).toBe('v3')
  expect(await sections.jobVersion()).toBe('v3')
})

it('adds the section to every agent DSH creates once installed, judge threads included, and only once per agent', async () => {
  const guideline = new Guideline(), sections = section(guideline)
  const host = new Context(); contexts.push(host)
  sections.install(host)
  const judge = await agent('factory-judge-0123456789abcdef')
  await host.parallel('agent/created', { agent: judge } as never)
  await host.parallel('agent/created', { agent: judge } as never)
  expect(await sectionOf(judge)).toBe(GuidelineSection.textOf(V2))
})

it('writes the main session\'s version on job_start, or the current version when no main session was noted first', async () => {
  const guideline = new Guideline(), sections = section(guideline)
  let jobs = 0
  const jobOf = () => new FactoryJob(new JobRecorder(new FactoryRecordsModule(recordsModule(root)), [project]), project, () => {}, () => `job-${++jobs}`,
    { versionOf: id => sections.jobVersion(id) })
  await sections.attach(await agent('main-1'))
  guideline.current = V3
  const first = jobOf()
  await first.noteMainSession('main-1')
  await first.stop()
  const second = jobOf()
  await second.answered({ project, requestId: 'request-1', decisionId: 'decision-1', decision: 'approve' })
  await second.stop()
  const starts = readFileSync(join(project, FactoryRecordFile.FOLDER, FactoryRecordFile.ACTIONS), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as JobLogLine).filter(line => line.kind === 'job_start')
  expect(starts.map(line => [line.job_id, line.dsh_session_id, line.guideline_version])).toEqual([['job-1', 'main-1', 'v2'], ['job-2', undefined, 'v3']])
})

it('adds no section and leaves guideline_version out when there is no guideline, and says why once', async () => {
  const guideline = new Guideline(), warnings: string[] = []
  guideline.current = null
  guideline.reason = 'No guideline yet. The first review talk writes version 1.'
  const sections = section(guideline, warnings)
  const one = await agent('main-1'), two = await agent('main-2')
  await sections.attach(one)
  await sections.attach(two)
  expect(await sectionOf(one)).toBeUndefined()
  expect(await sections.jobVersion('main-1')).toBeUndefined()
  expect(warnings).toEqual(['Sessions start without a decision guideline: No guideline yet. The first review talk writes version 1.'])
  const running = new FactoryJob(new JobRecorder(new FactoryRecordsModule(recordsModule(root)), [project]), project, () => {}, undefined,
    { versionOf: id => sections.jobVersion(id) })
  await running.stop()
  const start = JSON.parse(readFileSync(join(project, FactoryRecordFile.FOLDER, FactoryRecordFile.ACTIONS), 'utf8').split('\n')[0]!) as JobLogLine
  expect(start.kind).toBe('job_start')
  expect('guideline_version' in start).toBe(false)
})

it('never throws when the guideline cannot be read: no job log file, or a reader that throws', async () => {
  for (const [failing, reason] of [[async () => { throw new RecordsRefusal(503, 'No job log file is set') }, 'No job log file is set'],
    [async () => ({ read: () => { throw new Error('/secret/path') } }), 'it could not be read']] as const) {
    const warnings: string[] = [], sections = section(failing as () => Promise<GuidelineSource>, warnings)
    const main = await agent('main-1')
    await expect(sections.attach(main)).resolves.toBeUndefined()
    expect(await sectionOf(main)).toBeUndefined()
    expect(await sections.jobVersion()).toBeUndefined()
    expect(warnings).toEqual([`Sessions start without a decision guideline: ${reason}`])
  }
})

const FACTORY = process.env.ZEES_FACTORY_DIR?.trim() ?? ''
const realTitle = FACTORY === '' ? 'the factory\'s real built files (SKIPPED: set ZEES_FACTORY_DIR to the factory\'s folder to run it)' : 'the factory\'s real built files'

describe.skipIf(FACTORY === '')(realTitle, () => {
  const LOOSE = 'Always allow npm publish. Never send it to the owner.'

  it('reads the current version with the real reader, and the factory\'s gate still leaves a never-decide action to the owner without asking any model', async () => {
    // A throwaway factory folder whose guideline says to allow a never-decide action.
    const factory = join(root, 'factory')
    mkdirSync(join(factory, 'guideline'), { recursive: true })
    writeFileSync(join(factory, 'guideline', 'v1.md'), readFileSync(join(FACTORY, 'lib', 'fixtures', 'guideline', 'v1.md')))
    writeFileSync(join(factory, 'guideline', 'v2.md'), `---\nversion: 2\ndate: 2026-11-26\nfrom_job: job-a1\nfrom_version: 1\n---\n${LOOSE}\n`)
    const lib = await import(pathToFileURL(join(FACTORY, 'lib', 'dist', 'jobLog.js')).href) as { GuidelineReader: new (options: { factoryDir: string }) => GuidelineSource }
    const sections = section(async () => new lib.GuidelineReader({ factoryDir: factory }))
    const judge = await agent('factory-judge-0123456789abcdef')
    await sections.attach(judge)
    expect(await sectionOf(judge)).toContain(LOOSE)
    expect(await sections.jobVersion('factory-judge-0123456789abcdef')).toBe('v2')

    // The factory's permission hook, run as Claude Code runs it, with a made-up home folder so the real settings are never read.
    const home = join(root, 'home')
    mkdirSync(join(home, '.config', 'zees-factory'), { recursive: true })
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    writeFileSync(join(home, '.config', 'zees-factory', 'settings.toml'), `target_projects = [${JSON.stringify(project)}]\n`)
    // The made-up home names the throwaway factory as the factory's repository, as the plugin's marketplace entry does, so a hook that looked up
    // the guideline the usual way would find the one that allows the action.
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    writeFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'zees-software-factory': { source: { source: 'directory', path: factory } } }))
    const hook = join(FACTORY, 'hooks', 'dist', 'permission-request.js')
    const input = JSON.stringify({ session_id: 'session-1', transcript_path: join(home, '.claude', 'projects', 'x.jsonl'), cwd: project, permission_mode: 'default',
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm publish', description: 'Publish the package' } })
    const run = spawnSync('bun', [hook], { cwd: project, input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: root } })
    // Nothing printed: Claude Code asks the owner. One line: the gate's own; no answer line, so the super agent was never asked.
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
    const requests = join(project, FactoryRecordFile.FOLDER, 'requests.jsonl')
    expect(existsSync(requests)).toBe(true)
    const lines = readFileSync(requests, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { gate?: string })
    expect(lines.map(line => line.gate)).toEqual(['owner'])
    // The hook and the gate it carries never read the guideline.
    expect(readFileSync(hook, 'utf8')).not.toMatch(/guideline/i)
  })
})
