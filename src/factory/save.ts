/**
 * The owner's decision guideline in the factory repository: read from the remote's `main`, and a new version saved there when the owner accepts a
 * review talk's proposal (architecture AD-18).
 *
 * Reading never uses a checkout, because a checkout may be another session's working folder: the fork reads `guideline/` from the factory
 * repository's copy of the remote's `main` (`refs/remotes/origin/main`), which a fetch keeps up to date. The fork fetches once when it starts, and the
 * save fetches before and after it, so the next session after an Accept starts with the new version.
 *
 * Saving takes the save path the owner chose (owner, 2026-11-26: "all changes will pushed to an PR and then merge to main"; "Fork merges it"):
 *   1. fetch the remote's `main`;
 *   2. add a new worktree of the factory repository, detached at that `main`, in a folder of the fork's own (never a checkout, never a session's folder);
 *   3. write the files there;
 *   4. commit them, with the owner's own git identity, signing and hooks;
 *   5. push the commit to a new branch;
 *   6. open a merge request into `main` with `glab`;
 *   7. merge it at once, only that commit, deleting no branch;
 *   8. remove the worktree.
 * When a step fails the save stops there and says which step failed; nothing done before is undone, so a merge request that was opened stays open.
 * The worktree is removed in every case. git and glab run only through the runner they are given; tests give one that reaches no real remote.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, accessSync, constants, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { FactoryRecordsModule, RecordsRefusal, type GuidelineRead, type GuidelineSource, type GuidelineVersion, type RecordsMasker } from './records.ts'
import { TalkTexts, type GuidelineProposal, type OrcaRun, type OrcaRunner } from './talk.ts'

/** One version file of the guideline, `guideline/v<N>.md`: its name, its text, and how it is read back. */
export class GuidelineFile {
  static readonly FOLDER = 'guideline'
  /** A version's file name. The same rule as the factory's own `GuidelineReader` (`lib/guideline.script.ts`). */
  static readonly NAME = /^v(\d+)\.md$/
  static nameOf(version: number): string { return `v${version}.md` }
  /** The file's path inside the repository, as git names it. */
  static pathOf(version: number): string { return posix.join(GuidelineFile.FOLDER, GuidelineFile.nameOf(version)) }

  /** A version file: front matter `version`, `date`, `from_job` and, when there was a version before it, `from_version`; then the text. */
  static textOf(meta: { version: number; date: string; from_job: string; from_version: number | null }, text: string): string {
    const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()
    const front = ['---', `version: ${meta.version}`, `date: ${oneLine(meta.date)}`, `from_job: ${oneLine(meta.from_job)}`,
      ...(meta.from_version === null ? [] : [`from_version: ${meta.from_version}`]), '---']
    return `${front.join('\n')}\n${text}${text.endsWith('\n') ? '' : '\n'}`
  }

  /**
   * One version from a file named `name` with the text `file`, or `null` for a name that is not a version's. The same reading as the factory's own
   * `GuidelineReader.parse`: the fields of the front matter between two `---` lines, then the text after it as written.
   */
  static parse(name: string, file: string): GuidelineVersion | null {
    const match = GuidelineFile.NAME.exec(name)
    if (match === null) return null
    const version = Number(match[1])
    const lines = file.split('\n')
    const isFence = (line: string) => line.replace(/\r$/, '') === '---'
    const closing = isFence(lines[0] ?? '') ? lines.findIndex((line, index) => index > 0 && isFence(line)) : -1
    if (closing < 0) return { version, date: null, from_job: null, from_version: null, text: file }
    const fields = new Map<string, string>()
    for (const line of lines.slice(1, closing)) {
      const found = /^([^:\s]+):(.*)$/.exec(line.replace(/\r$/, ''))
      const value = found?.[2]!.trim()
      if (found && value !== '') fields.set(found[1]!, value!)
    }
    const fromVersion = fields.get('from_version')
    return {
      version, date: fields.get('date') ?? null, from_job: fields.get('from_job') ?? null,
      from_version: fromVersion !== undefined && /^\d+$/.test(fromVersion) ? Number(fromVersion) : null,
      text: lines.slice(closing + 1).join('\n'),
    }
  }
}

