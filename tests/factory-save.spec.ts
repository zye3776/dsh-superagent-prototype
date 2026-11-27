/**
 * The guideline's save path and its reading from the remote's main, on a throwaway factory repository: a bare repository in a temporary folder
 * stands for the factory's remote, and a clone of it for the factory repository. git runs for real on them, with an empty global config so nothing of
 * the owner's git setup is read; glab is a stand-in whose merge moves the bare repository's main, so no test reaches GitLab or any real remote.
 * A last block reads a saved version back with the factory's real `GuidelineReader` when `ZEES_FACTORY_DIR` says where the factory is.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GuidelineSection, type GuidelineAgent } from '../src/factory/guideline.ts'
import { FactoryRecordsModule, RecordsRefusal, type GuidelineSource } from '../src/factory/records.ts'
import { ReviewPage } from '../src/factory/review.ts'
import { FactoryRemote, FactoryRepoSave, GlabProgram, GuidelineFile, GuidelineSaver, RemoteGuidelineRecords, TrendReports } from '../src/factory/save.ts'
import { ExecFileRunner, type GuidelineProposal, type OrcaRun, type OrcaRunner, type RunOptions } from '../src/factory/talk.ts'
import { TrendPrompt, TrendReportFile, TrendWriter, type TrendAuthor, type TrendInput, type WrittenTrend } from '../src/factory/trends.ts'
import { FAKE_RECORDS, PLANTED, REDACTED, recordsModule } from './fixtures/factory-records.ts'

const GLAB = '/stand-in/glab'
const NOW = new Date('2026-11-27T10:15:30.000Z')
let root = '', bare = '', factory = '', saves = '', emptyConfig = ''
const contexts: Context[] = []

/** git on the test's own repositories, with no global or system config. */
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'GIT_DIR' && name !== 'GIT_WORK_TREE'))
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } }).trim()
}
const mainOf = () => git(bare, 'rev-parse', 'refs/heads/main')
const fileOnMain = (path: string) => git(bare, 'show', `main:${path}`)
const filesOnMain = () => git(bare, 'ls-tree', '--name-only', 'main', 'guideline/').split('\n').filter(Boolean)
const branchesOf = () => git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean).sort()

/**
 * The runner the tests give the save path: git runs for real, but only with the empty global config; glab is a stand-in that writes each call down.
 * Its `mr create` prints a merge request's address; its `mr merge` moves the bare repository's main to the merge request's branch, as GitLab would.
 */
class TestRunner implements OrcaRunner {
  readonly calls: { program: string; args: string[]; cwd: string | undefined }[] = []
  fail: { create?: string; merge?: string } = {}
  /** What `mr create` prints. */
  created = 'Creating merge request for zees-factory into main in factory\n\n!7 guideline\n https://gitlab.example/factory/-/merge_requests/7\n'
  private readonly real = new ExecFileRunner()
  private branch = ''
  async run(program: string, args: readonly string[], timeoutMs: number, options: RunOptions = {}): Promise<OrcaRun> {
    this.calls.push({ program, args: [...args], cwd: options.cwd })
    if (program === 'git') return this.real.run(program, args, timeoutMs, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } })
    if (program !== GLAB) return { ok: false, error: `the test runs no ${program}` }
    if (args[0] === 'mr' && args[1] === 'create') {
      if (this.fail.create !== undefined) return { ok: false, error: this.fail.create }
      this.branch = args[args.indexOf('--source-branch') + 1]!
      return { ok: true, stdout: this.created }
    }
    if (args[0] === 'mr' && args[1] === 'merge') {
      if (this.fail.merge !== undefined) return { ok: false, error: this.fail.merge }
      const sha = args[args.indexOf('--sha') + 1]!
      if (git(bare, 'rev-parse', `refs/heads/${this.branch}`) !== sha) return { ok: false, error: 'the branch is not at that commit' }
      git(bare, 'update-ref', 'refs/heads/main', sha)
      return { ok: true, stdout: 'Merged!' }
    }
    return { ok: false, error: 'unknown glab call' }
  }
  get glabCalls(): string[][] { return this.calls.filter(call => call.program === GLAB).map(call => call.args) }
}

let runner = new TestRunner()
/** The factory's records stand-in, written into the factory clone, so its guideline reader names the clone's `guideline/` folder. */
const records = () => new RemoteGuidelineRecords(recordsModule(factory), { runner })
const saverOf = (of: RemoteGuidelineRecords = records(), glab: string | null = GLAB) =>
  new GuidelineSaver({ records: of, repo: new FactoryRepoSave({ glab: glab ?? undefined, root: saves }), now: () => NOW })
const proposal = (text: string, fields: Partial<GuidelineProposal> = {}): GuidelineProposal =>
  ({ project: '/projects/factory-testbed', job_id: 'job-a1', number: 3, text, ts: NOW.toISOString(), ...fields })
