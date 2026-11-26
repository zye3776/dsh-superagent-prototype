/** The review talk: its folder and pinned files, its opening message and link, starting it once per job, and the proposals it sends back. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FactoryRecordsModule, type GuidelineRead, type JobLogLine, type RecordedJob, type RecordsMasker, type RecordsSource, type ReviewLine, type StepDetail, type TimelineStep } from '../src/factory/records.ts'
import { ReviewPage } from '../src/factory/review.ts'
import { GuidelineProposals, ReviewTalks, TalkFolder, TalkLink, TalkOpening, TalkRefusal, TalkTexts } from '../src/factory/talk.ts'
import { PLANTED, REDACTED, recordsModule } from './fixtures/factory-records.ts'

const NOW = '2026-11-26T12:00:00.000Z'
let root = '', project = '', talks = '', server = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-talk-')))
  project = join(root, 'shop')
  talks = join(root, 'review-talks')
  server = join(root, 'factory', 'lib', 'dist', 'proposeServer.js')
  mkdirSync(join(root, 'factory', 'lib', 'dist'), { recursive: true })
  writeFileSync(server, '// stand-in for the built propose server\n')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const line = (fields: Partial<JobLogLine>): JobLogLine => ({ ts: '2026-11-26T08:00:00.000Z', project, job_id: 'job-1', step_id: 'step-1', kind: 'job_start', summary: 'The super agent started.', ...fields })
const step = (fields: Partial<JobLogLine>): TimelineStep => ({ automatic: false, ts: fields.ts ?? '2026-11-26T08:00:00.000Z', line: line(fields) })
const review = (fields: Partial<ReviewLine>): ReviewLine => ({ ts: '2026-11-26T09:00:00.000Z', project, job_id: 'job-1', comment: 'Keep it small.', ...fields })
/** A job of three steps with a comment on the whole job and one on its second step. */
function job(fields: Partial<RecordedJob> = {}): RecordedJob {
  return {
    project, job_id: 'job-1', number: 3, started: '2026-11-26T08:00:00.000Z', stopped: '2026-11-26T09:00:00.000Z', last: '2026-11-26T09:00:00.000Z', guideline_version: 'v2',
    steps: [step({}), step({ ts: '2026-11-26T08:30:00.000Z', step_id: 'step-2', kind: 'permission_answer', ref: 'd-1', summary: 'Approved: run the upload tests.' }),
      step({ ts: '2026-11-26T09:00:00.000Z', step_id: 'step-3', kind: 'job_stop', summary: 'The super agent stopped.' })],
    reviews: [review({ comment: 'Good pace.' }), review({ step_id: 'step-2', comment: 'Reject this at this stage.' })],
    ...fields,
  }
}
const NONE: StepDetail = { asked: null, looked_at: null, why: null, next: null, cost: null }
const DETAIL: StepDetail = {
  asked: { kind: 'request', tool_name: 'Bash', tool_input: { command: 'bun test' }, reason: 'Run the tests.', session_id: 'worker-1' }, looked_at: [{ path: 'stories/4-2.md', used: true }],
  why: { by: 'super_agent', decision: 'approve', choice: null, risk: 'low', reason: 'It changes nothing outside the worktree.', alternative: '', cites: 'story 4.2' },
  next: { outcome: 'ran_ok', tool_use_id: 't-1', detail: '12 pass' }, cost: { tokens: 980, seconds: 2.2 },
}
const guideline = (text: string | null): GuidelineRead => text === null
  ? { folder: '/factory/guideline', versions: [], current: null, reason: 'No guideline yet.' }
  : { folder: '/factory/guideline', versions: [{ version: 2, date: '2026-11-24', from_job: null, from_version: 1, text }], current: { version: 2, date: '2026-11-24', from_job: null, from_version: 1, text }, reason: null }

/**
 * A stand-in records module: its mask replaces the planted value and writes down every text it was given and gave back, so a test can show that every
 * file and the link's message went through it.
 */