/** The factory repository and its remote's `main`, which the fork reads the guideline from and saves it to. */
export class FactoryRemote {
  static readonly LOCAL_MS = 15_000
  static readonly NETWORK_MS = 60_000
  static readonly NO_VERSION = 'No guideline yet. The first review talk writes version 1.'
  readonly repo: string
  readonly remote: string
  readonly branch: string
  readonly runner: OrcaRunner
  private cached: { commit: string; read: GuidelineRead } | undefined
  private repository: true | undefined
  constructor(options: { repo: string; runner: OrcaRunner; remote?: string; branch?: string }) {
    this.repo = resolve(options.repo)
    this.runner = options.runner
    this.remote = options.remote ?? 'origin'
    this.branch = options.branch ?? 'main'
  }
  /** The factory repository's copy of the remote's branch. */
  get tracking(): string { return `refs/remotes/${this.remote}/${this.branch}` }

  /**
   * Runs git in `cwd` (the repository by default). No git setting of DSH's own environment reaches it, and git never waits for a password typed in.
   * git never looks above `cwd` for a repository (`GIT_CEILING_DIRECTORIES`), so a folder that is not one is never taken for a repository around it.
   * The owner's own git config applies: their identity, signing and hooks.
   */
  git(args: readonly string[], timeoutMs: number = FactoryRemote.LOCAL_MS, cwd: string = this.repo): Promise<OrcaRun> {
    return this.runner.run('git', args, timeoutMs, { cwd, env: { ...FactoryRemote.envFor(cwd) } })
  }
  /** The variables git and glab run with: every `GIT_*` of DSH's own environment removed, no password prompt, no search above `cwd`. */
  static envFor(cwd: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).filter(name => name.startsWith('GIT_')).map(name => [name, undefined]))
    return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) }
  }

  /** Whether the factory's folder is a git repository of its own. A yes is kept; a no is asked again next time, so one failed call does not stick. */
  async isRepository(): Promise<boolean> {
    if (this.repository !== undefined) return this.repository
    const known = (await this.git(['rev-parse', '--git-dir'])).ok
    if (known) this.repository = true
    return known
  }

  /** Brings the repository's copy of the remote's branch up to date. Nothing else changes: no checkout, no branch, no tag. */
  fetch(): Promise<OrcaRun> {
    return this.git(['fetch', '--no-tags', '--', this.remote, `+refs/heads/${this.branch}:${this.tracking}`], FactoryRemote.NETWORK_MS)
  }

  /** The commit the copy of the remote's branch is at, or `undefined` when there is none. */
  async head(): Promise<string | undefined> {
    const head = await this.git(['rev-parse', '--verify', '--quiet', `${this.tracking}^{commit}`])
    return head.ok ? head.stdout.trim() : undefined
  }

  /**
   * The guideline's versions as the remote's branch held them at the last fetch, newest first. It never throws and uses no network. With no copy
   * of the remote's branch it gives no version and says why. A commit read once is kept, so an unchanged branch costs one git call.
   * `at` reads one given commit instead.
   */
  async read(at?: string): Promise<GuidelineRead> {
    const folder = join(this.repo, GuidelineFile.FOLDER)
    const commit = at ?? await this.head()
    if (commit === undefined) return { folder, versions: [], current: null, reason: `The guideline could not be read: the factory repository has no ${this.remote}/${this.branch} yet` }
    if (this.cached?.commit === commit) return this.cached.read
    const listed = await this.git(['ls-tree', '-z', commit, '--', `${GuidelineFile.FOLDER}/`])
    if (!listed.ok) return { folder, versions: [], current: null, reason: `The guideline could not be read from ${this.remote}/${this.branch}` }
    const versions: GuidelineVersion[] = []
    let complete = true
    for (const entry of listed.stdout.split('\0')) {
      // `<mode> <type> <object>\t<path>`
      const found = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry)
      if (found === null) continue
      const name = posix.basename(found[2]!)
      if (!GuidelineFile.NAME.test(name)) continue
      const blob = await this.git(['cat-file', 'blob', found[1]!])
      // A file that cannot be read is left out; the others still show.
      if (!blob.ok) complete = false
      const version = blob.ok ? GuidelineFile.parse(name, blob.stdout) : null
      if (version !== null) versions.push(version)
    }
    versions.sort((left, right) => right.version - left.version)
    const read: GuidelineRead = { folder, versions, current: versions[0] ?? null, reason: versions.length === 0 ? FactoryRemote.NO_VERSION : null }
    // A read that missed a file is not kept, so the next read tries again.
    if (complete) this.cached = { commit, read }
    return read
  }
}

