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
 *
 * Until Epic 3 moves to main, the repository saved to is not the factory's: it is the save repository the `review.saveRepo` setting names, a clone
 * of a throwaway repository with its own remote (owner, 2026-11-27: "Throwaway repo for now"). Every step above runs there, and the version number
 * and the "main moved on" check come from that repository's `main`. While the setting is set the guideline is read from there too, so an accepted
 * version reaches the next session; the factory's own guideline is not read and not changed. Unset, nothing is saved.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, accessSync, constants, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { FactoryRecordsModule, RecordsRefusal, type GuidelineRead, type GuidelineSource, type GuidelineVersion, type JobsSource, type RecordsMasker, type TrendReport } from './records.ts'
import { TalkTexts, type GuidelineProposal, type OrcaRun, type OrcaRunner } from './talk.ts'
import { TrendPrompt, TrendReportFile, type TrendAuthor } from './trends.ts'

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
  /** How messages name the repository: "the factory repository", or "the save repository" for the `review.saveRepo` one. */
  readonly name: string
  private cached: { commit: string; read: GuidelineRead } | undefined
  private repository: true | undefined
  constructor(options: { repo: string; runner: OrcaRunner; remote?: string; branch?: string; name?: string }) {
    this.repo = resolve(options.repo)
    this.name = options.name ?? 'the factory repository'
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
    if (commit === undefined) return { folder, versions: [], current: null, reason: `The guideline could not be read: ${this.name} has no ${this.remote}/${this.branch} yet` }
    if (this.cached?.commit === commit) return this.cached.read
    const listed = await this.git(['ls-tree', '-z', commit, '--', `${GuidelineFile.FOLDER}/`])
    if (!listed.ok) return { folder, versions: [], current: null, reason: `The guideline could not be read from ${this.remote}/${this.branch}` }
    const versions: GuidelineVersion[] = []
    const reports: TrendReport[] = []
    let complete = true
    for (const entry of listed.stdout.split('\0')) {
      // `<mode> <type> <object>\t<path>`
      const found = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry)
      if (found === null) continue
      const name = posix.basename(found[2]!)
      // A version and its trend report (`v<N>-trends.md`) are the folder's two kinds of file.
      if (!GuidelineFile.NAME.test(name) && !TrendReportFile.NAME.test(name)) continue
      const blob = await this.git(['cat-file', 'blob', found[1]!])
      // A file that cannot be read is left out; the others still show.
      if (!blob.ok) { complete = false; continue }
      const version = GuidelineFile.parse(name, blob.stdout)
      if (version !== null) versions.push(version)
      const report = TrendReportFile.parse(name, blob.stdout)
      if (report !== null) reports.push(report)
    }
    versions.sort((left, right) => right.version - left.version)
    reports.sort((left, right) => right.version - left.version)
    const read: GuidelineRead = { folder, versions, current: versions[0] ?? null, reason: versions.length === 0 ? FactoryRemote.NO_VERSION : null, reports }
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
 *
 * The save repository (`saveRepo`, the `review.saveRepo` setting; owner, 2026-11-27: "Throwaway repo for now") is where Accept and "Write trend
 * report" save. One setting decides both sides: while it is set, the guideline is also read from that repository's remote `main`, never from the
 * factory, so the sessions, the review page, the trend report's input and the start-up fetch all see what was saved. While it is unset, the guideline
 * is read from the factory as before and nothing can be saved.
 */