class StandInRecords implements RecordsSource {
  readonly masked: string[] = []
  constructor(private readonly read: GuidelineRead = guideline('# Guideline\nKeep it small.\n'), private readonly masker: Partial<RecordsMasker> | 'fails' = {}) {}
  async maskerFor(): Promise<RecordsMasker> {
    if (this.masker === 'fails') throw new Error(PLANTED)
    return { maskAction: value => value, maskReview: value => value, maskText: (text: string) => { const out = text.replaceAll(PLANTED, REDACTED); this.masked.push(out); return out }, ...this.masker }
  }
  async reader(): Promise<never> { throw new Error('not used') }
  async jobsReader(): Promise<never> { throw new Error('not used') }
  async stepReader() { return { read: (_project: string, picked: TimelineStep) => picked.automatic === false && picked.line.step_id === 'step-2' ? DETAIL : NONE } }
  async guidelineReader() { return { read: () => this.read } }
}
const talksOf = (records: RecordsSource, fields: Partial<ConstructorParameters<typeof ReviewTalks>[0]> = {}) =>
  new ReviewTalks({ records, tokenFile: join(root, 'superagent-token'), words: ReviewPage, root: talks, serverFile: server, node: '/usr/local/bin/node', home: '/Users/jex', now: () => new Date(NOW), ...fields })
const ADDRESS = 'http://127.0.0.1:3083/review/proposal'
/** Every file under a folder, as paths below it, sorted. */
function filesOf(folder: string): string[] {
  // The talk folder's own git repository is left out here; its own test checks what it holds.
  return readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => relative(folder, join(entry.parentPath, entry.name)))
    .filter(name => !name.startsWith('.git/')).sort()
}
const messageOf = (link: string) => decodeURIComponent(/[?&]q=([^&]*)/.exec(link)![1]!)
const folderOf = (link: string) => decodeURIComponent(/[?&]folder=([^&]*)/.exec(link)![1]!)

describe('TalkFolder', () => {
  it('pins the settings to four deny rules and nothing else, byte for byte', () => {
    expect(TalkFolder.SETTINGS).toBe('{\n  "permissions": {\n    "deny": [\n      "Write",\n      "Edit",\n      "NotebookEdit",\n      "Bash"\n    ]\n  }\n}\n')
    const parsed = JSON.parse(TalkFolder.SETTINGS) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['permissions'])
    expect(Object.keys(parsed.permissions as object)).toEqual(['deny'])
  })

  it('pins the server file to the one propose server, started with the Node that runs DSH; the token is never in it and the home folder is ${HOME}', () => {
    const mcp = TalkFolder.mcpOf({ node: '/Users/jex/.nvm/versions/node/v24/bin/node', server: '/Users/jex/factory/lib/dist/proposeServer.js', url: ADDRESS,
      tokenFile: '/Users/jex/.config/zees-factory/superagent-token' }, '/Users/jex')
    expect(mcp).toBe(`{
  "mcpServers": {
    "zees-factory-propose": {
      "command": "\${HOME}/.nvm/versions/node/v24/bin/node",
      "args": [
        "\${HOME}/factory/lib/dist/proposeServer.js",
        "--url",
        "http://127.0.0.1:3083/review/proposal",
        "--token-file",
        "\${HOME}/.config/zees-factory/superagent-token"
      ]
    }
  }
}
`)
    const parsed = JSON.parse(mcp) as { mcpServers: Record<string, Record<string, unknown>> }
    expect([Object.keys(parsed), Object.keys(parsed.mcpServers), Object.keys(parsed.mcpServers['zees-factory-propose']!)]).toEqual([['mcpServers'], ['zees-factory-propose'], ['command', 'args']])
    // A path outside the home folder stays as it is.
    expect(TalkFolder.homeAsVariable('/usr/local/bin/node', '/Users/jex')).toBe('/usr/local/bin/node')
    expect(TalkFolder.homeAsVariable('/Users/jexother/node', '/Users/jex')).toBe('/Users/jexother/node')
  })

  it('names a job\'s folder by its project, its number and a short hash, so two projects with the same job id never share one', () => {
    const first = TalkFolder.of(talks, job())
    expect(first.path).toMatch(new RegExp(`^${talks}/shop-job-3-[0-9a-f]{8}$`))
    expect(TalkFolder.of(talks, job({ project: join(root, 'other', 'shop') })).path).not.toBe(first.path)
    expect(TalkFolder.of(talks, job()).path).toBe(first.path)
  })
})