/**
 * The factory's records module, but with the decision guideline read from the factory repository's remote `main` instead of a checkout.
 * The factory's own guideline reader is still asked first, only to find the repository (its `folder` is `<repository>/guideline`); with no repository
 * found, its answer and reason are kept. A factory folder that is not a git repository at all is no checkout of the factory repository and has no
 * remote: its own `guideline/` folder is read, as the factory's reader reads it (design default).
 */
export class RemoteGuidelineRecords extends FactoryRecordsModule {
  private readonly runner: OrcaRunner
  private readonly remoteName: string | undefined
  private readonly branch: string | undefined
  private readonly remotes = new Map<string, FactoryRemote>()
  constructor(path: string | undefined, options: { runner: OrcaRunner; remote?: string; branch?: string }) {
    super(path)
    this.runner = options.runner
    this.remoteName = options.remote
    this.branch = options.branch
  }
  /** The factory repository's remote. Rejects with `RecordsRefusal(503)` when the repository was not found. */
  async factoryRemote(): Promise<FactoryRemote> {
    const local = (await super.guidelineReader()).read()
    if (local.folder === null) throw new RecordsRefusal(503, local.reason ?? 'The factory repository was not found')
    const repo = dirname(resolve(local.folder))
    let remote = this.remotes.get(repo)
    if (remote === undefined) {
      remote = new FactoryRemote({ repo, runner: this.runner, ...(this.remoteName === undefined ? {} : { remote: this.remoteName }), ...(this.branch === undefined ? {} : { branch: this.branch }) })
      this.remotes.set(repo, remote)
    }
    return remote
  }
  override async guidelineReader(): Promise<GuidelineSource> {
    const local = (await super.guidelineReader()).read()
    if (local.folder === null) return { read: () => local }
    const remote = await this.factoryRemote()
    if (!await remote.isRepository()) return { read: () => local }
    const read = await remote.read()
    return { read: () => read }
  }
}

/** One file a save writes, at a path inside the repository's `guideline/` folder. A file is created, never written over, unless `replace` says so. */
export interface SaveFile { path: string; text: string; replace?: boolean }
/** What a save writes and what it calls it. `branch` is the new branch's name on the remote. */
export interface RepoChange { branch: string; title: string; message: string; description: string; files: SaveFile[] }
/** The step a save stopped at. */
export type SaveStep = 'start' | 'fetch' | 'read' | 'worktree' | 'write' | 'commit' | 'push' | 'merge request' | 'merge'
/** How a save ended. `mr` is the merge request's address, when one was opened and its address was given. */
export type SaveOutcome = { saved: true; commit: string; branch: string; mr: string | undefined } | { saved: false; step: SaveStep; error: string; mr: string | undefined }

/** The save path of AD-18, for any files in the guideline folder: a guideline version now, a trend report later. One save runs at a time. */
export class FactoryRepoSave {
  static readonly NO_GLAB = 'glab, GitLab\'s command-line tool, was not found'
  static readonly BUSY = 'another save is running'
  /** The `glab` program, or `undefined` when none was found. */
  readonly glab: string | undefined
  private readonly root: string
  private running = false
  constructor(options: { glab: string | undefined; root?: string }) {
    this.glab = options.glab
    this.root = resolve(options.root ?? tmpdir())
  }
  get busy(): boolean { return this.running }