export class RemoteGuidelineRecords extends FactoryRecordsModule {
  static readonly NOT_A_REPOSITORY = 'the save repository (review.saveRepo) is not a git repository'
  static readonly IS_FACTORY = 'the save repository (review.saveRepo) is the factory repository or shares a remote with it; until Epic 3 moves to main, saves go only to a throwaway repository'
  private readonly runner: OrcaRunner
  private readonly remoteName: string | undefined
  private readonly branch: string | undefined
  private readonly remotes = new Map<string, FactoryRemote>()
  private readonly target: FactoryRemote | undefined
  constructor(path: string | undefined, options: { runner: OrcaRunner; remote?: string; branch?: string; saveRepo?: string | undefined }) {
    super(path)
    this.runner = options.runner
    this.remoteName = options.remote
    this.branch = options.branch
    this.target = options.saveRepo === undefined ? undefined : this.remoteOf(options.saveRepo, 'the save repository')
  }
  /** The save repository's remote, or `undefined` while no save repository is set; then nothing is saved. */
  saveRemote(): FactoryRemote | undefined { return this.target }
  /**
   * The save repository's remote for a save, checked: rejects with `RecordsRefusal(503)` while none is set, and while it is the factory repository
   * or shares a remote address with it (a worktree of the factory, a clone with the factory as a remote), so no save reaches the factory until
   * Epic 3 moves to main. This check goes when the setting is meant to point at the factory.
   */
  async saveTarget(): Promise<FactoryRemote> {
    const target = this.target
    if (target === undefined) throw new RecordsRefusal(503, GuidelineSaver.NO_SAVE_REPO)
    const local = (await super.guidelineReader()).read()
    // No factory repository found: there is nothing a save could reach.
    if (local.folder === null) return target
    const factory = await this.factoryRemote()
    if (RemoteGuidelineRecords.realOf(target.repo) === RemoteGuidelineRecords.realOf(factory.repo)) throw new RecordsRefusal(503, RemoteGuidelineRecords.IS_FACTORY)
    if (await factory.isRepository()) {
      const ours = new Set(await RemoteGuidelineRecords.addressesOf(factory))
      if ((await RemoteGuidelineRecords.addressesOf(target)).some(address => ours.has(address))) throw new RecordsRefusal(503, RemoteGuidelineRecords.IS_FACTORY)
    }
    return target
  }
  /** Every fetch and push address of a repository's remotes, as `git remote -v` gives them; none when git cannot say. */
  private static async addressesOf(remote: FactoryRemote): Promise<string[]> {
    const listed = await remote.git(['remote', '-v'])
    if (!listed.ok) return []
    return listed.stdout.split('\n').flatMap(line => { const found = /^\S+\t(.+) \((?:fetch|push)\)$/.exec(line.trim()); return found === null ? [] : [found[1]!.replace(/\/+$/, '')] })
  }
  private static realOf(path: string): string { try { return realpathSync(path) } catch { return resolve(path) } }
  /** Where the guideline is read from: the save repository while one is set, else the factory repository. Rejects as `factoryRemote` does. */
  async guidelineRemote(): Promise<FactoryRemote> { return this.target ?? await this.factoryRemote() }
  private remoteOf(repo: string, name?: string): FactoryRemote {
    return new FactoryRemote({ repo, runner: this.runner, ...(name === undefined ? {} : { name }), ...(this.remoteName === undefined ? {} : { remote: this.remoteName }), ...(this.branch === undefined ? {} : { branch: this.branch }) })
  }
  /** The factory repository's remote. Rejects with `RecordsRefusal(503)` when the repository was not found. */
  async factoryRemote(): Promise<FactoryRemote> {
    const local = (await super.guidelineReader()).read()
    if (local.folder === null) throw new RecordsRefusal(503, local.reason ?? 'The factory repository was not found')
    const repo = dirname(resolve(local.folder))
    let remote = this.remotes.get(repo)
    if (remote === undefined) {
      remote = this.remoteOf(repo)
      this.remotes.set(repo, remote)
    }
    return remote
  }
  override async guidelineReader(): Promise<GuidelineSource> {
    if (this.target !== undefined) {
      const target = this.target
      const read: GuidelineRead = await target.isRepository() ? await target.read()
        : { folder: join(target.repo, GuidelineFile.FOLDER), versions: [], current: null, reason: `The guideline could not be read: ${RemoteGuidelineRecords.NOT_A_REPOSITORY}`, reports: [] }
      return { read: () => read }
    }
    const local = (await super.guidelineReader()).read()
    if (local.folder === null) return { read: () => local }
    const remote = await this.factoryRemote()
    if (!await remote.isRepository()) {
      const read = { ...local, reports: RemoteGuidelineRecords.reportsIn(local.folder) }
      return { read: () => read }
    }
    const read = await remote.read()
    return { read: () => read }
  }
  /** The trend reports in a plain `guideline/` folder, newest first. A file that cannot be read is left out. */
  static reportsIn(folder: string): TrendReport[] {
    let names: string[] = []
    try { names = readdirSync(folder) } catch { return [] }
    return names.flatMap(name => {
      if (!TrendReportFile.NAME.test(name)) return []
      try { const report = TrendReportFile.parse(name, readFileSync(join(folder, name), 'utf8')); return report === null ? [] : [report] } catch { return [] }
    }).sort((left, right) => right.version - left.version)
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
  /** The start step's refusal, if a save could not start now; lets a caller refuse before it spends a model thread. */
  refusal(): Extract<SaveOutcome, { saved: false }> | undefined {
    if (this.running) return FactoryRepoSave.failed('start', FactoryRepoSave.BUSY)
    if (this.glab === undefined) return FactoryRepoSave.failed('start', FactoryRepoSave.NO_GLAB)
    return undefined
  }

  async save(remote: FactoryRemote, prepare: (read: GuidelineRead) => RepoChange): Promise<SaveOutcome> {
    const refused = this.refusal()
    if (refused !== undefined || this.glab === undefined) return refused ?? FactoryRepoSave.failed('start', FactoryRepoSave.NO_GLAB)
    this.running = true
    try { return await this.run(remote, prepare, this.glab) } finally { this.running = false }
  }

  private async run(remote: FactoryRemote, prepare: (read: GuidelineRead) => RepoChange, glab: string): Promise<SaveOutcome> {
    const fetched = await remote.fetch()
    if (!fetched.ok) return FactoryRepoSave.failed('fetch', fetched.error)
    const commitOf = await remote.head()
    if (commitOf === undefined) return FactoryRepoSave.failed('read', `${remote.name} has no ${remote.remote}/${remote.branch}`)
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
  static failed(step: SaveStep, error: string, mr?: string): Extract<SaveOutcome, { saved: false }> {
    const first = (error.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? 'it failed').replace(/\/\/[^/\s@]+@/g, '//')
    return { saved: false, step, error: first, mr }
  }
}

/** How the owner's Accept, or a trend report asked for on the page, ended: the version saved, or why not, in plain words. */
export type GuidelineSaved = { saved: true; version: number; mr: string | undefined } | { saved: false; reason: string; mr: string | undefined }

/**
 * Makes one version's trend report as a file to save: the jobs that ran under the version, read from the records, go to the report's author
 * (`TrendWriter`, a one-off model thread), and the file it gives is masked with every listed project's mask before anything is written.
 */
export class TrendReports {
  private readonly author: TrendAuthor
  private readonly records: { jobsReader(): Promise<JobsSource>; maskerFor(project: string): Promise<RecordsMasker> }
  private readonly projects: readonly string[]
  constructor(options: { author: TrendAuthor; records: { jobsReader(): Promise<JobsSource>; maskerFor(project: string): Promise<RecordsMasker> }; projects: readonly string[] }) {
    this.author = options.author
    this.records = options.records
    this.projects = options.projects
  }

  /** One function that applies every listed project's mask in turn. Rejects with `RecordsRefusal(503)` when a mask cannot be had. */
  async mask(): Promise<(text: string) => string> {
    const masks = await Promise.all(this.projects.map(async project => GuidelineSaver.maskOf(await this.records.maskerFor(project))))
    return text => masks.reduce((masked, mask) => mask(masked), text)
  }

  /**
   * The report of `version`, as `read` holds the guideline, ready to save over any report of that version written before. `written` says why it
   * is written. Rejects with `RecordsRefusal(503)` in plain words when it cannot be made; nothing is written then.
   */
  async file(version: number, read: GuidelineRead, written: 'accepted' | 'asked', now: Date): Promise<SaveFile> {
    const of = read.versions.find(each => each.version === version)
    if (of === undefined) throw new RecordsRefusal(503, `v${version} is not on the save repository's main`)
    // The version before it: the highest number below it.
    const before = read.versions.filter(each => each.version < version).sort((left, right) => right.version - left.version)[0] ?? null
    let jobs
    try { jobs = TrendPrompt.jobsUnder((await this.records.jobsReader()).read(this.projects), version) }
    catch (error) { throw error instanceof RecordsRefusal ? error : new RecordsRefusal(503, 'the jobs could not be read') }
    const mask = await this.mask()
    const report = await this.author.write({ version: of, before, jobs })
    const text = TrendReportFile.textOf({ version, date: GuidelineSaver.dayOf(now), jobs: report.jobs, compared_with: before?.version ?? null, written }, report.body)
    let masked: string
    try { masked = mask(text) } catch (error) { throw error instanceof RecordsRefusal ? error : new RecordsRefusal(503, 'the factory\'s mask failed') }
    return { path: TrendReportFile.pathOf(version), text: masked, replace: true }
  }
}

/**
 * The owner's Accept: the proposal as the next guideline version, masked, saved through `FactoryRepoSave`; with `reports`, the trend report of the
 * version it replaces goes in the same commit. Also the owner's "Write trend report" for the current version, saved the same way on a branch of its
 * own. One of them runs at a time.
 */
export class GuidelineSaver {
  static readonly NOT_SAVED = 'Not saved: '
  static readonly NO_REPORTS = 'writing a trend report is not set up here'
  /** Until Epic 3 moves to main, saves go only to a throwaway repository the owner names; with none named, nothing is saved (AD-18). */
  static readonly NO_SAVE_REPO = 'no save repository is set (review.saveRepo)'
  private readonly records: Pick<RemoteGuidelineRecords, 'saveRemote' | 'saveTarget' | 'maskerFor'>
  private readonly repo: FactoryRepoSave
  private readonly now: () => Date
  private readonly reports: TrendReports | undefined
  constructor(options: { records: Pick<RemoteGuidelineRecords, 'saveRemote' | 'saveTarget' | 'maskerFor'>; repo: FactoryRepoSave; now?: () => Date; reports?: TrendReports }) {
    this.records = options.records
    this.repo = options.repo
    this.now = options.now ?? (() => new Date())
    this.reports = options.reports
  }
  private running = false
  /** Whether an Accept or a report runs, from its first step: two of them never both pass the page's check. */
  get busy(): boolean { return this.running || this.repo.busy }

  /**
   * Saves `proposal` as the version after the remote's current one. `base` is the version the owner saw it against (`null`: none): when the
   * remote's main moved on since, nothing is saved, so an Accept never silently undoes a version the owner did not see. With `reports` and a version
   * before it, that version's trend report is written first and saved in the same commit; when it cannot be written, nothing is saved. It never throws.
   */
  async accept(proposal: GuidelineProposal, base: number | null): Promise<GuidelineSaved> {
    // First of all, so with no save repository nothing runs: no mask, no fetch, no worktree, no git, no glab, no thread.
    if (this.records.saveRemote() === undefined) return GuidelineSaver.not(GuidelineSaver.NO_SAVE_REPO)
    if (this.busy) return GuidelineSaver.not(FactoryRepoSave.BUSY)
    this.running = true
    try { return await this.save(proposal, base) } catch { return GuidelineSaver.not('the save failed') } finally { this.running = false }
  }

  /**
   * Writes the trend report of `version`, which must be the remote's current version, and saves it on a branch of its own through a merge request the
   * fork merges, replacing a report written before. It never throws.
   */
  async report(version: number): Promise<GuidelineSaved> {
    if (this.records.saveRemote() === undefined) return GuidelineSaver.not(GuidelineSaver.NO_SAVE_REPO)
    if (this.busy) return GuidelineSaver.not(FactoryRepoSave.BUSY)
    if (this.reports === undefined) return GuidelineSaver.not(GuidelineSaver.NO_REPORTS)
    this.running = true
    try { return await this.saveReport(this.reports, version) } catch { return GuidelineSaver.not('the save failed') } finally { this.running = false }
  }

  private async save(proposal: GuidelineProposal, base: number | null): Promise<GuidelineSaved> {
    const not = GuidelineSaver.not
    let mask: (text: string) => string
    let remote: FactoryRemote
    try { mask = GuidelineSaver.maskOf(await this.records.maskerFor(proposal.project)) }
    catch (error) { return not(error instanceof RecordsRefusal ? error.message : 'the factory\'s records module could not be had') }
    // A save that could not start (glab missing, another save running) stops here, before any git call and before the thread is asked.
    const refused = this.repo.refusal()
    if (refused !== undefined) return GuidelineSaver.failedOf(refused, mask)
    try { remote = await this.saveRemote() } catch (error) { return not(GuidelineSaver.reasonOf(error, mask)) }
    const now = this.now()
    // The report of the version being replaced is written before the save, from the remote's main as it is now; the save checks again after its fetch.
    let report: SaveFile | undefined
    if (base !== null && this.reports !== undefined) {
      // A fetch that fails stops here, before any thread is asked: the save's own fetch would fail the same way.
      const fetched = await remote.fetch()
      if (!fetched.ok) return GuidelineSaver.failedOf(FactoryRepoSave.failed('fetch', fetched.error), mask)
      const read = await remote.read()
      const before = read.current?.version ?? null
      if (before !== base) return not(GuidelineSaver.movedText(before))
      try { report = await this.reports.file(base, read, 'accepted', now) } catch (error) {
        // Accept is blocked, not half done (owner, AD-18): the proposal stays, so the owner is told to try again.
        const reason = GuidelineSaver.reasonOf(error, mask).replace(/\.$/, '')
        return not(`the trend report for v${base} could not be written: ${reason}. Nothing was saved; try Accept again later.`)
      }
    }
    let version = 0
    let moved: number | null | undefined
    const outcome = await this.repo.save(remote, read => {
      const before = read.current?.version ?? null
      if (before !== base) { moved = before; throw new RecordsRefusal(409, 'the guideline moved on') }
      version = (before ?? 0) + 1
      const name = mask(TalkTexts.nameOf(proposal.project))
      const title = `guideline v${version}, from the review of ${name} job ${proposal.number}`
      return {
        branch: `zees-factory/guideline-v${version}-${GuidelineSaver.stampOf(now)}`,
        title,
        message: `${title}\n\nAccepted by the owner on the review page.${report === undefined ? '' : ` With the trend report for v${before}.`}`,
        description: `Guideline v${version}${before === null ? '' : `, replacing v${before}`}, from the review talk on ${name} job ${proposal.number}.${report === undefined ? '' : ` With the trend report for v${before}.`} Accepted by the owner on the review page and merged by the fork.`,
        files: [{ path: GuidelineFile.pathOf(version), text: GuidelineFile.textOf({ version, date: GuidelineSaver.dayOf(now), from_job: mask(proposal.job_id), from_version: before }, mask(proposal.text)) },
          ...(report === undefined ? [] : [report])],
      }
    })
    if (outcome.saved) return { saved: true, version, mr: outcome.mr }
    if (moved !== undefined) return not(GuidelineSaver.movedText(moved))
    return GuidelineSaver.failedOf(outcome, mask)
  }

  private async saveReport(reports: TrendReports, version: number): Promise<GuidelineSaved> {
    const not = GuidelineSaver.not
    let mask: (text: string) => string
    let remote: FactoryRemote
    try { mask = await reports.mask() }
    catch (error) { return not(error instanceof RecordsRefusal ? error.message : 'the factory\'s records module could not be had') }
    const refused = this.repo.refusal()
    if (refused !== undefined) return GuidelineSaver.failedOf(refused, mask)
    try { remote = await this.saveRemote() } catch (error) { return not(GuidelineSaver.reasonOf(error, mask)) }
    const now = this.now()
    const fetched = await remote.fetch()
    if (!fetched.ok) return GuidelineSaver.failedOf(FactoryRepoSave.failed('fetch', fetched.error), mask)
    const read = await remote.read()
    if (read.current?.version !== version) return not(GuidelineSaver.notCurrentText(version, read.current?.version ?? null))
    const replacing = (read.reports ?? []).some(each => each.version === version)
    let file: SaveFile
    try { file = await reports.file(version, read, 'asked', now) } catch (error) {
      return not(`the trend report for v${version} could not be written: ${GuidelineSaver.reasonOf(error, mask)}`)
    }
    let moved: number | null | undefined
    const outcome = await this.repo.save(remote, after => {
      const current = after.current?.version ?? null
      if (current !== version) { moved = current; throw new RecordsRefusal(409, 'the guideline moved on') }
      const title = `trend report for guideline v${version}`
      return {
        branch: `zees-factory/trends-v${version}-${GuidelineSaver.stampOf(now)}`,
        title,
        message: `${title}\n\nAsked for by the owner on the review page.`,
        description: `The trend report for guideline v${version}${replacing ? ', replacing the one written before' : ''}. Asked for by the owner on the review page and merged by the fork.`,
        files: [file],
      }
    })
    if (outcome.saved) return { saved: true, version, mr: outcome.mr }
    if (moved !== undefined) return not(GuidelineSaver.notCurrentText(version, moved))
    return GuidelineSaver.failedOf(outcome, mask)
  }

  /**
   * The save repository's remote, which every save step uses. Rejects with `RecordsRefusal(503)` when it is unset or is the factory's. A folder
   * that is not a git repository fails at the fetch step, as git says (git never looks above it).
   */
  private saveRemote(): Promise<FactoryRemote> { return this.records.saveTarget() }

  private static not(why: string, mr?: string): GuidelineSaved { return { saved: false, reason: `${GuidelineSaver.NOT_SAVED}${why}`, mr } }
  private static movedText(now: number | null): string {
    return `the guideline is at ${now === null ? 'no version' : `v${now}`} now, not the version this proposal was shown against. Reload the page and compare again.`
  }
  private static notCurrentText(version: number, current: number | null): string {
    return `only the current version's trend report can be written, and v${version} is not the current version now (${current === null ? 'there is none' : `v${current} is`}). Reload the page.`
  }
  /** A failure's words, masked: a refusal's own message, else a plain line. */
  private static reasonOf(error: unknown, mask: (text: string) => string): string {
    const reason = error instanceof RecordsRefusal ? error.message : 'it failed'
    try { return mask(reason) } catch { return 'its message could not be masked' }
  }
  /** A save that stopped at a step, in plain words, its error masked. */
  private static failedOf(outcome: Extract<SaveOutcome, { saved: false }>, mask: (text: string) => string): GuidelineSaved {
    const step = outcome.step === 'start' ? '' : `the ${outcome.step} step failed: `
    let error = outcome.error
    try { error = mask(error) } catch { error = 'its message could not be masked' }
    return GuidelineSaver.not(`${step}${error}`, outcome.mr)
  }

  /** The day of `when` on this machine's clock, as `YYYY-MM-DD`. */
  static dayOf(when: Date): string {
    return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
  }
  /** `when` in UTC as a branch name's stamp, `YYYYMMDDTHHMMSSZ`. */
  static stampOf(when: Date): string { return when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') }

  /** One project's mask of a plain text, as a function. Each call throws `RecordsRefusal(503)` when the mask fails. */
  static maskOf(masker: RecordsMasker): (text: string) => string {
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
