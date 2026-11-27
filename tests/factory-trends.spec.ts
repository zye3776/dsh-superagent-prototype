/** Trend reports: the report file, the one question built from the records, and the one-off read-only thread that answers it, on a stand-in DSH. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JudgeSessions } from '../src/factory/judge.ts'
import { RecordsRefusal, type GuidelineVersion, type RecordedJob } from '../src/factory/records.ts'
import { TrendPrompt, TrendReportFile, TrendWriter, type TrendInput } from '../src/factory/trends.ts'
import { fakeDsh, fakeGuard } from './fixtures/judge.ts'

let root = '', project = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'factory-trends-')); project = join(root, 'testbed') })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const version = (n: number, text = `Text of v${n}.`): GuidelineVersion => ({ version: n, date: `2026-11-2${n}`, from_job: null, from_version: n === 1 ? null : n - 1, text })
const job = (fields: Partial<RecordedJob> = {}): RecordedJob => ({
  project, job_id: 'job-a', number: 4, started: '2026-11-21T08:00:00.000Z', stopped: '2026-11-21T09:00:00.000Z', last: '2026-11-21T09:00:00.000Z', guideline_version: 'v2',
  steps: [{ automatic: false, ts: '2026-11-21T08:05:00.000Z', line: { ts: '2026-11-21T08:05:00.000Z', project, job_id: 'job-a', step_id: 's2', kind: 'permission_answer', summary: 'Approved: widen the story.', from: 'worker', to: 'super agent' } },
    { automatic: true, ts: '2026-11-21T08:06:00.000Z', answer: { ts: '2026-11-21T08:06:00.000Z', request_id: 'r1', session_id: 'w1', tool_name: 'Bash', tool_input: {}, reason: 'plain git', answer: 'allow' } }],
  reviews: [{ ts: '2026-11-22T08:00:00.000Z', project, job_id: 'job-a', step_id: 's2', comment: 'Keep to the minimum feature.' }, { ts: '2026-11-22T08:01:00.000Z', project, job_id: 'job-a', comment: 'Good pace.' }],
  ...fields,
})
const input = (fields: Partial<TrendInput> = {}): TrendInput => ({ version: version(2), before: version(1), jobs: [job()], ...fields })

describe('TrendReportFile', () => {
  it('writes the front matter and reads the file back as written', () => {
    const text = TrendReportFile.textOf({ version: 2, date: '2026-11-27', jobs: 5, compared_with: 1, written: 'accepted' }, '# Trend report for guideline v2\n\nCompared with v1.')
    expect(text).toBe('---\nversion: 2\ndate: 2026-11-27\njobs: 5\ncompared_with: 1\nwritten: accepted\n---\n# Trend report for guideline v2\n\nCompared with v1.\n')
    expect(TrendReportFile.parse('v2-trends.md', text)).toEqual({ version: 2, date: '2026-11-27', jobs: 5, compared_with: 1, written: 'accepted', text: '# Trend report for guideline v2\n\nCompared with v1.\n' })
    expect([TrendReportFile.pathOf(3), TrendReportFile.parse('v2.md', text), TrendReportFile.parse('v2-trends.txt', text)]).toEqual(['guideline/v3-trends.md', null, null])
  })

  it('reads a file without front matter, or with odd fields, with what it can say', () => {
    expect(TrendReportFile.parse('v4-trends.md', 'Just text.\n')).toEqual({ version: 4, date: null, jobs: null, compared_with: null, written: null, text: 'Just text.\n' })
    expect(TrendReportFile.parse('v4-trends.md', '---\njobs: many\nwritten: later\n---\nBody\n')).toMatchObject({ jobs: null, written: null, text: 'Body\n' })
  })
})

describe('TrendPrompt', () => {
  it('asks for the report of the version, naming the version before it, with each job\'s steps and the owner\'s comments', () => {
    const text = TrendPrompt.textOf(input())
    for (const part of ['trend report for the owner\'s decision guideline v2', 'compared with v1, the version before it', '## Guideline v2\nText of v2.',
      '## Guideline v1, the version before it\nText of v1.', '## Jobs under v2 (1)', '### testbed job 4, 2026-11-21T08:00:00.000Z to 2026-11-21T09:00:00.000Z',
      '- 2026-11-21T08:05:00.000Z permission_answer (worker → super agent) [s2]: Approved: widen the story.', '- 2026-11-21T08:06:00.000Z automatic allow: Bash plain git',
      '- on step s2: Keep to the minimum feature.', '- on the whole job: Good pace.', 'Use no tool, start nothing and change nothing']) expect(text).toContain(part)
  })

  it('says when there is no version before it, or no job, or no comment', () => {
    const text = TrendPrompt.textOf(input({ version: version(1), before: null, jobs: [job({ reviews: [] })] }))
    expect(text).toContain('This is the first version: there is none before it to compare with.')
    expect(text).not.toContain('the version before it\n')
    expect(text).toContain('The owner left no comment on this job.')
    expect(TrendPrompt.textOf(input({ jobs: [] }))).toContain('## Jobs under v2 (0)\nNo job ran under this version.')
  })

  it('cuts a long step at 300 characters and the whole message at its limit, saying so', () => {
    const long = job({ steps: [{ automatic: false, ts: 't', line: { ts: 't', project, job_id: 'job-a', step_id: 's', kind: 'message_in', summary: 'x'.repeat(1000) } }], reviews: [] })
    expect(TrendPrompt.textOf(input({ jobs: [long] }))).toContain(`[s]: ${'x'.repeat(300)}…\n`)
    const many = Array.from({ length: 600 }, (_, n) => job({ job_id: `job-${n}`, number: n, steps: [{ automatic: false, ts: 't', line: { ts: 't', project, job_id: `job-${n}`, step_id: 's', kind: 'message_in', summary: 'y'.repeat(299) } }] }))
    const cut = TrendPrompt.textOf(input({ jobs: many }))
    expect(cut.length).toBeLessThanOrEqual(TrendPrompt.MAX_CHARS + TrendPrompt.CUT.length + 1)
    expect(cut.endsWith(TrendPrompt.CUT)).toBe(true)
  })

  it('takes the jobs whose job_start named the version, oldest first, from every project', () => {
    const jobs = [{ jobs: [job({ job_id: 'late', started: '2026-11-23T00:00:00.000Z' }), job({ job_id: 'other', guideline_version: 'v1' }), job({ job_id: 'none', guideline_version: undefined })] },
      { jobs: [job({ job_id: 'early', started: '2026-11-20T00:00:00.000Z' })] }]
    expect(TrendPrompt.jobsUnder(jobs, 2).map(each => each.job_id)).toEqual(['early', 'late'])
  })
})

describe('TrendWriter', () => {
  it('asks a fresh read-only judge Session once per report and puts the fork\'s own title, the version before it and the closing lines around the answer', async () => {
    const dsh = fakeDsh(() => ({ text: '  Fewer wide approvals.  ', usage: { input_tokens: 1000, output_tokens: 234 } }))
    const writer = new TrendWriter({ opener: new JudgeSessions(dsh.ctx, fakeGuard().source), projects: [join(root, 'first')] })
    const written = await writer.write(input())
    expect(written.jobs).toBe(1)
    expect(written.body).toMatch(/^# Trend report for guideline v2\n\nCompared with v1\.\n\nFewer wide approvals\.\n\nSpent: [\d,]+ tokens\nProviders: dsh \(the model set in its factory profile\)\n$/)
    await writer.write(input())
    // Two reports, two Sessions: never one kept from an earlier report. Each is made in the first job's project with the judge preset, read-only.
    expect(dsh.controller.create.mock.calls.map(([request]) => [request.workspaceId, request.agentPreset])).toEqual([[`workspace:${project}`, JudgeSessions.PRESET], [`workspace:${project}`, JudgeSessions.PRESET]])
    expect(new Set(dsh.controller.create.mock.calls.map(([request]) => request.sessionId)).size).toBe(2)
    expect(dsh.permissionPresets.set.mock.calls.map(([, preset]) => preset)).toEqual([JudgeSessions.PERMISSIONS, JudgeSessions.PERMISSIONS])
    expect([...dsh.agents.values()].map(agent => [agent.allowed, agent.asked.length])).toEqual([[[[...JudgeSessions.TOOLS]], 1], [[[...JudgeSessions.TOOLS]], 1]])
    expect([...dsh.agents.values()][0]!.asked[0]).toBe(TrendPrompt.textOf(input()))
  })

  it('names the provider and model the thread\'s Session asked in the Providers line, when its request header says them', async () => {
    const dsh = fakeDsh(() => {
      for (const agent of dsh.agents.values()) Object.assign(agent.session, { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4' } }) })
      return 'Fewer wide approvals.'
    })
    const writer = new TrendWriter({ opener: new JudgeSessions(dsh.ctx, fakeGuard().source), projects: [] })
    expect((await writer.write(input())).body).toContain('\nProviders: deepseek (deepseek-v4)\n')
  })

  it('names the first version as having none before it, and runs in the first listed project when no job ran', async () => {
    const dsh = fakeDsh(() => 'Nothing to compare.')
    const writer = new TrendWriter({ opener: new JudgeSessions(dsh.ctx, fakeGuard().source), projects: [join(root, 'first')] })
    expect((await writer.write(input({ version: version(1), before: null, jobs: [] }))).body).toContain('# Trend report for guideline v1\n\nThis is the first version; there is none before it.\n')
    expect(dsh.workspaceRegistry.create.mock.calls).toEqual([[join(root, 'first')]])
  })

  it('refuses in plain words, writing nothing: an empty answer, no answer in time, no thread, or no project to run it in', async () => {
    const refusal = async (attempt: Promise<unknown>) => {
      const error = await attempt.then(() => undefined, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(RecordsRefusal)
      return (error as RecordsRefusal).message
    }
    const opener = (reply: Parameters<typeof fakeDsh>[0]) => new JudgeSessions(fakeDsh(reply).ctx, fakeGuard().source)
    expect(await refusal(new TrendWriter({ opener: opener(() => '  '), projects: [] }).write(input()))).toBe('the report thread gave no answer')
    expect(await refusal(new TrendWriter({ opener: opener(() => new Promise<string>(() => {})), projects: [], timeoutMs: 20 }).write(input()))).toBe('the report thread did not answer in time')
    const noGuard = new JudgeSessions(fakeDsh().ctx, { guard: async () => { throw new Error('no guard') } })
    expect(await refusal(new TrendWriter({ opener: noGuard, projects: [] }).write(input()))).toBe('the report thread could not be opened')
    expect(await refusal(new TrendWriter({ opener: opener(() => 'x'), projects: [] }).write(input({ jobs: [] })))).toBe('no target project is listed to run the report thread in')
  })
})