describe('TalkOpening', () => {
  const texts = (comments: string, jobText = 'The job.') => ({ title: 'Review talk · shop job 3', job: jobText, comments, guideline: 'Keep it small.\n' })
  it('starts with the title line and holds what the talk is for, the lookup rule, the comments, the job and the guideline', () => {
    const message = TalkOpening.build(job(), 'shop-job-3-0123abcd', texts('Good pace.'), guideline('Keep it small.\n'))
    expect(message.split('\n')[0]).toBe('Review talk · shop job 3')
    for (const part of [TalkOpening.LOOKUP_RULE, 'propose_guideline_change with job_id "job-1"', 'Good pace.', 'The job.', 'Keep it small.', 'version 2']) expect(message).toContain(part)
    // The folder check comes right after the title line, before anything about the job, and names this talk's own folder.
    expect(message.split('\n').slice(0, 3)).toEqual(['Review talk · shop job 3', '', 'Before anything else, check your working folder, as your environment states it. '
      + 'It must be the talk folder shop-job-3-0123abcd, under ~/.config/zees-factory/review-talks/, or a git worktree of it inside that folder\'s own '
      + '.claude/worktrees/. If it is any other folder, reply only: "This review talk opened in the wrong folder, so it is stopping here. Close this session, '
      + 'choose no project in Claude Desktop\'s Code tab, then start the talk again from the review page.", then add your working folder\'s path, and do '
      + 'nothing else: read no file, call no tool and do not '
      + 'discuss the job.'])
  })

  it('past 14,000 characters keeps the title line, the comments and the lookup rule, and names the files that hold the rest', () => {
    const message = TalkOpening.build(job(), 'shop-job-3-0123abcd', texts('Good pace.', 'x'.repeat(20_000)), guideline('Keep it small.\n'))
    expect(message.length).toBeLessThanOrEqual(TalkOpening.MAX_CHARS)
    for (const part of ['Review talk · shop job 3', TalkOpening.folderCheck('shop-job-3-0123abcd'), TalkOpening.LOOKUP_RULE, 'Good pace.', 'job.md', 'guideline.md']) expect(message).toContain(part)
    expect(message).not.toContain('xxxxxxxxxx')
    const long = TalkOpening.build(job(), 'shop-job-3-0123abcd', texts('y'.repeat(20_000)), guideline('Keep it small.\n'))
    expect([long.length <= TalkOpening.MAX_CHARS, long.includes(TalkOpening.CUT), long.includes(TalkOpening.LOOKUP_RULE), long.includes(TalkOpening.folderCheck('shop-job-3-0123abcd'))]).toEqual([true, true, true, true])
  })

  it('says there is no guideline yet and that a proposal would be version 1', () => {
    const message = TalkOpening.build(job(), 'shop-job-3-0123abcd', { ...texts('Good pace.'), guideline: TalkTexts.guideline(guideline(null)) }, guideline(null))
    expect(message).toContain('there is none yet, so a proposal would be version 1')
    expect(message).toContain('There is no guideline yet. A proposal would be version 1.')
  })
})

describe('TalkLink', () => {
  it('encodes the folder and the message, a space as %20', () => {
    const link = TalkLink.of('/a b/talk', 'Review talk · shop job 3\n&q=x')
    expect(link).toBe('claude://code/new?folder=%2Fa%20b%2Ftalk&q=Review%20talk%20%C2%B7%20shop%20job%203%0A%26q%3Dx')
    expect([folderOf(link), messageOf(link)]).toEqual(['/a b/talk', 'Review talk · shop job 3\n&q=x'])
  })
})

