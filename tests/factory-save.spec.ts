/**
 * The guideline's save path and its reading from the remote's save branch (or main), on a throwaway factory repository: a bare repository in a temporary folder
 * stands for the factory's remote, and a clone of it for the factory repository. git runs for real on them, with an empty global config so nothing of
 * the owner's git setup is read; glab is a stand-in whose merge moves the bare repository's target branch, so no test reaches GitLab or any real remote.
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
import { FactoryRemote, FactoryRepoSave, GlabProgram, GuidelineFile, GuidelineSaver, RemoteGuidelineRecords, SaveBranchName, TrendReports, TrialBranchGuard } from '../src/factory/save.ts'
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
/** The save branch, the `review.saveBranch` setting the tests run with: a trial branch of the bare repository, next to its `main`. */
const SAVE = 'zty3776/epic-3-guideline-trial'
const tipOf = () => git(bare, 'rev-parse', `refs/heads/${SAVE}`)
const mainOf = () => git(bare, 'rev-parse', 'refs/heads/main')
const fileOnTip = (path: string) => git(bare, 'show', `${SAVE}:${path}`)
const filesOnTip = () => git(bare, 'ls-tree', '--name-only', SAVE, 'guideline/').split('\n').filter(Boolean)
const branchesOf = () => git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean).sort()

/**
 * The runner the tests give the save path: git runs for real, but only with the empty global config; glab is a stand-in that writes each call down.
 * Its `mr create` prints a merge request's address; its `mr merge` moves the merge request's target branch to its source branch, as GitLab would.
 */
class TestRunner implements OrcaRunner {
  readonly calls: { program: string; args: string[]; cwd: string | undefined }[] = []
  fail: { create?: string; merge?: string } = {}
  /** What `mr create` prints. */
  created = 'Creating merge request for zees-factory into main in factory\n\n!7 guideline\n https://gitlab.example/factory/-/merge_requests/7\n'
  private readonly real = new ExecFileRunner()
  private branch = ''
  private target = ''
  async run(program: string, args: readonly string[], timeoutMs: number, options: RunOptions = {}): Promise<OrcaRun> {
    this.calls.push({ program, args: [...args], cwd: options.cwd })
    if (program === 'git') return this.real.run(program, args, timeoutMs, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } })
    if (program !== GLAB) return { ok: false, error: `the test runs no ${program}` }
    if (args[0] === 'mr' && args[1] === 'create') {
      if (this.fail.create !== undefined) return { ok: false, error: this.fail.create }
      this.branch = args[args.indexOf('--source-branch') + 1]!
      this.target = args[args.indexOf('--target-branch') + 1]!
      return { ok: true, stdout: this.created }
    }
    if (args[0] === 'mr' && args[1] === 'merge') {
      if (this.fail.merge !== undefined) return { ok: false, error: this.fail.merge }
      const sha = args[args.indexOf('--sha') + 1]!
      // The bare repository of the worktree glab runs in, as GitLab would merge in that project, into the merge request's target branch.
      const remote = git(options.cwd!, 'remote', 'get-url', 'origin')
      if (git(remote, 'rev-parse', `refs/heads/${this.branch}`) !== sha) return { ok: false, error: 'the branch is not at that commit' }
      git(remote, 'update-ref', `refs/heads/${this.target}`, sha)
      return { ok: true, stdout: 'Merged!' }
    }
    return { ok: false, error: 'unknown glab call' }
  }
  get glabCalls(): string[][] { return this.calls.filter(call => call.program === GLAB).map(call => call.args) }
}

let runner = new TestRunner()
/**
 * The factory's records stand-in, written into the clone `factory`, so its guideline reader names that folder's `guideline/`. `saveBranch` is the
 * `review.saveBranch` setting: by default the trial branch `SAVE`; `null` leaves it unset, so the guideline is read from `main` and nothing is saved.
 */
const records = (saveBranch: string | null = SAVE) =>
  new RemoteGuidelineRecords(recordsModule(factory), { runner, saveBranch: saveBranch ?? undefined })
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
  // The trial branch saves go to, at main's commit; the push also gives the clone its copy, origin/<branch>.
  git(factory, 'push', '--quiet', 'origin', `main:refs/heads/${SAVE}`)
  runner = new TestRunner()
})
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  rmSync(root, { recursive: true, force: true })
})