  /**
   * Saves what `prepare` asks for in `remote`'s repository. `prepare` is given the guideline as the remote's branch holds it right after the fetch,
   * so it can number a new version; it may throw a `RecordsRefusal`, which stops the save at the write step with its message.
   */
  async save(remote: FactoryRemote, prepare: (read: GuidelineRead) => RepoChange): Promise<SaveOutcome> {
    if (this.running) return FactoryRepoSave.failed('start', FactoryRepoSave.BUSY)
    if (this.glab === undefined) return FactoryRepoSave.failed('start', FactoryRepoSave.NO_GLAB)
    this.running = true
    try { return await this.run(remote, prepare, this.glab) } finally { this.running = false }
  }

  private async run(remote: FactoryRemote, prepare: (read: GuidelineRead) => RepoChange, glab: string): Promise<SaveOutcome> {
    const fetched = await remote.fetch()
    if (!fetched.ok) return FactoryRepoSave.failed('fetch', fetched.error)
    const commitOf = await remote.head()
    if (commitOf === undefined) return FactoryRepoSave.failed('read', `the factory repository has no ${remote.remote}/${remote.branch}`)
    let change: RepoChange
    try { change = prepare(await remote.read(commitOf)) } catch (error) {
      return FactoryRepoSave.failed('write', error instanceof RecordsRefusal ? error.message : 'the files could not be made')
    }
    const paths = change.files.map(file => file.path)
    const outside = paths.find(path => !FactoryRepoSave.inFolder(path))
    if (outside !== undefined || paths.length === 0) return FactoryRepoSave.failed('write', 'a save writes only files in the guideline folder')
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(change.branch) || change.branch.includes('..')) return FactoryRepoSave.failed('start', 'the branch name is not plain')
    let worktree: string | undefined
    try {
      try { worktree = mkdtempSync(join(this.root, 'zees-factory-save-')) } catch { return FactoryRepoSave.failed('worktree', 'the temporary folder for the worktree could not be made') }
      const added = await remote.git(['worktree', 'add', '--detach', '--', worktree, commitOf])
      if (!added.ok) { rmSync(worktree, { recursive: true, force: true }); worktree = undefined; return FactoryRepoSave.failed('worktree', added.error) }
      for (const file of change.files) {
        const path = join(worktree, ...file.path.split('/'))
        try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.text, { encoding: 'utf8', flag: file.replace === true ? 'w' : 'wx' }) } catch (error) {
          return FactoryRepoSave.failed('write', (error as NodeJS.ErrnoException).code === 'EEXIST' ? `${file.path} exists already and is never written over` : `${file.path} could not be written`)
        }
      }
      const staged = await remote.git(['add', '--', ...paths], FactoryRemote.LOCAL_MS, worktree)
      if (!staged.ok) return FactoryRepoSave.failed('commit', staged.error)
      // The owner's hooks and signing may take a while (a key to touch), so the commit gets the longer limit.
      const committed = await remote.git(['commit', '-m', change.message, '--', ...paths], FactoryRemote.NETWORK_MS, worktree)
      if (!committed.ok) return FactoryRepoSave.failed('commit', committed.error)
      const head = await remote.git(['rev-parse', '--verify', 'HEAD^{commit}'], FactoryRemote.LOCAL_MS, worktree)
      if (!head.ok) return FactoryRepoSave.failed('commit', head.error)
      const commit = head.stdout.trim()
      const pushed = await remote.git(['push', '--', remote.remote, `${commit}:refs/heads/${change.branch}`], FactoryRemote.NETWORK_MS, worktree)
      if (!pushed.ok) return FactoryRepoSave.failed('push', pushed.error)
      const glabEnv = FactoryRemote.envFor(worktree)
      const opened = await remote.runner.run(glab, ['mr', 'create', '--source-branch', change.branch, '--target-branch', remote.branch, '--title', change.title,
        '--description', change.description, '--remove-source-branch=false', '--yes'], FactoryRemote.NETWORK_MS, { cwd: worktree, env: glabEnv })
      if (!opened.ok) return FactoryRepoSave.failed('merge request', opened.error)
      const { mr, id } = FactoryRepoSave.requestOf(opened.stdout)
      const merged = await remote.runner.run(glab, ['mr', 'merge', id ?? change.branch, '--yes', '--auto-merge=false', '--sha', commit], FactoryRemote.NETWORK_MS,
        { cwd: worktree, env: glabEnv })
      if (!merged.ok) return FactoryRepoSave.failed('merge', merged.error, mr)
      // So the next read sees the merged version; when it fails, the next fetch brings it.
      await remote.fetch()
      return { saved: true, commit, branch: change.branch, mr }
    } finally {
      if (worktree !== undefined) await FactoryRepoSave.remove(remote, worktree)
    }
  }

  /** The merge request's address and number from what `glab mr create` printed: its last `…/-/merge_requests/<n>` address. */
  static requestOf(output: string): { mr: string | undefined; id: string | undefined } {
    const found = [...output.matchAll(/https:\/\/[^\s"'<>]+\/-\/merge_requests\/(\d+)/g)].at(-1)
    return found === undefined ? { mr: undefined, id: undefined } : { mr: found[0], id: found[1] }
  }

  /** Removes the save's worktree, and its folder whatever git says, so no worktree of the fork's is left behind. */
  private static async remove(remote: FactoryRemote, worktree: string): Promise<void> {
    const removed = await remote.git(['worktree', 'remove', '--force', '--', worktree])
    if (!removed.ok) {
      rmSync(worktree, { recursive: true, force: true })
      await remote.git(['worktree', 'prune'])
    }
  }

  private static inFolder(path: string): boolean {
    const parts = path.split('/')
    return parts.length >= 2 && parts[0] === GuidelineFile.FOLDER && parts.every(part => part !== '' && part !== '.' && part !== '..') && !path.includes('\\')
  }

  /** A failed step, with the first line of what failed; an address's user name and password are left out. */
  private static failed(step: SaveStep, error: string, mr?: string): SaveOutcome {
    const first = (error.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? 'it failed').replace(/\/\/[^/\s@]+@/g, '//')
    return { saved: false, step, error: first, mr }
  }
}

/** How the owner's Accept ended: the version saved, or why not, in plain words. */
export type GuidelineSaved = { saved: true; version: number; mr: string | undefined } | { saved: false; reason: string; mr: string | undefined }

/** The owner's Accept: the proposal as the next guideline version, masked, saved through `FactoryRepoSave`. */
export class GuidelineSaver {
  static readonly NOT_SAVED = 'Not saved: '
  private readonly records: Pick<RemoteGuidelineRecords, 'factoryRemote' | 'maskerFor'>
  private readonly repo: FactoryRepoSave
  private readonly now: () => Date
  constructor(options: { records: Pick<RemoteGuidelineRecords, 'factoryRemote' | 'maskerFor'>; repo: FactoryRepoSave; now?: () => Date }) {
    this.records = options.records
    this.repo = options.repo
    this.now = options.now ?? (() => new Date())
  }
  private running = false
  /** Whether an Accept runs, from its first step: two Accepts never both pass the page's check. */
  get busy(): boolean { return this.running || this.repo.busy }

  /**
   * Saves `proposal` as the version after the remote's current one. `base` is the version the owner saw it against (`null`: none): when the
   * remote's main moved on since, nothing is saved, so an Accept never silently undoes a version the owner did not see. It never throws.
   */
  async accept(proposal: GuidelineProposal, base: number | null): Promise<GuidelineSaved> {
    if (this.busy) return { saved: false, reason: `${GuidelineSaver.NOT_SAVED}${FactoryRepoSave.BUSY}`, mr: undefined }
    this.running = true
    try { return await this.save(proposal, base) } catch { return { saved: false, reason: `${GuidelineSaver.NOT_SAVED}the save failed`, mr: undefined } } finally { this.running = false }
  }

  private async save(proposal: GuidelineProposal, base: number | null): Promise<GuidelineSaved> {
    const not = (why: string, mr?: string): GuidelineSaved => ({ saved: false, reason: `${GuidelineSaver.NOT_SAVED}${why}`, mr })
    let mask: (text: string) => string
    let remote: FactoryRemote
    try {
      mask = GuidelineSaver.maskOf(await this.records.maskerFor(proposal.project))
      remote = await this.records.factoryRemote()
    } catch (error) { return not(error instanceof RecordsRefusal ? error.message : 'the factory\'s records module could not be had') }
    const now = this.now()
    let version = 0
    let moved: number | null | undefined
    const outcome = await this.repo.save(remote, read => {
      const before = read.current?.version ?? null
      if (before !== base) { moved = before; throw new RecordsRefusal(409, 'the guideline moved on') }
      version = (before ?? 0) + 1
      const name = mask(TalkTexts.nameOf(proposal.project))
      const title = `guideline v${version}, from the review of ${name} job ${proposal.number}`
      return {
        branch: `zees-factory/guideline-v${version}-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`,
        title,
        message: `${title}\n\nAccepted by the owner on the review page.`,
        description: `Guideline v${version}${before === null ? '' : `, replacing v${before}`}, from the review talk on ${name} job ${proposal.number}. Accepted by the owner on the review page and merged by the fork.`,
        files: [{ path: GuidelineFile.pathOf(version), text: GuidelineFile.textOf({ version, date: GuidelineSaver.dayOf(now), from_job: mask(proposal.job_id), from_version: before }, mask(proposal.text)) }],
      }
    })
    if (outcome.saved) return { saved: true, version, mr: outcome.mr }
    if (moved !== undefined) return not(`the guideline is at ${moved === null ? 'no version' : `v${moved}`} now, not the version this proposal was shown against. Reload the page and compare again.`)
    const step = outcome.step === 'start' ? '' : `the ${outcome.step} step failed: `
    let error = outcome.error
    try { error = mask(error) } catch { error = 'its message could not be masked' }
    return not(`${step}${error}`, outcome.mr)
  }

  /** The day of `when` on this machine's clock, as `YYYY-MM-DD`. */
  static dayOf(when: Date): string {
    return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
  }

  private static maskOf(masker: RecordsMasker): (text: string) => string {
    const maskText = masker.maskText
    if (typeof maskText !== 'function') throw new RecordsRefusal(503, 'the factory\'s built job log file cannot mask a plain text; rebuild it and restart DSH')
    return text => {
      let masked: unknown
      try { masked = maskText.call(masker, text) } catch { throw new RecordsRefusal(503, 'the factory\'s mask failed') }
      if (typeof masked !== 'string') throw new RecordsRefusal(503, 'the factory\'s mask failed')
      return masked
    }
  }
}

/** Finds the `glab` program once, when DSH starts: the profile's `review.glab` setting, then each folder on `PATH`, then Homebrew's folder. */
export class GlabProgram {
  static readonly HOMEBREW = '/opt/homebrew/bin/glab'
  /** Only an absolute path to an executable file counts. A setting that is given is the only place looked at. `undefined` when there is none. */
  static find(setting: string | undefined, path: string | undefined = process.env.PATH): string | undefined {
    if (setting !== undefined && setting !== '') return GlabProgram.runnable(setting) ? setting : undefined
    const onPath = (path ?? '').split(delimiter).filter(folder => isAbsolute(folder)).map(folder => join(folder, 'glab'))
    return [...onPath, GlabProgram.HOMEBREW].find(GlabProgram.runnable)
  }
  private static runnable(file: string): boolean {
    try { return isAbsolute(file) && statSync(file).isFile() && (accessSync(file, constants.X_OK), true) } catch { return false }
  }
}