describe('ReviewTalks', () => {
  it('starts a talk: the folder holds exactly the pinned files and the job\'s files, and the link opens it with the opening message', async () => {
    const records = new StandInRecords()
    const started = await talksOf(records).start(job(), ADDRESS, false)
    expect(started.opened).toBe(true)
    if (!started.opened) return
    const folder = TalkFolder.of(talks, job()).path
    expect(filesOf(folder)).toEqual(['.claude/settings.json', '.mcp.json', 'comments.md', 'guideline.md', 'job.md', 'talk.json'])
    expect(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8')).toBe(TalkFolder.SETTINGS)
    expect(readFileSync(join(folder, '.mcp.json'), 'utf8')).toBe(TalkFolder.mcpOf({ node: '/usr/local/bin/node', server, url: ADDRESS, tokenFile: join(root, 'superagent-token') }, '/Users/jex'))
    expect(JSON.parse(readFileSync(join(folder, 'talk.json'), 'utf8'))).toEqual({ project, job_id: 'job-1', number: 3, title: 'Review talk · shop job 3', started: NOW })
    expect(started.state).toEqual({ project, job_id: 'job-1', number: 3, title: 'Review talk · shop job 3', started: NOW })
    // The files are owner-only.
    expect(statSync(join(folder, 'job.md')).mode & 0o077).toBe(0)
    const jobText = readFileSync(join(folder, 'job.md'), 'utf8')
    for (const part of ['# shop job 3', 'Job started', 'Permission answered', 'Approved: run the upload tests.', 'What was asked: Bash · bun test', 'Why: Approved · risk low',
      'What it looked at: stories/4-2.md (used)', 'What happened next: Ran and succeeded · 12 pass', 'Cost: 980 tokens · 2.2 s', 'Why: Not recorded']) expect(jobText).toContain(part)
    expect(readFileSync(join(folder, 'comments.md'), 'utf8')).toBe('# The owner\'s comments on shop job 3\n\n## On the whole job\nGood pace.\n\n## On step 2 · 2026-11-26T08:30:00.000Z · Permission answered\nReject this at this stage.\n')
    expect(readFileSync(join(folder, 'guideline.md'), 'utf8')).toBe('# Guideline\nKeep it small.\n')
    expect([folderOf(started.link), started.link.startsWith('claude://code/new?folder=')]).toEqual([folder, true])
    const message = messageOf(started.link)
    for (const part of ['Good pace.', 'Reject this at this stage.', 'Keep it small.', TalkOpening.LOOKUP_RULE, TalkOpening.folderCheck(basename(folder))]) expect(message).toContain(part)
    expect(message.split('\n')[0]).toBe('Review talk · shop job 3')
  })

  it('writes every file and the link\'s message only through the mask, so a planted secret is in none of them', async () => {
    const records = new StandInRecords(guideline(`Never print ${PLANTED}.\n`))
    const planted = job({ steps: [step({ summary: `Started with ${PLANTED}.` })], reviews: [review({ comment: `Do not print ${PLANTED}.` })] })
    const started = await talksOf(records).start(planted, ADDRESS, false)
    if (!started.opened) throw new Error('not opened')
    const folder = TalkFolder.of(talks, planted).path
    for (const name of filesOf(folder)) {
      const text = readFileSync(join(folder, name), 'utf8')
      expect([name, text.includes(PLANTED)]).toEqual([name, false])
      // Each file's whole text is one the mask gave back.
      expect([name, records.masked.includes(text)]).toEqual([name, true])
    }
    expect(records.masked).toContain(messageOf(started.link))
    expect(started.link).not.toContain(encodeURIComponent(PLANTED))
    expect(readFileSync(join(folder, 'comments.md'), 'utf8')).toContain(`Do not print ${REDACTED}.`)
  })

  it('a second start opens nothing and rewrites nothing; a fresh one writes the files again with a new date', async () => {
    const records = new StandInRecords()
    let now = NOW
    const talk = talksOf(records, { now: () => new Date(now) })
    await talk.start(job(), ADDRESS, false)
    const folder = TalkFolder.of(talks, job()).path
    const before = Object.fromEntries(filesOf(folder).map(name => [name, readFileSync(join(folder, name), 'utf8')]))
    now = '2026-11-27T08:00:00.000Z'
    const again = await talk.start(job({ reviews: [review({ comment: 'Changed my mind.' })] }), ADDRESS, false)
    expect(again).toEqual({ opened: false, state: { project, job_id: 'job-1', number: 3, title: 'Review talk · shop job 3', started: NOW } })
    expect(Object.fromEntries(filesOf(folder).map(name => [name, readFileSync(join(folder, name), 'utf8')]))).toEqual(before)
    const fresh = await talk.start(job({ reviews: [review({ comment: 'Changed my mind.' })] }), ADDRESS, true)
    expect([fresh.opened, fresh.state.started]).toEqual([true, now])
    expect(readFileSync(join(folder, 'comments.md'), 'utf8')).toContain('Changed my mind.')
    expect(talk.stateOf(job())?.started).toBe(now)
  })

  /** Asks git about the talk folder, reading none of the owner's git settings. */
  const git = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8',
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  const TALK_FILES = ['.claude/settings.json', '.mcp.json', 'comments.md', 'guideline.md', 'job.md', 'talk.json']

  it('makes the talk folder its own git repository: one commit by the factory holding exactly the files written, on main, with no remote', async () => {
    await talksOf(new StandInRecords()).start(job(), ADDRESS, false)
    const folder = TalkFolder.of(talks, job()).path
    expect(git(folder, 'rev-parse', '--show-toplevel')).toBe(realpathSync(folder))
    expect(git(folder, 'log', '--format=%an <%ae> · %cn <%ce>')).toBe('zees-factory <zees-factory@localhost> · zees-factory <zees-factory@localhost>')
    expect([git(folder, 'symbolic-ref', '--short', 'HEAD'), git(folder, 'remote'), git(folder, 'status', '--porcelain')]).toEqual(['main', '', ''])
    expect(git(folder, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toEqual(TALK_FILES)
    // The commit holds the files byte for byte, the pinned settings file among them.
    for (const name of TALK_FILES) expect([name, git(folder, 'show', `HEAD:${name}`)]).toEqual([name, readFileSync(join(folder, name), 'utf8').trim()])
    expect(`${git(folder, 'show', 'HEAD:.claude/settings.json')}\n`).toBe(TalkFolder.SETTINGS)
  })

  it('a second start adds no commit; a fresh talk commits the rewritten files on top and keeps the history', async () => {
    let now = NOW
    const talk = talksOf(new StandInRecords(), { now: () => new Date(now) })
    await talk.start(job(), ADDRESS, false)
    const folder = TalkFolder.of(talks, job()).path
    await talk.start(job(), ADDRESS, false)
    expect(git(folder, 'rev-list', '--count', 'HEAD')).toBe('1')
    now = '2026-11-27T08:00:00.000Z'
    await talk.start(job({ reviews: [review({ comment: 'Changed my mind.' })] }), ADDRESS, true)
    expect(git(folder, 'log', '--format=%s').split('\n')).toEqual([`Review talk files, started ${now}`, `Review talk files, started ${NOW}`])
    expect([git(folder, 'show', 'HEAD:comments.md').includes('Changed my mind.'), git(folder, 'show', 'HEAD~1:comments.md').includes('Changed my mind.')]).toEqual([true, false])
    expect([git(folder, 'status', '--porcelain'), git(folder, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')]).toEqual(['', TALK_FILES])
  })

  it('reads and changes none of the owner\'s git settings: a global config that signs commits and names another author is not used, nor DSH\'s GIT_ variables', async () => {
    const home = join(root, 'owner-home')
    mkdirSync(home)
    const config = join(home, '.gitconfig')
    const owner = '[user]\n\tname = Owner\n\temail = owner@example.com\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = /nowhere\n'
    writeFileSync(config, owner)
    const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_DIR: process.env.GIT_DIR }
    Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: config, GIT_DIR: join(root, 'elsewhere.git') })
    try {
      await talksOf(new StandInRecords()).start(job(), ADDRESS, false)
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    }
    const folder = TalkFolder.of(talks, job()).path
    expect(git(folder, 'log', '--format=%an <%ae>')).toBe('zees-factory <zees-factory@localhost>')
    expect([readFileSync(config, 'utf8'), existsSync(join(root, 'elsewhere.git'))]).toEqual([owner, false])
  })

  it('refuses with 503 and marks nothing as started when git cannot commit the folder', async () => {
    const path = process.env.PATH
    process.env.PATH = join(root, 'no-git-here')
    let refused: TalkRefusal | undefined
    const talk = talksOf(new StandInRecords())
    try {
      refused = await talk.start(job(), ADDRESS, false).then(() => undefined, (error: unknown) => error as TalkRefusal)
    } finally { process.env.PATH = path }
    expect([refused?.status, refused?.message]).toEqual([503, 'The review talk could not be prepared: the talk folder could not be committed to its own git repository'])
    expect(talk.stateOf(job())).toBeUndefined()
  })

  it('refuses a job with no comment with 409 and writes no folder', async () => {
    const refused = await talksOf(new StandInRecords()).start(job({ reviews: [] }), ADDRESS, false).then(() => { throw new Error('the talk started') }, (error: unknown) => error)
    expect([refused instanceof TalkRefusal, (refused as TalkRefusal).status, (refused as Error).message]).toEqual([true, 409, 'Comment on the job or a step first.'])
    expect(existsSync(talks)).toBe(false)
  })

  it('refuses with 503 and marks nothing as started without a working mask, without the propose server, or when the folder cannot be written', async () => {
    const cases: [string, ReviewTalks, string][] = [
      ['no mask', talksOf(new StandInRecords(undefined, 'fails')), 'the factory\'s mask cannot be had'],
      ['a mask without maskText', talksOf(new StandInRecords(undefined, { maskText: undefined })), 'cannot mask a plain text'],
      ['a mask that throws', talksOf(new StandInRecords(undefined, { maskText: () => { throw new Error(PLANTED) } })), 'the factory\'s mask failed'],
      ['a mask that changes the pinned files', talksOf(new StandInRecords(undefined, { maskText: (text: string) => text.replaceAll('Bash', 'B') })), 'the mask changed'],
      ['no propose server', talksOf(new StandInRecords(), { serverFile: join(root, 'missing.js') }), 'propose server'],
    ]
    for (const [what, talk, reason] of cases) {
      const refused = await talk.start(job(), ADDRESS, false).then(() => { throw new Error('the talk started') }, (error: unknown) => error as TalkRefusal)
      expect([what, refused.status, refused.message.startsWith('The review talk could not be prepared: '), refused.message.includes(reason), refused.message.includes(PLANTED)])
        .toEqual([what, 503, true, true, false])
      expect([what, existsSync(TalkFolder.of(talks, job()).path)]).toEqual([what, false])
    }
    // A file where the root folder should be.
    writeFileSync(join(root, 'blocked'), '')
    const blocked = await talksOf(new StandInRecords(), { root: join(root, 'blocked') }).start(job(), ADDRESS, false).then(() => { throw new Error('the talk started') }, (error: unknown) => error as TalkRefusal)
    expect([blocked.status, blocked.message]).toEqual([503, expect.stringContaining('the talk folder could not be written')])
    // A symlink in the folder's place is not written through.
    mkdirSync(talks)
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), TalkFolder.of(talks, job()).path)
    const linked = await talksOf(new StandInRecords()).start(job(), ADDRESS, false).then(() => { throw new Error('the talk started') }, (error: unknown) => error as TalkRefusal)
    expect([linked.status, readdirSync(join(root, 'elsewhere'))]).toEqual([503, []])
  })

  it('finds the propose server next to the records module\'s built file by default', async () => {
    // A real records module whose file sits where the factory's built job log file would, with the propose server beside it.
    const records = new FactoryRecordsModule(recordsModule(join(root, 'factory', 'lib', 'dist')))
    const started = await talksOf(records, { serverFile: undefined }).start(job(), ADDRESS, false)
    expect(started.opened).toBe(true)
    expect(readFileSync(join(TalkFolder.of(talks, job()).path, '.mcp.json'), 'utf8')).toContain(JSON.stringify(server))
  })

  it('prepares a talk with no guideline yet, saying a proposal would be version 1', async () => {
    const started = await talksOf(new StandInRecords(guideline(null))).start(job(), ADDRESS, false)
    if (!started.opened) throw new Error('not opened')
    expect(readFileSync(join(TalkFolder.of(talks, job()).path, 'guideline.md'), 'utf8')).toBe('There is no guideline yet. A proposal would be version 1.\n')
    expect(messageOf(started.link)).toContain('a proposal would be version 1')
  })
})

describe('GuidelineProposals', () => {
  it('keeps the newest proposal per job, newest first across jobs', () => {
    const proposals = new GuidelineProposals()
    const of = (job_id: string, text: string, ts: string) => ({ project, job_id, number: 1, text, ts })
    proposals.put(of('job-1', 'First.', '2026-11-26T10:00:00.000Z'))
    proposals.put(of('job-2', 'Other job.', '2026-11-26T10:05:00.000Z'))
    proposals.put(of('job-1', 'Second.', '2026-11-26T10:10:00.000Z'))
    expect(proposals.newest().map(each => [each.job_id, each.text])).toEqual([['job-1', 'Second.'], ['job-2', 'Other job.']])
    expect(proposals.of(project, 'job-1')?.text).toBe('Second.')
    expect(proposals.of(join(root, 'other'), 'job-1')).toBeUndefined()
  })
})