describe('Accept saves the next version through a merge request', () => {
  it('creates v2 on the save branch from one pushed commit, merged at once, with v1 unchanged and no worktree left', async () => {
    const before = tipOf()
    const v1 = fileOnTip('guideline/v1.md')
    const saved = await saverOf().accept(proposal('# Guideline\nKeep to the minimum feature.\n'), 1)
    expect(saved).toEqual({ saved: true, version: 2, mr: 'https://gitlab.example/factory/-/merge_requests/7' })
    expect(git(bare, 'rev-list', '--count', `${before}..${SAVE}`)).toBe('1')
    expect(filesOnTip()).toEqual(['guideline/v1.md', 'guideline/v2.md'])
    expect(fileOnTip('guideline/v1.md')).toBe(v1)
    expect(fileOnTip('guideline/v2.md')).toBe('---\nversion: 2\ndate: 2026-11-27\nfrom_job: job-a1\nfrom_version: 1\n---\n# Guideline\nKeep to the minimum feature.')
    // Only the version file changed, by the owner's own identity.
    expect(git(bare, 'show', '--name-only', '--format=%an', SAVE).split('\n').filter(Boolean)).toEqual(['Test Owner', 'guideline/v2.md'])
    // The merge request: from a new branch into main, deleting no branch; merged at once and only at the pushed commit.
    const branch = 'zees-factory/guideline-v2-20261127T101530Z'
    expect(runner.glabCalls).toEqual([
      ['mr', 'create', '--source-branch', branch, '--target-branch', SAVE, '--title', 'guideline v2, from the review of factory-testbed job 3',
        '--description', 'Guideline v2, replacing v1, from the review talk on factory-testbed job 3. Accepted by the owner on the review page and merged by the fork.',
        '--remove-source-branch=false', '--yes'],
      ['mr', 'merge', '7', '--yes', '--auto-merge=false', '--sha', tipOf()],
    ])
    expect(branchesOf()).toEqual(['main', branch, SAVE])
    // The factory clone, its checkout and its branches are untouched; the save's worktree and its folder are gone. The remote's main never moved.
    expect([git(factory, 'branch', '--show-current'), git(factory, 'status', '--porcelain'), git(factory, 'branch', '--format=%(refname:short)')])
      .toEqual(['main', expect.stringMatching(/^\?\? records-\d+\.mjs$/), 'main'])
    expect(readdirSync(join(factory, 'guideline'))).toEqual(['v1.md'])
    expect(git(factory, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toEqual([`worktree ${factory}`])
    expect(readdirSync(saves)).toEqual([])
    expect(mainOf()).toBe(before)
    // git never ran in a session's folder: only in the factory clone and the save's own worktree.
    expect(new Set(runner.calls.filter(call => call.program === 'git').map(call => call.cwd === factory ? 'factory' : call.cwd!.startsWith(saves) ? 'save' : call.cwd)))
      .toEqual(new Set(['factory', 'save']))
  })

  it('writes version 1 with no from_version when the save branch has no guideline yet', async () => {
    git(factory, 'rm', '--quiet', 'guideline/v1.md')
    git(factory, 'commit', '--quiet', '-m', 'no guideline')
    git(factory, 'push', '--quiet', 'origin', `HEAD:refs/heads/${SAVE}`)
    const saved = await saverOf().accept(proposal('First.\n'), null)
    expect(saved).toMatchObject({ saved: true, version: 1 })
    expect(fileOnTip('guideline/v1.md')).toBe('---\nversion: 1\ndate: 2026-11-27\nfrom_job: job-a1\n---\nFirst.')
  })

  it('numbers the version from the save branch after a fetch, not from the checkout', async () => {
    // Another session saved v2 on the remote; the factory clone has not fetched it.
    const other = join(root, 'other')
    git(root, 'clone', '--quiet', bare, other)
    writeFileSync(join(other, 'guideline', 'v2.md'), '---\nversion: 2\n---\nOther.\n')
    git(other, 'add', '.')
    git(other, '-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', 'commit', '--quiet', '-m', 'v2')
    git(other, 'push', '--quiet', 'origin', `HEAD:refs/heads/${SAVE}`)
    // Against the v1 the page showed, nothing is saved: the owner has not seen v2.
    const stale = await saverOf().accept(proposal('Third.\n'), 1)
    expect(stale).toEqual({ saved: false, reason: 'Not saved: the guideline is at v2 now, not the version this proposal was shown against. Reload the page and compare again.', mr: undefined })
    expect(filesOnTip()).toEqual(['guideline/v1.md', 'guideline/v2.md'])
    expect(readdirSync(saves)).toEqual([])
    const saved = await saverOf().accept(proposal('Third.\n'), 2)
    expect(saved).toMatchObject({ saved: true, version: 3 })
    expect(fileOnTip('guideline/v3.md')).toContain('from_version: 2')
  })

  it('stores a planted secret masked, in the text and in the merge request', async () => {
    const saved = await saverOf().accept(proposal(`Never print ${PLANTED}.\n`, { project: `/projects/${PLANTED}` }), 1)
    expect(saved.saved).toBe(true)
    expect(fileOnTip('guideline/v2.md')).toContain(`Never print ${REDACTED}.`)
    expect(fileOnTip('guideline/v2.md')).not.toContain(PLANTED)
    expect(JSON.stringify(runner.glabCalls)).not.toContain(PLANTED)
    expect(git(bare, 'log', '-1', '--format=%B', SAVE)).not.toContain(PLANTED)
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
    // The factory clone's checkout and the remote's main still have only v1; the session reads the save branch.
    expect([readdirSync(join(factory, 'guideline')), git(bare, 'ls-tree', '--name-only', 'main', 'guideline/')]).toEqual([['v1.md'], 'guideline/v1.md'])
    const next = await agent('session-2')
    await sections.attach(next)
    expect(await sectionOf(next)).toContain('version 2 (2026-11-27)')
    expect(await sectionOf(next)).toContain('Keep to the minimum feature.')
    expect(await sections.jobVersion('session-2')).toBe('v2')
    // A session already running keeps the version it started with.
    expect(await sections.jobVersion('session-1')).toBe('v1')
  })
})

describe('a failed step saves nothing on the save branch and says which step failed', () => {
  it('the merge fails: the merge request stays open with its address, the save branch is unchanged, the worktree is removed', async () => {
    runner.fail.merge = 'ERROR: merge conflict\nmore lines'
    const before = tipOf()
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toEqual({ saved: false, reason: 'Not saved: the merge step failed: ERROR: merge conflict', mr: 'https://gitlab.example/factory/-/merge_requests/7' })
    expect([tipOf(), filesOnTip()]).toEqual([before, ['guideline/v1.md']])
    // The pushed branch stays, as the merge request's source.
    expect(branchesOf()).toEqual(['main', 'zees-factory/guideline-v2-20261127T101530Z', SAVE])
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
    expect(filesOnTip()).toEqual(['guideline/v1.md', 'guideline/v2.md'])
    expect(git(other, 'for-each-ref')).toBe('')
  })

  it('the merge request cannot be opened: nothing merged, no address', async () => {
    runner.fail.create = 'could not find a GitLab host for https://user:secret-password@gitlab.example/factory.git'
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toEqual({ saved: false, reason: 'Not saved: the merge request step failed: could not find a GitLab host for https://gitlab.example/factory.git', mr: undefined })
    expect(filesOnTip()).toEqual(['guideline/v1.md'])
  })

  it('the push is refused: no branch on the remote, no glab call', async () => {
    const hook = join(bare, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "push refused by the remote" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toMatchObject({ saved: false, mr: undefined })
    expect((saved as { reason: string }).reason).toMatch(/^Not saved: the push step failed: /)
    expect([branchesOf(), runner.glabCalls, readdirSync(saves)]).toEqual([['main', SAVE], [], []])
  })

  it('the fetch fails, as when the save branch is not on the remote yet: nothing is made', async () => {
    git(bare, 'update-ref', '-d', `refs/heads/${SAVE}`)
    const saved = await saverOf().accept(proposal('Two.\n'), 1)
    expect(saved).toMatchObject({ saved: false })
    expect((saved as { reason: string }).reason).toMatch(/^Not saved: the fetch step failed: /)
    expect([readdirSync(saves), runner.glabCalls, branchesOf()]).toEqual([[], [], ['main']])
  })

  it('the remote cannot be reached: the guard cannot tell its default branch, so nothing is saved', async () => {
    git(factory, 'remote', 'set-url', 'origin', join(root, 'missing.git'))
    expect(await saverOf().accept(proposal('Two.\n'), 1)).toEqual({ saved: false, reason: `Not saved: ${TrialBranchGuard.NO_DEFAULT}`, mr: undefined })
    expect([readdirSync(saves), runner.glabCalls, runner.calls.map(call => call.args[0])]).toEqual([[], [], ['rev-parse', 'ls-remote']])
  })

  it('without glab, without a save branch, or while another save runs, it refuses before any git call', async () => {
    expect(await saverOf(records(), null).accept(proposal('Two.\n'), 1)).toEqual({ saved: false, reason: `Not saved: ${FactoryRepoSave.NO_GLAB}`, mr: undefined })
    expect(await saverOf(records(null)).accept(proposal('Two.\n'), 1)).toEqual({ saved: false, reason: 'Not saved: no save branch is set (review.saveBranch)', mr: undefined })
    expect(runner.calls).toEqual([])
    const repo = new FactoryRepoSave({ glab: GLAB, root: saves })
    const remote = new FactoryRemote({ repo: factory, runner, branch: SAVE })
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
    const remote = new FactoryRemote({ repo: factory, runner, branch: SAVE })
    const change = (files: { path: string; text: string }[], branch = 'zees-factory/x') => () => ({ branch, title: 't', message: 'm', description: 'd', files })
    expect(await repo.save(remote, change([{ path: 'guideline/v1.md', text: 'edited\n' }]))).toEqual({ saved: false, step: 'write', error: 'guideline/v1.md exists already and is never written over', mr: undefined })
    for (const path of ['README.md', 'guideline/../README.md', '/guideline/v9.md', 'guideline/'])
      expect(await repo.save(remote, change([{ path, text: 'x\n' }]))).toMatchObject({ saved: false, step: 'write' })
    expect(await repo.save(remote, change([{ path: 'guideline/v9.md', text: 'x\n' }], '-x'))).toMatchObject({ saved: false, step: 'start' })
    // The new branch is never pushed onto the save branch itself.
    expect(await repo.save(remote, change([{ path: 'guideline/v9.md', text: 'x\n' }], SAVE)))
      .toEqual({ saved: false, step: 'start', error: 'the new branch is the branch it would be merged into', mr: undefined })
    expect([fileOnTip('guideline/v1.md'), branchesOf(), readdirSync(saves), runner.glabCalls]).toEqual([V1.trimEnd(), ['main', SAVE], [], []])
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
  /** The files the newest commit on the save branch changed. */
  const lastCommitFiles = () => git(bare, 'show', '--name-only', '--format=', SAVE).split('\n').filter(Boolean).sort()
  beforeEach(() => { sampleJobs(); author = new Author() })

  it('the ticket\'s check: accepting v2 leaves v1\'s report in the same commit; the button writes v2\'s report naming v1; the page shows each beside its version', async () => {
    const of = records()
    const saver = reportingSaver(of)
    const before = tipOf()
    expect(await saver.accept(proposal('# Guideline\nKeep to the minimum feature.\n'), 1)).toMatchObject({ saved: true, version: 2 })
    // One commit, one merge request: the new version and the report of the version it replaced.
    expect([git(bare, 'rev-list', '--count', `${before}..${SAVE}`), lastCommitFiles(), runner.glabCalls.length]).toEqual(['1', ['guideline/v1-trends.md', 'guideline/v2.md'], 2])
    expect(fileOnTip('guideline/v1-trends.md')).toBe('---\nversion: 1\ndate: 2026-11-27\njobs: 2\nwritten: accepted\n---\n# Trend report for guideline v1\n\n'
      + 'This is the first version; there is none before it.\n\nReport on 2 jobs. The owner said: Keep to the minimum feature.\n\nSpent: 1,200 tokens\nProviders: dsh (the model set in its factory profile)')
    expect(author.asked.map(input => [input.version.version, input.before, input.jobs.map(job => job.job_id)])).toEqual([[1, null, ['job-a', 'job-b']]])
    // The button on the current version, v2: its own branch, merge request and merge.
    const merged = tipOf()
    expect(await saver.report(2)).toEqual({ saved: true, version: 2, mr: 'https://gitlab.example/factory/-/merge_requests/7' })
    expect([git(bare, 'rev-list', '--count', `${merged}..${SAVE}`), lastCommitFiles()]).toEqual(['1', ['guideline/v2-trends.md']])
    const v2 = fileOnTip('guideline/v2-trends.md')
    expect(v2).toMatch(/^---\nversion: 2\ndate: 2026-11-27\njobs: 1\ncompared_with: 1\nwritten: asked\n---\n# Trend report for guideline v2\n\nCompared with v1\.\n/)
    const branch = 'zees-factory/trends-v2-20261127T101530Z'
    expect(runner.glabCalls.slice(2)).toEqual([
      ['mr', 'create', '--source-branch', branch, '--target-branch', SAVE, '--title', 'trend report for guideline v2',
        '--description', 'The trend report for guideline v2. Asked for by the owner on the review page and merged by the fork.', '--remove-source-branch=false', '--yes'],
      ['mr', 'merge', '7', '--yes', '--auto-merge=false', '--sha', tipOf()],
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
    git(factory, 'push', '--quiet', 'origin', `HEAD:refs/heads/${SAVE}`)
    expect(await reportingSaver().accept(proposal('One.\n'), null)).toMatchObject({ saved: true, version: 1 })
    expect([lastCommitFiles(), author.asked]).toEqual([['guideline/v1.md'], []])
  })

  it('a report that cannot be written stops the Accept: nothing pushed, no merge request, the reason said', async () => {
    author.fail = 'the report thread did not answer in time'
    const before = tipOf()
    expect(await reportingSaver().accept(proposal('Two.\n'), 1))
      .toEqual({ saved: false, reason: 'Not saved: the trend report for v1 could not be written: the report thread did not answer in time. Nothing was saved; try Accept again later.', mr: undefined })
    expect([tipOf(), branchesOf(), runner.glabCalls, readdirSync(saves)]).toEqual([before, ['main', SAVE], [], []])
  })

  it('an Accept against a version that moved on asks no thread', async () => {
    expect(await reportingSaver().accept(proposal('Two.\n'), 7)).toMatchObject({ saved: false, reason: expect.stringContaining('the guideline is at v1 now') })
    expect([author.asked, runner.glabCalls]).toEqual([[], []])
  })

  it('asking again replaces the report in a new commit; an old version, or no version, is refused before any thread is asked', async () => {
    const saver = reportingSaver()
    expect(await saver.report(1)).toMatchObject({ saved: true, version: 1 })
    const first = fileOnTip('guideline/v1-trends.md')
    author = new Author()
    sampleJobs('Ask me before any push.')
    const again = reportingSaver()
    expect(await again.report(1)).toMatchObject({ saved: true, version: 1 })
    expect([lastCommitFiles(), fileOnTip('guideline/v1-trends.md') === first, fileOnTip('guideline/v1-trends.md')]).toEqual([['guideline/v1-trends.md'], false, expect.stringContaining('Ask me before any push.')])
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
    expect(fileOnTip('guideline/v1-trends.md')).toMatch(/^---\nversion: 1\ndate: 2026-11-27\njobs: 0\nwritten: asked\n---\n/)
    expect(TrendPrompt.textOf(author.asked[0]!)).toContain('No job ran under this version.')
  })

  it('stores a planted secret from a comment masked, with every listed project\'s mask', async () => {
    sampleJobs(`Never print ${PLANTED}.`)
    expect(await reportingSaver().report(1)).toMatchObject({ saved: true })
    const report = fileOnTip('guideline/v1-trends.md')
    expect([report.includes(PLANTED), report.includes(`Never print ${REDACTED}.`)]).toEqual([false, true])
  })

  it('a failed step of the button\'s save names the step and links the merge request; the worktree is removed', async () => {
    runner.fail.merge = 'ERROR: not mergeable yet'
    const before = tipOf()
    expect(await reportingSaver().report(1)).toEqual({ saved: false, reason: 'Not saved: the merge step failed: ERROR: not mergeable yet', mr: 'https://gitlab.example/factory/-/merge_requests/7' })
    expect([tipOf(), readdirSync(saves), branchesOf()]).toEqual([before, [], ['main', 'zees-factory/trends-v1-20261127T101530Z', SAVE]])
  })

  it('is busy while a report is written, so an Accept and a report never run at once', async () => {
    const saver = reportingSaver()
    const writing = saver.report(1)
    expect([saver.busy, await saver.accept(proposal('Two.\n'), 1)]).toEqual([true, { saved: false, reason: `Not saved: ${FactoryRepoSave.BUSY}`, mr: undefined }])
    expect(await writing).toMatchObject({ saved: true })
  })

  it('a fetch that fails stops the Accept and the button before any thread is asked', async () => {
    // The save branch is not on the remote: the guard can still ask the remote, and the fetch fails.
    git(bare, 'update-ref', '-d', `refs/heads/${SAVE}`)
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
      'maskText: text => project.endsWith(\'/second\') ? clean(text).replaceAll(\'second-only-secret\', \'[second-masked]\') : clean(text),')), { runner, saveBranch: SAVE })
    const saver = new GuidelineSaver({ records: of, repo: new FactoryRepoSave({ glab: GLAB, root: saves }), now: () => NOW,
      reports: new TrendReports({ author, records: of, projects: [project, second] }) })
    expect(await saver.report(1)).toMatchObject({ saved: true })
    const report = fileOnTip('guideline/v1-trends.md')
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

describe('the save branch (review.saveBranch): saves go only to that branch of the factory\'s remote, and the guideline is read from it while it is set', () => {
  /** A stand-in author that asks no model and writes down what it was given. */
  class Author implements TrendAuthor {
    readonly asked: TrendInput[] = []
    async write(input: TrendInput): Promise<WrittenTrend> { this.asked.push(input); return { body: TrendWriter.bodyOf(input, 'Report.', 1200), jobs: input.jobs.length } }
  }
  let author = new Author()
  const saverFor = (of: RemoteGuidelineRecords) => new GuidelineSaver({ records: of, repo: new FactoryRepoSave({ glab: GLAB, root: saves }), now: () => NOW,
    reports: new TrendReports({ author, records: of, projects: [] }) })
  const filesOnMain = () => git(bare, 'ls-tree', '--name-only', 'main', 'guideline/').split('\n').filter(Boolean)
  const agent = async (id: string): Promise<GuidelineAgent & { ctx: Context }> => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    return { id, ctx }
  }
  const sectionOf = async (each: { ctx: Context }) => (await each.ctx.systemPrompt.assemble()).sections.find(section => section.name === GuidelineSection.NAME)?.text ?? ''
  beforeEach(() => {
    author = new Author()
    // Another clone moves the two branches apart: the trial branch gets v2, main gets v5. The factory clone fetches both.
    const writer = join(root, 'writer')
    git(root, 'clone', '--quiet', bare, writer)
    for (const [name, value] of [['user.name', 'Other'], ['user.email', 'other@example.invalid'], ['commit.gpgsign', 'false']]) git(writer, 'config', name!, value!)
    git(writer, 'checkout', '--quiet', '-b', 'trial', `origin/${SAVE}`)
    writeFileSync(join(writer, 'guideline', 'v2.md'), '---\nversion: 2\ndate: 2026-11-21\nfrom_job: job-1\nfrom_version: 1\n---\nTrial two.\n')
    git(writer, 'add', 'guideline'); git(writer, 'commit', '--quiet', '-m', 'trial v2'); git(writer, 'push', '--quiet', 'origin', `HEAD:refs/heads/${SAVE}`)
    git(writer, 'checkout', '--quiet', '-b', 'later', 'origin/main')
    writeFileSync(join(writer, 'guideline', 'v5.md'), '---\nversion: 5\ndate: 2026-11-25\nfrom_job: job-5\n---\nMain five.\n')
    git(writer, 'add', 'guideline'); git(writer, 'commit', '--quiet', '-m', 'main v5'); git(writer, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
    git(factory, 'fetch', '--quiet', 'origin')
  })

  it('unset: Accept and the button refuse in plain words before anything runs, and sessions read main', async () => {
    const touched: string[] = []
    const untouched = {
      saveBranch: undefined,
      saveTarget: async () => { touched.push('target'); throw new Error('never asked') },
      maskerFor: async () => { touched.push('mask'); throw new Error('never asked') },
      jobsReader: async () => { touched.push('jobs'); throw new Error('never asked') },
    }
    const saver = new GuidelineSaver({ records: untouched, repo: new FactoryRepoSave({ glab: GLAB, root: saves }), now: () => NOW,
      reports: new TrendReports({ author, records: untouched, projects: ['/projects/factory-testbed'] }) })
    const refused = { saved: false, reason: 'Not saved: no save branch is set (review.saveBranch)', mr: undefined }
    expect(await saver.accept(proposal('Two.\n'), 1)).toEqual(refused)
    expect(await saver.report(1)).toEqual(refused)
    // The same with the real records module.
    const of = records(null)
    expect([of.saveBranch, await saverFor(of).accept(proposal('Two.\n'), 5), await saverFor(of).report(5)]).toEqual([undefined, refused, refused])
    expect([touched, author.asked, runner.calls, readdirSync(saves), git(factory, 'worktree', 'list').split('\n').length]).toEqual([[], [], [], [], 1])
    // Sessions, and the page, read main.
    const sections = new GuidelineSection(of, () => {})
    const first = await agent('session-1')
    await sections.attach(first)
    expect([await sectionOf(first), await sections.jobVersion('session-1')]).toEqual([expect.stringContaining('Main five.'), 'v5'])
    expect((await of.guidelineReader()).read().versions.map(version => version.version)).toEqual([5, 1])
    expect(runner.calls.filter(call => call.program !== 'git' || !['rev-parse', 'ls-tree', 'cat-file'].includes(call.args[0]!))).toEqual([])
  })

  it('set: Accept and the button save onto the trial branch, numbered from it, through merge requests into it; main is unchanged', async () => {
    const main = mainOf()
    const saver = saverFor(records())
    // The page showed the trial branch's v2: v3 is saved, with v2's report, written from the trial branch's v2.
    expect(await saver.accept(proposal('Trial three.\n'), 2)).toMatchObject({ saved: true, version: 3 })
    expect(fileOnTip('guideline/v3.md')).toContain('Trial three.')
    expect(fileOnTip('guideline/v3.md')).toContain('from_version: 2')
    expect(fileOnTip('guideline/v2-trends.md')).toContain('compared_with: 1')
    expect(author.asked.map(input => [input.version.version, input.version.text, input.before?.version])).toEqual([[2, 'Trial two.\n', 1]])
    // The button writes the trial branch's current version's report the same way.
    expect(await saver.report(3)).toMatchObject({ saved: true, version: 3 })
    expect(fileOnTip('guideline/v3-trends.md')).toContain('written: asked')
    expect(filesOnTip()).toEqual(['guideline/v1.md', 'guideline/v2-trends.md', 'guideline/v2.md', 'guideline/v3-trends.md', 'guideline/v3.md'])
    // main never moved.
    expect([mainOf(), filesOnMain()]).toEqual([main, ['guideline/v1.md', 'guideline/v5.md']])
    // Each merge request goes into the trial branch; each push makes a new branch of its own; each fetch brings only the trial branch.
    expect(runner.glabCalls.map(args => [args[1], args[1] === 'create' ? args[args.indexOf('--target-branch') + 1] : undefined]))
      .toEqual([['create', SAVE], ['merge', undefined], ['create', SAVE], ['merge', undefined]])
    const gits = runner.calls.filter(call => call.program === 'git')
    expect(gits.filter(call => call.args[0] === 'push').map(call => call.args.at(-1)!.replace(/^[0-9a-f]{40}:/, '')))
      .toEqual(['refs/heads/zees-factory/guideline-v3-20261127T101530Z', 'refs/heads/zees-factory/trends-v3-20261127T101530Z'])
    expect([...new Set(gits.filter(call => call.args[0] === 'fetch').map(call => call.args.at(-1)))]).toEqual([`+refs/heads/${SAVE}:refs/remotes/origin/${SAVE}`])
    // The worktrees were made from the trial branch's commits, never main's.
    const bases = gits.filter(call => call.args[0] === 'worktree' && call.args[1] === 'add').map(call => call.args.at(-1))
    expect(bases).toHaveLength(2)
    expect(bases).not.toContain(main)
    expect([readdirSync(saves), git(factory, 'branch', '--show-current')]).toEqual([[], 'main'])
  })

  it('the "moved on" check and the numbering read the trial branch: main at v5, trial at v2 gives base 2 and v3', async () => {
    const main = mainOf()
    const saver = saverFor(records())
    // main's current version is no base here: the trial branch is at v2.
    expect((await saver.accept(proposal('Three.\n'), 5) as { reason: string }).reason).toBe('Not saved: the guideline is at v2 now, not the version this proposal was shown against. Reload the page and compare again.')
    expect((await saver.report(5) as { reason: string }).reason).toMatch(/^Not saved: only the current version's trend report can be written, and v5 is not the current version now \(v2 is\)/)
    expect(author.asked).toEqual([])
    // Against the trial branch's v2 it saves v3, not v6.
    expect(await saver.accept(proposal('Three.\n'), 2)).toMatchObject({ saved: true, version: 3 })
    expect([mainOf(), filesOnMain(), filesOnTip().filter(path => GuidelineFile.NAME.test(path.slice('guideline/'.length)))])
      .toEqual([main, ['guideline/v1.md', 'guideline/v5.md'], ['guideline/v1.md', 'guideline/v2.md', 'guideline/v3.md']])
  })

  it('a session started after an Accept gets the new version from the trial branch; main\'s guideline is not read', async () => {
    const of = records()
    const sections = new GuidelineSection(of, () => {})
    const first = await agent('session-1')
    await sections.attach(first)
    expect([await sectionOf(first), await sections.jobVersion('session-1')]).toEqual([expect.stringContaining('Trial two.'), 'v2'])
    expect(await sectionOf(first)).not.toContain('Main five.')
    // The review page's versions come from the trial branch too.
    expect((await of.guidelineReader()).read().versions.map(version => version.version)).toEqual([2, 1])
    expect(await saverFor(of).accept(proposal('Trial three.\n'), 2)).toMatchObject({ saved: true, version: 3 })
    const next = await agent('session-2')
    await sections.attach(next)
    expect(await sectionOf(next)).toContain('Trial three.')
    expect([await sections.jobVersion('session-2'), await sections.jobVersion('session-1')]).toEqual(['v3', 'v2'])
    // The save's last fetch brought the merge into the clone's copy of the trial branch; its copy of main and its checkout are unchanged.
    expect([git(factory, 'rev-parse', `refs/remotes/origin/${SAVE}`), git(factory, 'rev-parse', 'refs/remotes/origin/main'), readdirSync(join(factory, 'guideline'))])
      .toEqual([tipOf(), mainOf(), ['v1.md']])
  })

  it('until Epic 3 moves to main, the guard refuses main and the remote\'s default branch before any fetch, worktree or glab call', async () => {
    const before = { main: mainOf(), trial: tipOf(), branches: branchesOf() }
    const refused = { saved: false, reason: `Not saved: ${TrialBranchGuard.IS_MAIN}`, mr: undefined }
    expect(refused.reason).toBe('Not saved: the save branch (review.saveBranch) is main or the remote\'s default branch; until Epic 3 moves to main, saves go only to a trial branch')
    // main itself: refused by name, before any git call.
    const onMain = records('main')
    expect([await saverFor(onMain).accept(proposal('Six.\n'), 5), await saverFor(onMain).report(5)]).toEqual([refused, refused])
    // Only the check that the factory folder is a repository ran.
    expect(runner.calls.map(call => call.args.join(' '))).toEqual(['rev-parse --git-dir'])
    runner.calls.length = 0
    // Other spellings of main are refused by name too.
    for (const name of ['Main', 'MAIN', 'master', 'origin/main'])
      expect(await saverFor(records(name)).accept(proposal('Six.\n'), 5)).toEqual(refused)
    expect(runner.calls.filter(call => call.args[0] !== 'rev-parse')).toEqual([])
    runner.calls.length = 0
    // A branch the remote names as its default (its HEAD) is refused too; only the remote was asked which branch that is.
    git(bare, 'symbolic-ref', 'HEAD', `refs/heads/${SAVE}`)
    const onDefault = records()
    expect([await saverFor(onDefault).accept(proposal('Three.\n'), 2), await saverFor(onDefault).report(2)]).toEqual([refused, refused])
    expect(runner.calls.filter(call => call.args[0] !== 'rev-parse').map(call => call.args.slice(0, 2))).toEqual([['ls-remote', '--symref'], ['ls-remote', '--symref']])
    expect([{ main: mainOf(), trial: tipOf(), branches: branchesOf() }, runner.glabCalls, readdirSync(saves), author.asked]).toEqual([before, [], [], []])
  })

  it('a save branch that is not a plain branch name is refused when the records are made, so it never reaches git', () => {
    for (const name of [SAVE, 'main', 'epic-3/guideline_trial.2'])
      expect([name, SaveBranchName.isPlain(name)]).toEqual([name, true])
    for (const name of ['', 'HEAD', 'refs/heads/main', 'heads/main', 'remotes/origin/main', 'tags/v1', 'zees-factory', 'zees-factory/x', '-x', 'a..b', 'a//b', 'a/.b', '.a', 'a/', 'a.', 'a.lock', 'a.lock/b', 'x:refs/heads/main', '+main', 'a b', 'a@{1}', 'a~1', 'a^', 'a*', 'a\\b']) {
      expect([name, SaveBranchName.isPlain(name)]).toEqual([name, false])
      expect(() => records(name)).toThrow(RemoteGuidelineRecords.NOT_PLAIN)
    }
    expect(runner.calls).toEqual([])
  })
})

describe('reading the guideline from the remote\'s main, or its save branch while one is set', () => {
  it('reads the versions the remote\'s branch held at the last fetch, never the checkout, and says why when there is no copy of it', async () => {
    // The checkout holds a v2 that is not on the remote: it is not read.
    writeFileSync(join(factory, 'guideline', 'v2.md'), 'checkout only\n')
    const reader: GuidelineSource = await records(null).guidelineReader()
    const read = reader.read()
    expect([read.current?.version, read.versions.map(version => version.version), read.current?.from_job, read.current?.text]).toEqual([1, [1], 'job-0', '# Guideline\nKeep it small.\n'])
    // A repository with no copy of the remote's main.
    git(factory, 'update-ref', '-d', 'refs/remotes/origin/main')
    const none = (await records(null).guidelineReader()).read()
    expect([none.current, none.reason]).toEqual([null, 'The guideline could not be read: the factory repository has no origin/main yet'])
    // With a save branch set, its copy is read, not main's; with none, it says so in the same words.
    expect((await records().guidelineReader()).read().current?.version).toBe(1)
    git(factory, 'update-ref', '-d', `refs/remotes/origin/${SAVE}`)
    expect((await records().guidelineReader()).read().reason).toBe(`The guideline could not be read: the factory repository has no origin/${SAVE} yet`)
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
  it('reads a saved version as the fork reads it from the remote\'s save branch', async () => {
    expect((await saverOf().accept(proposal('# Guideline\nKeep to the minimum feature.\n'), 1)).saved).toBe(true)
    git(factory, 'pull', '--quiet', '--ff-only', 'origin', SAVE)
    const lib = await import(pathToFileURL(join(FACTORY, 'lib', 'dist', 'jobLog.js')).href) as { GuidelineReader: new (options: { factoryDir: string }) => GuidelineSource }
    const real = new lib.GuidelineReader({ factoryDir: factory }).read()
    const fork = (await records().guidelineReader()).read()
    expect(fork.versions).toEqual(real.versions)
    expect(real.current).toEqual({ version: 2, date: '2026-11-27', from_job: 'job-a1', from_version: 1, text: '# Guideline\nKeep to the minimum feature.\n' })
  })
})