const V1 = '---\nversion: 1\ndate: 2026-11-20\nfrom_job: job-0\n---\n# Guideline\nKeep it small.\n'

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-save-')))
  emptyConfig = join(root, 'gitconfig')
  writeFileSync(emptyConfig, '')
  bare = join(root, 'remote.git')
  factory = join(root, 'factory')
  saves = join(root, 'saves')
  mkdirSync(saves)
  git(root, 'init', '--bare', '--initial-branch=main', bare)
  git(root, 'clone', '--quiet', bare, factory)
  git(factory, 'config', 'user.name', 'Test Owner')
  git(factory, 'config', 'user.email', 'owner@example.invalid')
  git(factory, 'config', 'commit.gpgsign', 'false')
  mkdirSync(join(factory, 'guideline'))
  writeFileSync(join(factory, 'guideline', 'v1.md'), V1)
  writeFileSync(join(factory, 'README.md'), 'factory\n')
  git(factory, 'add', 'guideline/v1.md', 'README.md')
  git(factory, 'commit', '--quiet', '-m', 'v1')
  git(factory, 'push', '--quiet', 'origin', 'main')
  runner = new TestRunner()
})
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  rmSync(root, { recursive: true, force: true })
})

describe('Accept saves the next version through a merge request', () => {
  it('creates v2 on the remote\'s main from one pushed commit, merged at once, with v1 unchanged and no worktree left', async () => {
    const before = mainOf()
    const v1 = fileOnMain('guideline/v1.md')
    const saved = await saverOf().accept(proposal('# Guideline\nKeep to the minimum feature.\n'), 1)
    expect(saved).toEqual({ saved: true, version: 2, mr: 'https://gitlab.example/factory/-/merge_requests/7' })
    expect(git(bare, 'rev-list', '--count', `${before}..main`)).toBe('1')
    expect(filesOnMain()).toEqual(['guideline/v1.md', 'guideline/v2.md'])
    expect(fileOnMain('guideline/v1.md')).toBe(v1)
    expect(fileOnMain('guideline/v2.md')).toBe('---\nversion: 2\ndate: 2026-11-27\nfrom_job: job-a1\nfrom_version: 1\n---\n# Guideline\nKeep to the minimum feature.')
    // Only the version file changed, by the owner's own identity.
    expect(git(bare, 'show', '--name-only', '--format=%an', 'main').split('\n').filter(Boolean)).toEqual(['Test Owner', 'guideline/v2.md'])
    // The merge request: from a new branch into main, deleting no branch; merged at once and only at the pushed commit.
    const branch = 'zees-factory/guideline-v2-20261127T101530Z'
    expect(runner.glabCalls).toEqual([
      ['mr', 'create', '--source-branch', branch, '--target-branch', 'main', '--title', 'guideline v2, from the review of factory-testbed job 3',
        '--description', 'Guideline v2, replacing v1, from the review talk on factory-testbed job 3. Accepted by the owner on the review page and merged by the fork.',
        '--remove-source-branch=false', '--yes'],
      ['mr', 'merge', '7', '--yes', '--auto-merge=false', '--sha', mainOf()],
    ])
    expect(branchesOf()).toEqual(['main', branch])
    // The factory clone, its checkout and its branches are untouched; the save's worktree and its folder are gone.
    expect([git(factory, 'branch', '--show-current'), git(factory, 'status', '--porcelain'), git(factory, 'branch', '--format=%(refname:short)')])
      .toEqual(['main', expect.stringMatching(/^\?\? records-\d+\.mjs$/), 'main'])
    expect(readdirSync(join(factory, 'guideline'))).toEqual(['v1.md'])
    expect(git(factory, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toEqual([`worktree ${factory}`])
    expect(readdirSync(saves)).toEqual([])
    // git never ran in a session's folder: only in the factory repository and the save's own worktree.
    expect(new Set(runner.calls.filter(call => call.program === 'git').map(call => call.cwd === factory ? 'factory' : call.cwd!.startsWith(saves) ? 'save' : call.cwd))).toEqual(new Set(['factory', 'save']))
  })

  it('writes version 1 with no from_version when the remote\'s main has no guideline yet', async () => {
    git(factory, 'rm', '--quiet', 'guideline/v1.md')
    git(factory, 'commit', '--quiet', '-m', 'no guideline')
    git(factory, 'push', '--quiet', 'origin', 'main')
    const saved = await saverOf().accept(proposal('First.\n'), null)
    expect(saved).toMatchObject({ saved: true, version: 1 })
    expect(fileOnMain('guideline/v1.md')).toBe('---\nversion: 1\ndate: 2026-11-27\nfrom_job: job-a1\n---\nFirst.')
  })

  it('numbers the version from the remote\'s main after a fetch, not from the checkout', async () => {
    // Another session saved v2 on the remote; the factory clone has not fetched it.
    const other = join(root, 'other')
    git(root, 'clone', '--quiet', bare, other)
    writeFileSync(join(other, 'guideline', 'v2.md'), '---\nversion: 2\n---\nOther.\n')
    git(other, 'add', '.')
    git(other, '-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', 'commit', '--quiet', '-m', 'v2')
    git(other, 'push', '--quiet', 'origin', 'main')
    // Against the v1 the page showed, nothing is saved: the owner has not seen v2.
    const stale = await saverOf().accept(proposal('Third.\n'), 1)
    expect(stale).toEqual({ saved: false, reason: 'Not saved: the guideline is at v2 now, not the version this proposal was shown against. Reload the page and compare again.', mr: undefined })
    expect(filesOnMain()).toEqual(['guideline/v1.md', 'guideline/v2.md'])
    expect(readdirSync(saves)).toEqual([])
    const saved = await saverOf().accept(proposal('Third.\n'), 2)
    expect(saved).toMatchObject({ saved: true, version: 3 })
    expect(fileOnMain('guideline/v3.md')).toContain('from_version: 2')
  })

  it('stores a planted secret masked, in the text and in the merge request', async () => {
    const saved = await saverOf().accept(proposal(`Never print ${PLANTED}.\n`, { project: `/projects/${PLANTED}` }), 1)
    expect(saved.saved).toBe(true)
    expect(fileOnMain('guideline/v2.md')).toContain(`Never print ${REDACTED}.`)
    expect(fileOnMain('guideline/v2.md')).not.toContain(PLANTED)
    expect(JSON.stringify(runner.glabCalls)).not.toContain(PLANTED)
    expect(git(bare, 'log', '-1', '--format=%B', 'main')).not.toContain(PLANTED)
  })

  it('merges by the branch\'s name when glab printed no merge request address', async () => {
    runner.created = 'done\n'
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toEqual({ saved: true, version: 2, mr: undefined })
    expect(runner.glabCalls[1]!.slice(0, 3)).toEqual(['mr', 'merge', 'zees-factory/guideline-v2-20261127T101530Z'])
  })

  it('a newer read after the save: the next session starts with v2 in its starting instructions', async () => {
    const shared = records()
    const sections = new GuidelineSection(shared, () => {})
    const agent = async (id: string): Promise<GuidelineAgent & { ctx: Context }> => {
      const ctx = new Context(); contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      return { id, ctx }
    }
    const sectionOf = async (of: { ctx: Context }) => (await of.ctx.systemPrompt.assemble()).sections.find(section => section.name === GuidelineSection.NAME)?.text
    const first = await agent('session-1')
    await sections.attach(first)
    expect(await sectionOf(first)).toContain('version 1')
    expect((await saverOf(shared).accept(proposal('Keep to the minimum feature.\n'), 1)).saved).toBe(true)
    // The factory clone's checkout still has only v1; the session reads the remote's main.
    expect(readdirSync(join(factory, 'guideline'))).toEqual(['v1.md'])
    const next = await agent('session-2')
    await sections.attach(next)
    expect(await sectionOf(next)).toContain('version 2 (2026-11-27)')
    expect(await sectionOf(next)).toContain('Keep to the minimum feature.')
    expect(await sections.jobVersion('session-2')).toBe('v2')
    // A session already running keeps the version it started with.
    expect(await sections.jobVersion('session-1')).toBe('v1')
  })
})

describe('a failed step saves nothing on main and says which step failed', () => {
  it('the merge fails: the merge request stays open with its address, main is unchanged, the worktree is removed', async () => {
    runner.fail.merge = 'ERROR: merge conflict\nmore lines'
    const before = mainOf()
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toEqual({ saved: false, reason: 'Not saved: the merge step failed: ERROR: merge conflict', mr: 'https://gitlab.example/factory/-/merge_requests/7' })
    expect([mainOf(), filesOnMain()]).toEqual([before, ['guideline/v1.md']])
    // The pushed branch stays, as the merge request's source.
    expect(branchesOf()).toEqual(['main', 'zees-factory/guideline-v2-20261127T101530Z'])
    expect(readdirSync(saves)).toEqual([])
  })

  it('masks a secret quoted in a failed step\'s message', async () => {
    runner.fail.merge = `ERROR: hook said ${PLANTED}`
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toMatchObject({ saved: false, reason: `Not saved: the merge step failed: ERROR: hook said ${REDACTED}` })
  })

  it('a GIT_DIR in DSH\'s own environment reaches neither git nor glab', async () => {
    const other = join(root, 'other.git')
    git(root, 'init', '--bare', '--quiet', other)
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE }
    process.env.GIT_DIR = other
    process.env.GIT_WORK_TREE = root
    try {
      expect(await saverOf().accept(proposal('Two.\n'), 1)).toMatchObject({ saved: true, version: 2 })
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree
    }
    expect(filesOnMain()).toEqual(['guideline/v1.md', 'guideline/v2.md'])
    expect(git(other, 'for-each-ref')).toBe('')
  })

  it('the merge request cannot be opened: nothing merged, no address', async () => {
    runner.fail.create = 'could not find a GitLab host for https://user:secret-password@gitlab.example/factory.git'
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toEqual({ saved: false, reason: 'Not saved: the merge request step failed: could not find a GitLab host for https://gitlab.example/factory.git', mr: undefined })
    expect(filesOnMain()).toEqual(['guideline/v1.md'])
  })

  it('the push is refused: no branch on the remote, no glab call', async () => {
    const hook = join(bare, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "push refused by the remote" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toMatchObject({ saved: false, mr: undefined })
    expect((saved as { reason: string }).reason).toMatch(/^Not saved: the push step failed: /)
    expect([branchesOf(), runner.glabCalls, readdirSync(saves)]).toEqual([['main'], [], []])
  })

  it('the fetch fails: nothing is made', async () => {
    git(factory, 'remote', 'set-url', 'origin', join(root, 'missing.git'))
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toMatchObject({ saved: false })
    expect((saved as { reason: string }).reason).toMatch(/^Not saved: the fetch step failed: /)
    expect([readdirSync(saves), runner.glabCalls]).toEqual([[], []])
  })

  it('without glab, without a factory repository, or while another save runs, it refuses before any git call', async () => {
    expect(await saverOf(records(), null).accept(proposal('Two.\n'), 1)).toEqual({ saved: false, reason: `Not saved: ${FactoryRepoSave.NO_GLAB}`, mr: undefined })
    expect(runner.calls).toEqual([])
    // A records module whose guideline reader found no repository.
    const none = new RemoteGuidelineRecords(recordsModule(root, FAKE_RECORDS.replace('return { folder: folder.pathname',
      'return { folder: null, reason: \'The factory repository was not found.\', versions: [], current: null }; return { folder: folder.pathname')), { runner })
    expect(await saverOf(none).accept(proposal('Two.\n'), 1)).toEqual({ saved: false, reason: 'Not saved: The factory repository was not found.', mr: undefined })
    const repo = new FactoryRepoSave({ glab: GLAB, root: saves })
    const remote = new FactoryRemote({ repo: factory, runner })
    const one = repo.save(remote, () => ({ branch: 'zees-factory/one', title: 't', message: 'm', description: 'd', files: [{ path: 'guideline/v2.md', text: 'x\n' }] }))
    expect([repo.busy, await repo.save(remote, () => { throw new Error('never asked') })]).toEqual([true, { saved: false, step: 'start', error: FactoryRepoSave.BUSY, mr: undefined }])
    expect((await one).saved).toBe(true)
    expect(repo.busy).toBe(false)
    // The saver is busy from the first moment of an Accept, so a second one at once is refused at the page's check.
    const saver = saverOf()
    const first = saver.accept(proposal('Three.\n'), 2)
    expect([saver.busy, await saver.accept(proposal('Four.\n'), 2)]).toEqual([true, { saved: false, reason: `Not saved: ${FactoryRepoSave.BUSY}`, mr: undefined }])
    expect(await first).toMatchObject({ saved: true, version: 3 })
  })

  it('never writes over a file, never outside the guideline folder, and never on an odd branch name', async () => {
    const repo = new FactoryRepoSave({ glab: GLAB, root: saves })
    const remote = new FactoryRemote({ repo: factory, runner })
    const change = (files: { path: string; text: string }[], branch = 'zees-factory/x') => () => ({ branch, title: 't', message: 'm', description: 'd', files })
    expect(await repo.save(remote, change([{ path: 'guideline/v1.md', text: 'edited\n' }]))).toEqual({ saved: false, step: 'write', error: 'guideline/v1.md exists already and is never written over', mr: undefined })
    for (const path of ['README.md', 'guideline/../README.md', '/guideline/v9.md', 'guideline/'])
      expect(await repo.save(remote, change([{ path, text: 'x\n' }]))).toMatchObject({ saved: false, step: 'write' })
    expect(await repo.save(remote, change([{ path: 'guideline/v9.md', text: 'x\n' }], '-x'))).toMatchObject({ saved: false, step: 'start' })
    expect([fileOnMain('guideline/v1.md'), branchesOf(), readdirSync(saves), runner.glabCalls]).toEqual([V1.trimEnd(), ['main'], [], []])
  })
})

describe('trend reports: in the Accept\'s commit, and from the button by the same route', () => {
  /** A target project with sample jobs: two under v1 (one with a comment), one under v2. */
  let project = ''
  const line = (fields: Record<string, unknown>) => JSON.stringify({ ts: '2026-11-21T08:00:00.000Z', project, step_id: 's1', kind: 'job_start', summary: 'Started.', ...fields })
  function sampleJobs(comment = 'Keep to the minimum feature.'): void {
    project = join(root, 'testbed')
    mkdirSync(join(project, '.factory'), { recursive: true })
    writeFileSync(join(project, '.factory', 'actions.jsonl'), [
      line({ job_id: 'job-a', guideline_version: 'v1' }), line({ job_id: 'job-a', step_id: 's2', kind: 'permission_answer', summary: 'Approved: widen the story.', ts: '2026-11-21T08:05:00.000Z' }),
      line({ job_id: 'job-b', guideline_version: 'v1', ts: '2026-11-22T08:00:00.000Z' }),
      line({ job_id: 'job-c', guideline_version: 'v2', ts: '2026-11-28T08:00:00.000Z' }),
    ].join('\n') + '\n')
    writeFileSync(join(project, '.factory', 'reviews.jsonl'), `${JSON.stringify({ ts: '2026-11-23T08:00:00.000Z', project, job_id: 'job-a', step_id: 's2', comment })}\n`)
  }
  /** A stand-in author: it asks no model, writes down what it was given, and echoes the comments it saw into the report. */
  class Author implements TrendAuthor {
    readonly asked: TrendInput[] = []
    fail: string | undefined
    async write(input: TrendInput): Promise<WrittenTrend> {
      this.asked.push(input)
      if (this.fail !== undefined) throw new RecordsRefusal(503, this.fail)
      const said = input.jobs.flatMap(job => job.reviews.map(review => review.comment))
      return { body: TrendWriter.bodyOf(input, `Report on ${input.jobs.length} jobs.${said.length === 0 ? '' : ` The owner said: ${said.join(' ')}`}`, 1200), jobs: input.jobs.length }
    }
  }
  let author = new Author()
  const reportingSaver = (of: RemoteGuidelineRecords = records(), glab: string | null = GLAB) => new GuidelineSaver({ records: of, repo: new FactoryRepoSave({ glab: glab ?? undefined, root: saves }), now: () => NOW,
    reports: new TrendReports({ author, records: of, projects: [project] }) })
  /** The files the newest commit on the remote's main changed. */
  const lastCommitFiles = () => git(bare, 'show', '--name-only', '--format=', 'main').split('\n').filter(Boolean).sort()
  beforeEach(() => { sampleJobs(); author = new Author() })

  it('the ticket\'s check: accepting v2 leaves v1\'s report in the same commit; the button writes v2\'s report naming v1; the page shows each beside its version', async () => {
    const of = records()
    const saver = reportingSaver(of)
    const before = mainOf()
    expect(await saver.accept(proposal('# Guideline\nKeep to the minimum feature.\n'), 1)).toMatchObject({ saved: true, version: 2 })
    // One commit, one merge request: the new version and the report of the version it replaced.
    expect([git(bare, 'rev-list', '--count', `${before}..main`), lastCommitFiles(), runner.glabCalls.length]).toEqual(['1', ['guideline/v1-trends.md', 'guideline/v2.md'], 2])
    expect(fileOnMain('guideline/v1-trends.md')).toBe('---\nversion: 1\ndate: 2026-11-27\njobs: 2\nwritten: accepted\n---\n# Trend report for guideline v1\n\n'
      + 'This is the first version; there is none before it.\n\nReport on 2 jobs. The owner said: Keep to the minimum feature.\n\nSpent: 1,200 tokens\nProviders: dsh (the model set in its factory profile)')
    expect(author.asked.map(input => [input.version.version, input.before, input.jobs.map(job => job.job_id)])).toEqual([[1, null, ['job-a', 'job-b']]])
    // The button on the current version, v2: its own branch, merge request and merge.
    const merged = mainOf()
    expect(await saver.report(2)).toEqual({ saved: true, version: 2, mr: 'https://gitlab.example/factory/-/merge_requests/7' })
    expect([git(bare, 'rev-list', '--count', `${merged}..main`), lastCommitFiles()]).toEqual(['1', ['guideline/v2-trends.md']])
    const v2 = fileOnMain('guideline/v2-trends.md')
    expect(v2).toMatch(/^---\nversion: 2\ndate: 2026-11-27\njobs: 1\ncompared_with: 1\nwritten: asked\n---\n# Trend report for guideline v2\n\nCompared with v1\.\n/)
    const branch = 'zees-factory/trends-v2-20261127T101530Z'
    expect(runner.glabCalls.slice(2)).toEqual([
      ['mr', 'create', '--source-branch', branch, '--target-branch', 'main', '--title', 'trend report for guideline v2',
        '--description', 'The trend report for guideline v2. Asked for by the owner on the review page and merged by the fork.', '--remove-source-branch=false', '--yes'],
      ['mr', 'merge', '7', '--yes', '--auto-merge=false', '--sha', mainOf()],
    ])
    // Nothing in the factory clone's checkout, and no worktree left.
    expect([readdirSync(join(factory, 'guideline')), readdirSync(saves), git(factory, 'branch', '--show-current')]).toEqual([['v1.md'], [], 'main'])
    // The page reads both reports from the remote's main and shows each beside its version.
    const read = (await of.guidelineReader()).read()
    expect(read.reports!.map(report => [report.version, report.jobs, report.compared_with, report.written])).toEqual([[2, 1, 1, 'asked'], [1, 2, null, 'accepted']])
    const pageOf = (version: number) => new JSDOM(new ReviewPage('n').guideline(read, read.versions.find(each => each.version === version))).window.document
    const v2Page = pageOf(2), v1Page = pageOf(1)
    expect([...v2Page.querySelectorAll('nav a.version')].map(row => row.querySelectorAll('span')[2]!.textContent)).toEqual(['Trend report · 1 job', 'Trend report · 2 jobs'])
    expect([v2Page.querySelector('aside.report h2')!.textContent, v2Page.querySelector('aside.report .pill')!.textContent]).toEqual(['Trend report for v2', 'written 27 Nov, on request'])
    expect(v2Page.querySelector('aside.report .report-text')!.textContent).toContain('Compared with v1.')
    expect([v1Page.querySelector('aside.report .pill')!.textContent, v1Page.querySelector('#write-trend')]).toEqual(['written 27 Nov, when v2 replaced it', null])
    expect(v1Page.querySelector('aside.report .report-text')!.textContent).toContain('Report on 2 jobs.')
  })

  it('accepting the first version writes no report and asks no thread', async () => {
    git(factory, 'rm', '--quiet', 'guideline/v1.md')
    git(factory, 'commit', '--quiet', '-m', 'none')
    git(factory, 'push', '--quiet', 'origin', 'main')
    expect(await reportingSaver().accept(proposal('One.\n'), null)).toMatchObject({ saved: true, version: 1 })
    expect([lastCommitFiles(), author.asked]).toEqual([['guideline/v1.md'], []])
  })

  it('a report that cannot be written stops the Accept: nothing pushed, no merge request, the reason said', async () => {
    author.fail = 'the report thread did not answer in time'
    const before = mainOf()
    expect(await reportingSaver().accept(proposal('Two.\n'), 1))
      .toEqual({ saved: false, reason: 'Not saved: the trend report for v1 could not be written: the report thread did not answer in time. Nothing was saved; try Accept again later.', mr: undefined })
    expect([mainOf(), branchesOf(), runner.glabCalls, readdirSync(saves)]).toEqual([before, ['main'], [], []])
  })

  it('an Accept against a version that moved on asks no thread', async () => {
    expect(await reportingSaver().accept(proposal('Two.\n'), 7)).toMatchObject({ saved: false, reason: expect.stringContaining('the guideline is at v1 now') })
    expect([author.asked, runner.glabCalls]).toEqual([[], []])
  })

  it('asking again replaces the report in a new commit; an old version, or no version, is refused before any thread is asked', async () => {
    const saver = reportingSaver()
    expect(await saver.report(1)).toMatchObject({ saved: true, version: 1 })
    const first = fileOnMain('guideline/v1-trends.md')
    author = new Author()
    sampleJobs('Ask me before any push.')
    const again = reportingSaver()
    expect(await again.report(1)).toMatchObject({ saved: true, version: 1 })
    expect([lastCommitFiles(), fileOnMain('guideline/v1-trends.md') === first, fileOnMain('guideline/v1-trends.md')]).toEqual([['guideline/v1-trends.md'], false, expect.stringContaining('Ask me before any push.')])
    expect(runner.glabCalls.filter(call => call[1] === 'create').at(-1)).toContain('The trend report for guideline v1, replacing the one written before. Asked for by the owner on the review page and merged by the fork.')
    await again.accept(proposal('Two.\n'), 1)
    author = new Author()
    const old = await reportingSaver().report(1)
    expect([old, author.asked]).toEqual([{ saved: false, reason: 'Not saved: only the current version\'s trend report can be written, and v1 is not the current version now (v2 is). Reload the page.', mr: undefined }, []])
    // Without trend reports set up, the button is refused and nothing runs.
    expect(await saverOf().report(2)).toEqual({ saved: false, reason: `Not saved: ${GuidelineSaver.NO_REPORTS}`, mr: undefined })
  })

  it('a version no job ran under still gets a report, with jobs: 0, and the question says no job ran', async () => {
    writeFileSync(join(project, '.factory', 'actions.jsonl'), '')
    expect(await reportingSaver().report(1)).toMatchObject({ saved: true })
    expect(fileOnMain('guideline/v1-trends.md')).toMatch(/^---\nversion: 1\ndate: 2026-11-27\njobs: 0\nwritten: asked\n---\n/)
    expect(TrendPrompt.textOf(author.asked[0]!)).toContain('No job ran under this version.')
  })

  it('stores a planted secret from a comment masked, with every listed project\'s mask', async () => {
    sampleJobs(`Never print ${PLANTED}.`)
    expect(await reportingSaver().report(1)).toMatchObject({ saved: true })
    const report = fileOnMain('guideline/v1-trends.md')
    expect([report.includes(PLANTED), report.includes(`Never print ${REDACTED}.`)]).toEqual([false, true])
  })

  it('a failed step of the button\'s save names the step and links the merge request; the worktree is removed', async () => {
    runner.fail.merge = 'ERROR: not mergeable yet'
    const before = mainOf()
    expect(await reportingSaver().report(1)).toEqual({ saved: false, reason: 'Not saved: the merge step failed: ERROR: not mergeable yet', mr: 'https://gitlab.example/factory/-/merge_requests/7' })
    expect([mainOf(), readdirSync(saves), branchesOf()]).toEqual([before, [], ['main', 'zees-factory/trends-v1-20261127T101530Z']])
  })

  it('is busy while a report is written, so an Accept and a report never run at once', async () => {
    const saver = reportingSaver()
    const writing = saver.report(1)
    expect([saver.busy, await saver.accept(proposal('Two.\n'), 1)]).toEqual([true, { saved: false, reason: `Not saved: ${FactoryRepoSave.BUSY}`, mr: undefined }])
    expect(await writing).toMatchObject({ saved: true })
  })

  it('a fetch that fails stops the Accept and the button before any thread is asked', async () => {
    git(factory, 'remote', 'set-url', 'origin', join(root, 'missing.git'))
    for (const saved of [await reportingSaver().accept(proposal('Two.\n'), 1), await reportingSaver().report(1)])
      expect((saved as { reason: string }).reason).toMatch(/^Not saved: the fetch step failed: /)
    expect([author.asked, runner.glabCalls, readdirSync(saves)]).toEqual([[], [], []])
  })

  it('a save that cannot start (glab not found) stops the Accept and the button before any thread is asked', async () => {
    for (const saved of [await reportingSaver(records(), null).accept(proposal('Two.\n'), 1), await reportingSaver(records(), null).report(1)])
      expect(saved).toEqual({ saved: false, reason: `Not saved: ${FactoryRepoSave.NO_GLAB}`, mr: undefined })
    expect([author.asked, runner.glabCalls, readdirSync(saves)]).toEqual([[], [], []])
  })

  it('masks the report with each listed project\'s own mask, not only the first one\'s', async () => {
    const second = join(root, 'second')
    mkdirSync(join(second, '.factory'), { recursive: true })
    writeFileSync(join(second, '.factory', 'actions.jsonl'), `${JSON.stringify({ ts: '2026-11-21T09:00:00.000Z', project: second, job_id: 'job-z', step_id: 's1', kind: 'job_start', summary: 'Started.', guideline_version: 'v1' })}\n`)
    writeFileSync(join(second, '.factory', 'reviews.jsonl'), `${JSON.stringify({ ts: '2026-11-23T09:00:00.000Z', project: second, job_id: 'job-z', comment: 'Never print second-only-secret.' })}\n`)
    // The second project's mask alone knows its own secret.
    const of = new RemoteGuidelineRecords(recordsModule(factory, FAKE_RECORDS.replace('maskText: text => clean(text),',
      'maskText: text => project.endsWith(\'/second\') ? clean(text).replaceAll(\'second-only-secret\', \'[second-masked]\') : clean(text),')), { runner })
    const saver = new GuidelineSaver({ records: of, repo: new FactoryRepoSave({ glab: GLAB, root: saves }), now: () => NOW,
      reports: new TrendReports({ author, records: of, projects: [project, second] }) })
    expect(await saver.report(1)).toMatchObject({ saved: true })
    const report = fileOnMain('guideline/v1-trends.md')
    expect([report.includes('second-only-secret'), report.includes('Never print [second-masked].'), report.includes('jobs: 3')]).toEqual([false, true, true])
  })

  it('a plain factory folder reads its reports from the folder', () => {
    const folder = join(root, 'plain')
    mkdirSync(folder)
    writeFileSync(join(folder, 'v1-trends.md'), TrendReportFile.textOf({ version: 1, date: '2026-11-20', jobs: 3, compared_with: null, written: 'asked' }, 'Text.\n'))
    writeFileSync(join(folder, 'v2.md'), 'not a report\n')
    expect(RemoteGuidelineRecords.reportsIn(folder)).toEqual([{ version: 1, date: '2026-11-20', jobs: 3, compared_with: null, written: 'asked', text: 'Text.\n' }])
    expect(RemoteGuidelineRecords.reportsIn(join(root, 'missing'))).toEqual([])
  })
})

describe('reading the guideline from the remote\'s main', () => {
  it('reads the versions the remote\'s main held at the last fetch, never the checkout, and says why when there is no copy of it', async () => {
    // The checkout holds a v2 that is not on the remote: it is not read.
    writeFileSync(join(factory, 'guideline', 'v2.md'), 'checkout only\n')
    const reader: GuidelineSource = await records().guidelineReader()
    const read = reader.read()
    expect([read.current?.version, read.versions.map(version => version.version), read.current?.from_job, read.current?.text]).toEqual([1, [1], 'job-0', '# Guideline\nKeep it small.\n'])
    // A repository with no copy of the remote's main.
    git(factory, 'update-ref', '-d', 'refs/remotes/origin/main')
    const none = (await records().guidelineReader()).read()
    expect([none.current, none.reason]).toEqual([null, 'The guideline could not be read: the factory repository has no origin/main yet'])
    // The plain records module still reads the folder it is given, as before.
    expect((await new FactoryRecordsModule(recordsModule(factory)).guidelineReader()).read().current?.version).toBe(2)
  })

  it('a factory folder that is not a repository of its own is read as a folder, never as the repository around it', async () => {
    // A plain folder inside the factory clone: git must not take the clone for it, and nothing is fetched.
    const plain = join(factory, 'plain')
    mkdirSync(join(plain, 'guideline'), { recursive: true })
    writeFileSync(join(plain, 'guideline', 'v5.md'), 'Plain.\n')
    writeFileSync(join(plain, 'guideline', 'v5-trends.md'), TrendReportFile.textOf({ version: 5, date: '2026-11-25', jobs: 2, compared_with: 4, written: 'asked' }, 'Report.\n'))
    const reader = new RemoteGuidelineRecords(recordsModule(plain), { runner })
    const read = (await reader.guidelineReader()).read()
    expect(read.current).toMatchObject({ version: 5, text: 'Plain.\n' })
    // Its trend reports are read from the folder too, so the page shows them.
    expect(read.reports).toEqual([{ version: 5, date: '2026-11-25', jobs: 2, compared_with: 4, written: 'asked', text: 'Report.\n' }])
    expect(await (await reader.factoryRemote()).isRepository()).toBe(false)
    expect(new Set(runner.calls.map(call => call.args.join(' ')))).toEqual(new Set(['rev-parse --git-dir']))
  })

  it('a version file reads back as it was written', () => {
    const text = GuidelineFile.textOf({ version: 4, date: '2026-11-27', from_job: 'job\nwith a break', from_version: 3 }, 'Line one.\nLine two.')
    expect(GuidelineFile.parse('v4.md', text)).toEqual({ version: 4, date: '2026-11-27', from_job: 'job with a break', from_version: 3, text: 'Line one.\nLine two.\n' })
    expect([GuidelineFile.parse('v4-trends.md', text), GuidelineFile.pathOf(4)]).toEqual([null, 'guideline/v4.md'])
  })

  it('finds glab from the setting only when one is given, else on PATH, else in Homebrew\'s folder', () => {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'glab'), '#!/bin/sh\n')
    chmodSync(join(bin, 'glab'), 0o755)
    expect(GlabProgram.find(undefined, bin)).toBe(join(bin, 'glab'))
    expect(GlabProgram.find(join(root, 'nothing'), bin)).toBeUndefined()
    expect(GlabProgram.find(join(bin, 'glab'), '')).toBe(join(bin, 'glab'))
    expect(GlabProgram.find(undefined, 'relative/bin')).toBe(existsSync(GlabProgram.HOMEBREW) ? GlabProgram.HOMEBREW : undefined)
  })
})

const FACTORY = process.env.ZEES_FACTORY_DIR?.trim() ?? ''
const realTitle = FACTORY === '' ? 'the factory\'s real guideline reader (SKIPPED: set ZEES_FACTORY_DIR to the factory\'s folder to run it)' : 'the factory\'s real guideline reader'

describe.skipIf(FACTORY === '')(realTitle, () => {
  it('reads a saved version as the fork reads it from the remote\'s main', async () => {
    expect((await saverOf().accept(proposal('# Guideline\nKeep to the minimum feature.\n'), 1)).saved).toBe(true)
    git(factory, 'pull', '--quiet', '--ff-only', 'origin', 'main')
    const lib = await import(pathToFileURL(join(FACTORY, 'lib', 'dist', 'jobLog.js')).href) as { GuidelineReader: new (options: { factoryDir: string }) => GuidelineSource }
    const real = new lib.GuidelineReader({ factoryDir: factory }).read()
    const fork = (await records().guidelineReader()).read()
    expect(fork.versions).toEqual(real.versions)
    expect(real.current).toEqual({ version: 2, date: '2026-11-27', from_job: 'job-a1', from_version: 1, text: '# Guideline\nKeep to the minimum feature.\n' })
  })
})
