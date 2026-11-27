/** The factory's review page, served by a real HTTP server on loopback, reading and writing a temporary project through a stand-in records module. */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { JSDOM, VirtualConsole } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/factory/index.ts'
import { FactoryRecordFile, FactoryRecordsModule, type AutomaticAnswer, type GuidelineRead, type GuidelineSource, type GuidelineVersion, type JobLogLine, type ProjectJobs, type RecordedJob, type ReviewLine, type StepDetail, type StepSource, type TrendReport } from '../src/factory/records.ts'
import { ReviewAccess, ReviewPage, ReviewRoute, ReviewSignIn, type GuidelineAnswerer } from '../src/factory/review.ts'
import type { GuidelineSaved } from '../src/factory/save.ts'
import { OrcaLauncher, ReviewTalks, TalkComments, TalkFolder, type GuidelineProposal, type OrcaRun } from '../src/factory/talk.ts'
import { SharedTokenFile } from '../src/factory/token.ts'
import { PLANTED, REDACTED, recordsModule } from './fixtures/factory-records.ts'
import { fakeDsh } from './fixtures/judge.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
interface Route { kind: string; path: string; auth?: string; handler: Handler }
interface Answer { status: number; text: string; headers: IncomingMessage['headers'] }

const NOW = '2026-11-26T12:00:00.000Z'
const TOKEN = 'test-token_0123456789abcdefghijklmnopqrstuvwxyz'
const OTHER_TOKEN = 'test-token_0123456789abcdefghijklmnopqrstuvwxyZ'
let root = '', project = '', server: Server | undefined, port = 0, routes: Route[] = []
const tokenPath = () => join(root, 'superagent-token')
function writeToken(content: string = TOKEN, mode = 0o600): void {
  rmSync(tokenPath(), { force: true })
  writeFileSync(tokenPath(), content)
  chmodSync(tokenPath(), mode)
}
const file = (name: string, of: string = project) => join(of, FactoryRecordFile.FOLDER, name)
const lines = (name: string, of: string = project) => readFileSync(file(name, of), 'utf8').split('\n').filter(line => line !== '')
const put = (name: string, written: (object | string)[], of: string = project) =>
  writeFileSync(file(name, of), written.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n')
const action = (fields: Partial<JobLogLine> = {}): JobLogLine => ({ ts: '2026-11-26T08:00:00.000Z', project, job_id: 'job-1', step_id: 'step-1', kind: 'job_start',
  summary: 'The first job started.', ...fields })
const review = (fields: Partial<ReviewLine> = {}): ReviewLine => ({ ts: '2026-11-26T09:00:00.000Z', project, job_id: 'job-1', comment: 'Keep it small.', ...fields })
const origin = () => `http://127.0.0.1:${port}`

/** Where the tests' review talks go, and the stand-in for the built propose server that a talk's `.mcp.json` names. */
const talkRoot = () => join(root, 'review-talks')
const proposeServer = () => join(root, 'proposeServer.js')
/** Every Orca command the test's review talks ran, as argument lists. Nothing is really run: the stand-in only writes each one down. */
let orcaCalls: string[][] = []
beforeEach(() => { orcaCalls = [] })
const orcaRunner = { run: async (_program: string, args: readonly string[]): Promise<OrcaRun> => {
  orcaCalls.push([...args])
  return { ok: true, stdout: args[1] === 'list' ? JSON.stringify({ result: { repos: [] } }) : '' }
} }
/** The review talks of the test's page: under the test's folder, never under the owner's home, and opened in a stand-in for Orca. */
const talksFor = (records: FactoryRecordsModule, serverFile: string = proposeServer()) =>
  new ReviewTalks({ records, tokenFile: tokenPath(), words: ReviewPage, root: talkRoot(), serverFile, now: () => new Date(NOW),
    orca: new OrcaLauncher({ program: '/opt/homebrew/bin/orca', root: talkRoot(), runner: orcaRunner }) })
let reviewRoute: ReviewRoute | undefined
/**
 * The `Cookie` header of a browser signed in to DSH at 127.0.0.1: DSH names its cookie after the address, `dsh-auth-<hash>`, and signs its value
 * for that address, so the one for `localhost` is another cookie.
 */
const DSH_COOKIE = 'dsh-auth-c2lnbmVkLWluLWJ5LWRzaA=v1.signed-by-dsh'
const DSH_LOCALHOST_COOKIE = 'dsh-auth-bG9jYWxob3N0LWJ5LWRzaA=v1.signed-by-dsh'
/**
 * A stand-in for DSH's connection service (`ctx.connection`), doing what DSH 0.2.1's `admit` does with a request (`dsh-client-connection`
 * `lib/index.js`, `isTrustedApiRequest` and `requestRejection`): 403 for a Host that is not loopback, a cross-site fetch or another Origin, then 401
 * without DSH's sign-in cookie for that address. `refuse` makes it answer one status whatever comes, as a later DSH may answer 503.
 */
class DshConnection {
  readonly asked: IncomingMessage['headers'][] = []
  refuse: 401 | 403 | 503 | undefined
  admit(request: { headers: IncomingMessage['headers'] }): { peer: never } | { rejection: 401 | 403 } {
    this.asked.push(request.headers)
    if (this.refuse !== undefined) return { rejection: this.refuse as 401 }
    const { host, origin, cookie } = request.headers
    const hostname = host === undefined ? undefined : new URL(`http://${host}`).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') return { rejection: 403 }
    if (request.headers['sec-fetch-site'] === 'cross-site') return { rejection: 403 }
    if (origin !== undefined && origin !== `http://${host}`) return { rejection: 403 }
    const wanted = hostname === 'localhost' ? DSH_LOCALHOST_COOKIE : DSH_COOKIE
    const signed = (cookie ?? '').split(';').some(part => part.trim() === wanted)
    return signed ? { peer: {} as never } : { rejection: 401 }
  }
}
let dsh = new DshConnection()
/** Serves the page of a fake DSH web server over real HTTP, reading the token file and the stand-in records module of the test. */
async function serve(projects: string[] = [project], records: FactoryRecordsModule = new FactoryRecordsModule(recordsModule(root)), talks: ReviewTalks = talksFor(records),
  saver?: GuidelineAnswerer): Promise<Route[]> {
  routes = []
  // DSH's `exact` routes match the path alone, without the query.
  server = createServer((req, res) => { void routes.find(route => route.path === new URL(req.url ?? '/', 'http://127.0.0.1').pathname)!.handler(req, res) })
  await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
  const ctx = { webServer: { host: '127.0.0.1', port, register: (registered: Route) => { routes.push(registered); return () => {} } } }
  reviewRoute = new ReviewRoute(projects, new SharedTokenFile(tokenPath()), records, () => new Date(NOW), talks, saver)
  reviewRoute.register(ctx as never)
  reviewRoute.signIn.use(dsh)
  return routes
}
/** Sends one request. A header given as `undefined` is left out. */
function call(method: string, path: string, headers: Record<string, string | undefined> = {}, body?: string | Buffer): Promise<Answer> {
  const sent = body === undefined ? undefined : Buffer.from(body)
  return new Promise((resolve, reject) => {
    const length = sent && !('transfer-encoding' in headers) ? { 'content-length': String(sent.length) } : {}
    const all = Object.fromEntries(Object.entries({ ...length, ...headers }).filter(([, value]) => value !== undefined))
    const req = request({ host: '127.0.0.1', port, path, method, headers: all as Record<string, string> }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }) })
    })
    req.on('error', reject)
    req.end(sent)
  })
}
/** The `Cookie` header of a browser that opened DSH: DSH's own sign-in, which the review page shares. */
async function signIn(): Promise<string> { return DSH_COOKIE }
/** Posts a comment as the page's script does. */
const comment = (cookie: string | undefined, body: unknown, headers: Record<string, string | undefined> = {}) =>
  call('POST', '/review/comment', { origin: origin(), cookie, 'content-type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body))
/** The page as a document, to read what a browser would show. */
const dom = (html: string) => new JSDOM(html).window.document

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-review-'))
  project = join(root, 'project')
  mkdirSync(join(project, FactoryRecordFile.FOLDER), { recursive: true })
  writeFileSync(proposeServer(), '// stand-in for the built propose server\n')
  writeToken()
  dsh = new DshConnection()
})
afterEach(async () => {
  await new Promise<void>(resolve => { server ? server.close(() => { resolve() }) : resolve() })
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

it('registers six exact routes, anonymous to DSH\'s web server so the page answers its own line, and refuses a web server that is not on loopback', async () => {
  const registered = await serve()
  expect(registered.map(route => [route.kind, route.path, route.auth])).toEqual([['exact', '/review', 'anonymous'],
    ['exact', '/review/comment', 'anonymous'], ['exact', '/review/talk', 'anonymous'], ['exact', '/review/proposal', 'anonymous'], ['exact', '/review/answer', 'anonymous'], ['exact', '/review/trends', 'anonymous']])
  const disposed: string[] = []
  const ctx = { webServer: { host: '127.0.0.1', port: 3083, register: (route: Route) => () => { disposed.push(route.path) } } }
  new ReviewRoute([project]).register(ctx as never)()
  expect(disposed).toEqual(['/review', '/review/comment', '/review/talk', '/review/proposal', '/review/answer', '/review/trends'])
  expect(() => new ReviewRoute([project]).register({ webServer: { host: '0.0.0.0', port: 3083, register: () => () => {} } } as never)).toThrow('loopback')
  expect(() => new ReviewRoute(['relative/project'])).toThrow('absolute')
})

it('lets in a browser signed in to DSH, with no sign-in step of its own: DSH is asked with the request as it came', async () => {
  await serve()
  put('actions.jsonl', [action()])
  const page = await call('GET', '/review', { cookie: DSH_COOKIE })
  expect(page.status).toBe(200)
  expect(page.text).toContain('The first job started.')
  // The page shows no token field and sets no cookie of its own.
  expect(dom(page.text).querySelector('input[type=password], form[action="/review/login"]')).toBeNull()
  expect(page.headers['set-cookie']).toBeUndefined()
  expect(dsh.asked.at(-1)!.cookie).toBe(DSH_COOKIE)
  // A browser may send the page's own Origin with a GET; other cookies beside DSH's do not matter; reached as localhost, the origin is localhost.
  expect((await call('GET', '/review', { cookie: `a=b; ${DSH_COOKIE}; c=d`, origin: origin() })).status).toBe(200)
  expect((await call('GET', '/review', { cookie: DSH_LOCALHOST_COOKIE, host: `localhost:${port}`, origin: `http://localhost:${port}` })).status).toBe(200)
  // DSH ties its cookie to the address: the one for 127.0.0.1 does not sign in at localhost.
  expect((await call('GET', '/review', { cookie: DSH_COOKIE, host: `localhost:${port}` })).status).toBe(401)
  const saved = await comment(DSH_COOKIE, { job_id: 'job-1', comment: 'Signed in through DSH.' })
  expect(saved.status).toBe(200)
  expect((await call('GET', '/review/proposal', { cookie: DSH_COOKIE })).status).toBe(200)
  // The sign-in address of the page's old token form is gone.
  expect(routes.some(route => route.path === '/review/login')).toBe(false)
})

it('shows only "Open dsh first" and no record content to a browser not signed in to DSH, and never asks for a token', async () => {
  await serve()
  put('actions.jsonl', [action()])
  put('reviews.jsonl', [review()])
  // The page's old cookie, with any value, is no sign-in either.
  for (const cookie of [undefined, 'dsh-auth-c2lnbmVkLWluLWJ5LWRzaA=forged', 'factory_review=' + '0'.repeat(64), 'other=1']) {
    const answer = await call('GET', '/review', { cookie })
    expect([cookie, answer.status]).toEqual([cookie, 401])
    const shown = dom(answer.text)
    expect([...shown.body.children].map(each => [each.tagName, each.textContent])).toEqual([['P', ReviewSignIn.SIGNED_OUT]])
    for (const content of ['The first job started.', 'Keep it small.', 'job-1', project, TOKEN]) expect(answer.text).not.toContain(content)
    expect(shown.querySelector('form, input, textarea')).toBeNull()
    expect(answer.headers['set-cookie']).toBeUndefined()
  }
  expect(ReviewSignIn.SIGNED_OUT).toBe('Open dsh first, then use its Review link.')
  // The addresses the page's script calls answer the same line as `{ error }`, and nothing is written.
  const saved = await comment(undefined, { job_id: 'job-1', comment: 'Should not be saved.' })
  expect([saved.status, JSON.parse(saved.text)]).toEqual([401, { error: ReviewSignIn.SIGNED_OUT }])
  const talk = await call('POST', '/review/talk', { origin: origin(), 'content-type': 'application/json' }, JSON.stringify({ job_id: 'job-1' }))
  expect([talk.status, JSON.parse(talk.text)]).toEqual([401, { error: ReviewSignIn.SIGNED_OUT }])
  expect((await call('GET', '/review/proposal', {})).status).toBe(401)
  expect(lines('reviews.jsonl')).toHaveLength(1)
  expect(existsSync(talkRoot())).toBe(false)
})

it('refuses every browser address with a plain 503 when DSH has no connection service, and has no fallback', async () => {
  await serve()
  put('actions.jsonl', [action()])
  // As when DSH takes its connection service away: the plugin's hold ends.
  const route = new ReviewRoute([project], new SharedTokenFile(tokenPath()), new FactoryRecordsModule(recordsModule(root)), () => new Date(NOW), talksFor(new FactoryRecordsModule(recordsModule(root))))
  const release = route.signIn.use(dsh)
  release()
  const page = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await route.handle(page.req, page.res, 3083, 'page')
  expect(page.answer.status).toBe(503)
  expect(dom(page.answer.text).querySelector('p')!.textContent).toBe(ReviewSignIn.NO_SERVICE)
  expect(page.answer.text).not.toContain('The first job started.')
  const saved = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083', cookie: DSH_COOKIE }, JSON.stringify({ job_id: 'job-1', comment: 'No.' }))
  await route.handle(saved.req, saved.res, 3083, 'comment')
  expect([saved.answer.status, JSON.parse(saved.answer.text)]).toEqual([503, { error: ReviewSignIn.NO_SERVICE }])
  const talk = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083', cookie: DSH_COOKIE }, JSON.stringify({ job_id: 'job-1' }))
  await route.handle(talk.req, talk.res, 3083, 'talk')
  expect([talk.answer.status, JSON.parse(talk.answer.text)]).toEqual([503, { error: ReviewSignIn.NO_SERVICE }])
  const waiting = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await route.handle(waiting.req, waiting.res, 3083, 'proposal')
  expect([waiting.answer.status, JSON.parse(waiting.answer.text)]).toEqual([503, { error: ReviewSignIn.NO_SERVICE }])
  expect(existsSync(file('reviews.jsonl'))).toBe(false)
  expect(existsSync(talkRoot())).toBe(false)
  // A connection service that throws is one that cannot answer: 503, not a failure of the page.
  const broken = route.signIn.use({ admit: () => { throw new Error('secret unreadable') } })
  const thrown = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await route.handle(thrown.req, thrown.res, 3083, 'page')
  expect([thrown.answer.status, dom(thrown.answer.text).querySelector('p')!.textContent]).toEqual([503, ReviewSignIn.NO_SERVICE])
  broken()
  // A connection service that cannot answer is the same: 503, never let in.
  dsh.refuse = 503
  const refused = await call('GET', '/review', { cookie: DSH_COOKIE })
  expect([refused.status, dom(refused.text).querySelector('p')!.textContent]).toEqual([503, ReviewSignIn.NO_SERVICE])
  // An older release does not end a newer hold.
  const other = new DshConnection()
  const first = route.signIn.use(dsh)
  route.signIn.use(other)
  first()
  const again = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await route.handle(again.req, again.res, 3083, 'page')
  expect(again.answer.status).toBe(200)
})

it('refuses a wrong Host and a foreign Origin with 403 on every address, before anything is read or written', async () => {
  await serve()
  put('actions.jsonl', [action()])
  const cookie = await signIn()
  const body = JSON.stringify({ job_id: 'job-1', comment: 'Should not be saved.' })
  const refusals: Record<string, string | undefined>[] = [
    { host: `evil.example:${port}` }, { host: '127.0.0.1' }, { host: `127.0.0.1:${port + 1}` }, { host: `192.168.1.5:${port}` },
    { origin: 'http://evil.example' }, { origin: `https://127.0.0.1:${port}` }, { origin: `http://localhost:${port}` }, { origin: 'null' },
  ]
  for (const headers of refusals) {
    const page = await call('GET', '/review', { cookie, ...headers })
    expect([headers, page.status]).toEqual([headers, 403])
    expect(page.text).not.toContain('The first job started.')
    const saved = await call('POST', '/review/comment', { origin: origin(), cookie, ...headers }, body)
    expect([headers, saved.status]).toEqual([headers, 403])
  }
  // The page's own checks refuse these before DSH is asked; DSH refuses what they let through, such as a fetch the browser marks cross-site.
  expect(dsh.asked).toHaveLength(0)
  // A page opened from a link on another site is refused by DSH and shown the signed-out line, never the job; a post from another site is a plain 403.
  const crossSite = await call('GET', '/review', { cookie, 'sec-fetch-site': 'cross-site' })
  expect(crossSite.text).not.toContain('The first job started.')
  expect([crossSite.status, dom(crossSite.text).querySelector('p')!.textContent]).toEqual([401, ReviewSignIn.SIGNED_OUT])
  const crossPost = await call('POST', '/review/comment', { origin: origin(), cookie, 'sec-fetch-site': 'cross-site' }, body)
  expect(crossPost.status).toBe(403)
  dsh.refuse = 403
  expect((await call('GET', '/review', { cookie })).status).toBe(401)
  expect((await call('POST', '/review/talk', { origin: origin(), cookie, 'content-type': 'application/json' }, body)).status).toBe(403)
  dsh.refuse = undefined
  // A request that changes something must say where it comes from: a browser always does, so one without an Origin is not the page, signed in or not.
  for (const path of ['/review/comment', '/review/talk']) {
    const answer = await call('POST', path, { cookie, 'content-type': 'application/json' }, body)
    expect([path, answer.status, JSON.parse(answer.text)]).toEqual([path, 403, { error: 'A request that changes something must come from the review page itself' }])
  }
  expect(existsSync(file('reviews.jsonl'))).toBe(false)
  expect(existsSync(talkRoot())).toBe(false)
})

/** A request handed straight to the route, so the test can say which address the caller connects from. */
function direct(remoteAddress: string | undefined, method: string, headers: Record<string, string>, body = '') {
  const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: '/review', socket: { remoteAddress }, headers: { host: '127.0.0.1:3083', ...headers } })
  const resume = vi.spyOn(req, 'resume')
  const answer = { status: 0, headers: {} as Record<string, string>, text: '' }
  const res = { writeHead: (status: number, sent: Record<string, string>) => { answer.status = status; answer.headers = sent }, end: (text = '') => { answer.text = text } }
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, answer, resume }
}

it('refuses a caller whose address is not loopback, whatever its Host header and DSH cookie say', async () => {
  put('actions.jsonl', [action()])
  const route = new ReviewRoute([project], new SharedTokenFile(tokenPath()), new FactoryRecordsModule(recordsModule(root)), () => new Date(NOW))
  route.signIn.use(dsh)
  // DSH's own cookie, which DSH lets in.
  const cookie = DSH_COOKIE
  const body = JSON.stringify({ job_id: 'job-1', comment: 'Should not be saved.' })
  for (const address of ['192.168.1.9', '10.0.0.1', '::ffff:192.168.1.9', 'fe80::1', '127.0.0.2', '', undefined]) {
    const page = direct(address, 'GET', { cookie })
    await route.handle(page.req, page.res, 3083, 'page')
    expect([address, page.answer.status]).toEqual([address, 403])
    expect(page.answer.text).not.toContain('The first job started.')
    const saved = direct(address, 'POST', { origin: 'http://127.0.0.1:3083', cookie }, body)
    await route.handle(saved.req, saved.res, 3083, 'comment')
    expect([address, saved.answer.status, JSON.parse(saved.answer.text)]).toEqual([address, 403, { error: 'Loopback request required' }])
    // The upload it did not read is thrown away.
    expect(saved.resume).toHaveBeenCalled()
  }
  expect(existsSync(file('reviews.jsonl'))).toBe(false)
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const page = direct(address, 'GET', { cookie })
    await route.handle(page.req, page.res, 3083, 'page')
    expect([address, page.answer.status]).toEqual([address, 200])
  }
})

it('lists the projects, then the picked project\'s jobs newest first; shows a job\'s lines in time order and an always-open comment field with its newest comment', async () => {
  const other = join(root, 'other')
  mkdirSync(join(other, FactoryRecordFile.FOLDER), { recursive: true })
  await serve([project, other])
  // An older job in the first project, and the newest job in the second, its lines written out of time order.
  put('actions.jsonl', [action()])
  put('reviews.jsonl', [review()])
  put('actions.jsonl', [
    action({ project: other, job_id: 'job-2', step_id: 'step-b', ts: '2026-11-26T11:30:00.000Z', kind: 'job_stop', summary: 'Second line of the newest job.' }),
    action({ project: other, job_id: 'job-2', step_id: 'step-a', ts: '2026-11-26T11:00:00.000Z', summary: 'First line of the newest job.' }),
    action({ project: other, job_id: 'job-0', step_id: 'step-z', ts: '2026-11-25T07:00:00.000Z', summary: 'The oldest job.' }),
  ], other)
  put('reviews.jsonl', [
    review({ project: other, job_id: 'job-2', ts: '2026-11-26T11:40:00.000Z', comment: 'An earlier comment.' }),
    review({ project: other, job_id: 'job-2', ts: '2026-11-26T11:50:00.000Z', comment: 'The newest comment <b>&</b> "quoted".' }),
    review({ project: other, job_id: 'job-0', ts: '2026-11-26T11:55:00.000Z', comment: 'On another job.' }),
  ], other)
  const cookie = await signIn()
  // With nothing picked: the first listed project and its newest job.
  const answer = await call('GET', '/review', { cookie })
  expect(answer.status).toBe(200)
  const first = dom(answer.text)
  expect([...first.querySelectorAll('nav a.proj')].map(link => [link.textContent, link.getAttribute('title'), link.getAttribute('href'), link.getAttribute('aria-current')]))
    .toEqual([['project', project, ReviewRoute.address(project), 'page'], ['other', other, ReviewRoute.address(other), null]])
  expect([...first.querySelectorAll('nav a.job')].map(link => link.firstElementChild!.textContent)).toEqual(['Job 1'])
  expect([first.querySelector('ol li div')!.textContent, first.querySelector('textarea')!.value]).toEqual(['The first job started.', 'Keep it small.'])
  // The second project: its jobs newest first, numbered from the oldest, and its newest job shown.
  const page = dom((await call('GET', ReviewRoute.address(other), { cookie })).text)
  expect([...page.querySelectorAll('nav a.job')].map(link => [link.getAttribute('href'), link.firstElementChild!.textContent, link.getAttribute('aria-current')]))
    .toEqual([[ReviewRoute.address(other, 'job-2'), 'Job 2', 'page'], [ReviewRoute.address(other, 'job-0'), 'Job 1', null]])
  expect([...page.querySelectorAll('ol li')].map(row => [row.querySelector('time')!.getAttribute('datetime'), row.querySelector('strong')!.textContent, row.querySelector('div')!.textContent]))
    .toEqual([['2026-11-26T11:00:00.000Z', 'Job started', 'First line of the newest job.'], ['2026-11-26T11:30:00.000Z', 'Job stopped', 'Second line of the newest job.']])
  expect(page.querySelector('.crumb')!.textContent).toMatch(/^other › Job 2 · .* · 30 min$/)
  const field = page.querySelector('textarea')!
  expect([field.id, field.dataset.job, field.value, field.disabled, field.readOnly]).toEqual(['comment', 'job-2', 'The newest comment <b>&</b> "quoted".', false, false])
  // The comment is text in the field, never markup of the page.
  expect(page.querySelector('b')).toBeNull()
  expect(page.querySelector('#comment-status')!.textContent).toBe('')
  // No form, no dialog, and no button but the review talk's: the field saves by itself.
  expect([page.querySelector('form'), page.querySelector('dialog'), page.querySelector('input')]).toEqual([null, null, null])
  expect([...page.querySelectorAll('button')].map(button => button.textContent)).toEqual([ReviewPage.START_TALK])
  // A job without a stop says so in place of its duration.
  const older = dom((await call('GET', ReviewRoute.address(other, 'job-0'), { cookie })).text)
  expect([older.querySelector('ol li div')!.textContent, older.querySelector('textarea')!.value, older.querySelector('.crumb')!.textContent])
    .toEqual(['The oldest job.', 'On another job.', expect.stringMatching(/^other › Job 1 · .* · ended without a stop$/)])
  // A job asked for by its id alone is looked for in every project.
  expect(dom((await call('GET', '/review?job=job-2', { cookie })).text).querySelector('textarea')!.dataset.job).toBe('job-2')
  const unknown = await call('GET', '/review?job=nope', { cookie })
  expect([unknown.status, dom(unknown.text).querySelector('textarea')]).toEqual([404, null])
  const notListed = await call('GET', ReviewRoute.address(join(root, 'elsewhere')), { cookie })
  expect([notListed.status, dom(notListed.text).querySelector('p')!.textContent]).toEqual([404, 'That project is not listed'])
  // The token is in no page.
  for (const text of [answer.text, unknown.text]) expect(text).not.toContain(TOKEN)
})

it('lets the page load nothing but its own style and script, and names only DSH\'s design tokens for its look', async () => {
  await serve()
  put('actions.jsonl', [action()])
  const answer = await call('GET', '/review', { cookie: await signIn() })
  const policy = String(answer.headers['content-security-policy'])
  const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)![1]!
  expect(policy).toBe(`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`)
  expect([answer.headers['cache-control'], answer.headers['x-content-type-options'], answer.headers['x-frame-options'], answer.headers['referrer-policy'], answer.headers['content-type']])
    // same-origin, not no-referrer: under no-referrer a browser may send Origin: null with the page's own posts, which admit refuses (owner's check, story 3.1).
    .toEqual(['no-store', 'nosniff', 'DENY', 'same-origin', 'text/html; charset=utf-8'])
  const page = dom(answer.text)
  expect([page.querySelectorAll('script').length, page.querySelector('script')!.getAttribute('nonce'), page.querySelector('style')!.getAttribute('nonce')]).toEqual([1, nonce, nonce])
  expect([page.querySelector('script[src]'), page.querySelector('link'), page.querySelector('img'), page.querySelector('[style]')]).toEqual([null, null, null, null])
  // A new nonce for each answer.
  expect(String((await call('GET', '/review', {})).headers['content-security-policy'])).not.toContain(nonce)
  // Every colour comes from a DSH token: no colour value of the page's own.
  const style = page.querySelector('style')!.textContent
  expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb|hsl|\b(?:red|green|blue|black|white|gr[ae]y)\b/)
  for (const [, name] of style.matchAll(/var\((--[a-z0-9-]+)/g)) expect(name).toMatch(/^--dsw-alias-|^--ds-font-family-code$/)
  expect(style).toContain('var(--dsw-alias-label-primary)')
})

it('carries its whole look in the one style its policy allows: three panels on one screen, and a colour to fall back on behind every DSH token', async () => {
  await serve()
  put('actions.jsonl', [action()])
  const answer = await call('GET', '/review', { cookie: await signIn() })
  // The style is the page's own, inside it, with the nonce the policy allows a style to carry: nothing else could load under `default-src 'none'`.
  const nonce = /style-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(String(answer.headers['content-security-policy']))![1]!
  const page = dom(answer.text)
  expect([page.querySelectorAll('style').length, page.querySelector('style')!.getAttribute('nonce'), page.querySelector('link')]).toEqual([1, nonce, null])
  const style = page.querySelector('style')!.textContent
  // One screen with no page scroll: a 44px top bar as the body's first row, then the panels, up to 240px, the room left, up to 380px, each scrolling on its own.
  for (const rule of [
    'html, body { height: 100%; margin: 0; }',
    'grid-template-rows: auto auto auto minmax(0, 1fr);',
    'body > h1, body > .tabs, body > .crumb, body > .head { grid-row: 1; height: 44px; }',
    // The panels always fit the window: the middle gives way first, then the sides narrow, so the step detail is never cut off.
    '.cols.with-detail { grid-template-columns: clamp(160px, 20vw, 240px) minmax(0, 1fr) clamp(240px, 30vw, 380px); }',
    '.cols > * { min-width: 0; min-height: 0; overflow: auto;',
    // The comment field takes the height the step detail leaves, never under 120px.
    '.detail > .comment { flex: 1 0 auto; display: flex; flex-direction: column; min-height: 120px;',
    // A proposal's before and after are two equal halves, each scrolling.
    '.halves { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }',
    '.diff del.line { text-decoration: line-through;',
  ]) expect(style).toContain(rule)
  // The markup those rules lay out: the three panels as the grid's children, and the comment field as the detail panel's own child.
  expect([...page.querySelectorAll('body > .cols.with-detail > *')].map(each => each.tagName)).toEqual(['NAV', 'MAIN', 'ASIDE'])
  expect([page.querySelector('body > h1')!.textContent, page.querySelector('body > nav.tabs a.on')!.textContent, page.querySelector('aside.detail > .comment > textarea') === null]).toEqual(['Review', ReviewPage.TAB_JOBS, false])
  const read: GuidelineRead = { folder: '/factory/guideline', versions: [{ version: 1, date: null, from_job: null, from_version: null, text: 'Old line.\n' }], current: null, reason: null }
  read.current = read.versions[0]!
  const open: GuidelineProposal = { project, job_id: 'job-1', number: 1, text: 'New line.\n', ts: NOW }
  const proposal = dom(new ReviewPage('n').guideline(read, undefined, [open], open))
  expect([proposal.querySelectorAll('main.proposal > .halves > section').length, proposal.querySelector('.halves del.line')!.textContent, proposal.querySelector('.halves ins.line')!.textContent])
    .toEqual([2, 'Old line.', 'New line.'])
  expect(dom(new ReviewPage('n').guideline(read, read.versions[0])).querySelector('main')!.className).toBe('')
  // DSH's client does not run in this page, so no token is defined in it. Every token is followed by the colour to show without it. The one
  // exception is the body's text colour, which the browser drops when the token is missing: the body then takes the colour set on `html`.
  const uses = [...style.matchAll(/var\(--dsw-alias-[a-z0-9-]+(\)|, )/g)].map(([, end]) => end)
  expect([uses.length > 20, uses.filter(end => end === ')').length]).toEqual([true, 1])
  expect(style).toContain('html { color: CanvasText;')
  expect(style).toMatch(/\nbody \{[^}]* color: var\(--dsw-alias-label-primary\);/)
  // The colours behind the tokens are the browser's own, which follow light and dark by themselves; the page still picks none.
  expect(style).not.toMatch(/min-width: [1-9]/)
  expect(style).toContain(':root { color-scheme: light dark; }')
  for (const [, fallback] of style.matchAll(/var\(--dsw-alias-[a-z0-9-]+, ((?:[^()]|\([^()]*\))+)\)/g)) expect(fallback).toMatch(/^(?:Canvas|CanvasText|LinkText|color-mix\(in oklab, CanvasText \d+%, Canvas\))$/)
  expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
})

it('folds the left panel into the top bar in a narrow window: the same links behind one disclosure, with no form and no script', async () => {
  await serve()
  put('actions.jsonl', [action(), action({ job_id: 'job-2', step_id: 'step-2', ts: '2026-11-26T09:00:00.000Z' })])
  const page = dom((await call('GET', ReviewRoute.address(project, 'job-1'), { cookie: await signIn() })).text)
  const fold = page.querySelector('body > details.fold')!
  // It names what is open now, and holds every link of the left panel, with the panel's own addresses, texts and marks.
  const linksOf = (within: Element) => [...within.querySelectorAll('a')].map(link => [link.className, link.getAttribute('href'), link.getAttribute('aria-current'), link.textContent])
  const panel = linksOf(page.querySelector('.cols > nav.left')!)
  expect(fold.querySelector('summary')!.textContent).toBe('project · Job 1')
  expect(linksOf(fold.querySelector('.left')!)).toEqual(panel)
  expect(panel.filter(([name]) => name!.startsWith('job')).map(([name, href]) => [name, href]))
    .toEqual([['job fresh', ReviewRoute.address(project, 'job-2')], ['job fresh on', ReviewRoute.address(project, 'job-1')]])
  expect([fold.hasAttribute('open'), fold.querySelector('.left')!.getAttribute('aria-label'), page.querySelector('form, select, input')]).toEqual([false, 'Projects and jobs', null])
  // In the page's text it sits where it is drawn: after the tabs and before the line that says where the owner is; the proposal notice comes after both.
  expect([...page.body.children].filter(each => each.tagName !== 'SCRIPT').map(each => each.id !== '' ? `#${each.id}` : `${each.tagName.toLowerCase()}.${each.className}`))
    .toEqual(['h1.', 'nav.tabs', 'details.fold', 'div.head', '#talk-notice', '#proposal-notice', 'div.cols with-detail'])
  // The line that says where the owner is may be cut short in the bar, so its whole text is its tooltip.
  expect(page.querySelector('.crumb')!.getAttribute('title')).toBe(page.querySelector('.crumb')!.textContent)
  // The style shows the fold and hides the panel under 1100px only, and the panels left take the whole width.
  const style = page.querySelector('style')!.textContent
  expect(style).toContain('.fold { display: none;')
  expect(style).toContain('@media (max-width: 1100px) { .fold { display: block; } .cols > .left { display: none; } .cols { grid-template-columns: minmax(0, 1fr); } .cols.with-detail { grid-template-columns: minmax(0, 1fr) clamp(240px, 30vw, 380px); } }')
  // The Guideline tab folds its versions, and a waiting proposal, the same way.
  const read: GuidelineRead = { folder: '/factory/guideline', versions: [2, 1].map(version => ({ version, date: null, from_job: null, from_version: null, text: 'Text.\n' })), current: null, reason: null }
  read.current = read.versions[0]!
  const open: GuidelineProposal = { project, job_id: 'job-1', number: 1, text: 'New.\n', ts: NOW }
  const versions = dom(new ReviewPage('n').guideline(read, read.versions[1], [open]))
  expect(versions.querySelector('details.fold summary')!.textContent).toBe('v1')
  expect(linksOf(versions.querySelector('details.fold .left')!)).toEqual(linksOf(versions.querySelector('.cols > nav.left')!))
  expect(linksOf(versions.querySelector('details.fold .left')!).map(([name, href]) => [name, href]))
    .toEqual([['proposal', ReviewRoute.proposalAddress(project, 'job-1')], ['version', ReviewRoute.guidelineAddress(2)], ['version on', ReviewRoute.guidelineAddress(1)]])
  expect(dom(new ReviewPage('n').guideline(read, undefined, [open], open)).querySelector('details.fold summary')!.textContent).toBe('Proposal · project job 1')
  // A page with nothing in its left panel has no fold.
  expect(dom(new ReviewPage('n').guideline({ folder: null, versions: [], current: null, reason: 'x' }, undefined)).querySelector('details')).toBeNull()
})

it('says there is no job yet when the project holds none, and skips lines it cannot read', async () => {
  await serve([project, join(root, 'missing')])
  const cookie = await signIn()
  const empty = await call('GET', '/review', { cookie })
  expect([empty.status, dom(empty.text).querySelector('p')!.textContent, dom(empty.text).querySelector('textarea')]).toEqual([200, ReviewPage.NO_JOB, null])
  // Only lines that are no job log line.
  put('actions.jsonl', ['not json', '[1]', '{"job_id":"job-1"}'])
  expect(dom((await call('GET', '/review', { cookie })).text).querySelector('p')!.textContent).toBe(ReviewPage.NO_JOB)
  put('actions.jsonl', ['not json', action(), '{"job_id":"job-1","ts":7}'])
  put('reviews.jsonl', ['{', review(), '{"job_id":"job-1","ts":"2026-11-26T10:00:00.000Z"}'])
  const page = dom((await call('GET', '/review', { cookie })).text)
  expect([page.querySelectorAll('ol li').length, page.querySelector('textarea')!.value]).toEqual([1, 'Keep it small.'])
})

it('saves a comment: the masked line is appended last to the job\'s project reviews.jsonl, and a reload shows it', async () => {
  const other = join(root, 'other')
  mkdirSync(join(other, FactoryRecordFile.FOLDER), { recursive: true })
  await serve([other, project])
  put('actions.jsonl', [action()])
  put('reviews.jsonl', [review()])
  const cookie = await signIn()
  const answer = await comment(cookie, { job_id: 'job-1', comment: `Reject this; never print ${PLANTED}.` })
  expect([answer.status, JSON.parse(answer.text), answer.headers['content-type']]).toEqual([200, { saved: true }, 'application/json; charset=utf-8'])
  const written = lines('reviews.jsonl')
  expect(written).toHaveLength(2)
  expect(JSON.parse(written[1]!)).toEqual({ ts: NOW, project, job_id: 'job-1', comment: `Reject this; never print ${REDACTED}.` })
  expect(Object.keys(JSON.parse(written[1]!) as object)).toEqual(['ts', 'project', 'job_id', 'comment'])
  expect(readFileSync(file('reviews.jsonl'), 'utf8')).not.toContain(PLANTED)
  // The earlier line is still there, and nothing went to the other listed project.
  expect(JSON.parse(written[0]!)).toEqual(review())
  expect(existsSync(file('reviews.jsonl', other))).toBe(false)
  // The first listed project has no job yet; the job is found by its id.
  expect(dom((await call('GET', '/review', { cookie })).text).querySelector('main p')!.textContent).toBe(ReviewPage.NO_JOB)
  expect(dom((await call('GET', '/review?job=job-1', { cookie })).text).querySelector('textarea')!.value).toBe(`Reject this; never print ${REDACTED}.`)
})

it('saves a comment on the shown project\'s job when another listed project holds the same job_id', async () => {
  const other = join(root, 'other')
  mkdirSync(join(other, FactoryRecordFile.FOLDER), { recursive: true })
  await serve([other, project])
  put('actions.jsonl', [action({ project: other })], other)
  put('actions.jsonl', [action()])
  const cookie = await signIn()
  const field = dom((await call('GET', ReviewRoute.address(project, 'job-1'), { cookie })).text).querySelector('textarea')!
  expect([field.getAttribute('data-project'), field.getAttribute('data-job')]).toEqual([project, 'job-1'])
  // The body the page's own script sends.
  const answer = await comment(cookie, { project: field.getAttribute('data-project'), job_id: field.getAttribute('data-job'), comment: 'For this project.' })
  expect(answer.status).toBe(200)
  expect(JSON.parse(lines('reviews.jsonl')[0]!)).toEqual({ ts: NOW, project, job_id: 'job-1', comment: 'For this project.' })
  expect(existsSync(file('reviews.jsonl', other))).toBe(false)
  // A project that is not listed, or not text, is refused and nothing is written.
  expect((await comment(cookie, { project: join(root, 'unlisted'), job_id: 'job-1', comment: 'Nowhere.' })).status).toBe(404)
  expect((await comment(cookie, { project: 7, job_id: 'job-1', comment: 'Nowhere.' })).status).toBe(400)
  expect(lines('reviews.jsonl')).toHaveLength(1)
  expect(existsSync(file('reviews.jsonl', other))).toBe(false)
})

it('saves nothing without DSH\'s sign-in: no DSH cookie or one DSH refuses is 401', async () => {
  await serve()
  put('actions.jsonl', [action()])
  for (const cookie of [undefined, 'dsh-auth-c2lnbmVkLWluLWJ5LWRzaA=forged']) {
    const answer = await comment(cookie, { job_id: 'job-1', comment: 'Should not be saved.' })
    expect([answer.status, JSON.parse(answer.text)]).toEqual([401, { error: ReviewSignIn.SIGNED_OUT }])
  }
  expect(existsSync(file('reviews.jsonl'))).toBe(false)
})

it('refuses a bad comment and writes nothing: empty text 400, an unknown job 404, a body over 64 KiB 413', async () => {
  await serve()
  put('actions.jsonl', [action()])
  const cookie = await signIn()
  const bad: [unknown, number, string][] = [
    [{ job_id: 'job-1', comment: '' }, 400, 'comment must be non-empty text'],
    [{ job_id: 'job-1', comment: ' \n\t' }, 400, 'comment must be non-empty text'],
    [{ job_id: 'job-1' }, 400, 'comment must be non-empty text'],
    [{ job_id: 'job-1', comment: 7 }, 400, 'comment must be non-empty text'],
    [{ comment: 'No job named.' }, 400, 'job_id must be non-empty text'],
    [{ job_id: '', comment: 'No job named.' }, 400, 'job_id must be non-empty text'],
    ['not json', 400, 'The request body is not JSON'],
    ['["job-1", "a comment"]', 400, 'The request body must be an object'],
    ['null', 400, 'The request body must be an object'],
    [{ job_id: 'job-9', comment: 'On a job nobody recorded.' }, 404, 'No listed project holds that job'],
    [{ job_id: 'job-1', comment: 'x'.repeat(ReviewRoute.MAX_BODY_BYTES) }, 413, `Request exceeds ${ReviewRoute.MAX_BODY_BYTES} bytes`],
  ]
  for (const [body, status, error] of bad) {
    const answer = await comment(cookie, body)
    expect([status, answer.status, JSON.parse(answer.text)]).toEqual([status, status, { error }])
  }
  // Sent in chunks, without a length up front: still refused, and the caller still gets the answer.
  const chunked = await comment(cookie, { job_id: 'job-1', comment: 'x'.repeat(ReviewRoute.MAX_BODY_BYTES) }, { 'transfer-encoding': 'chunked' })
  expect(chunked.status).toBe(413)
  expect(ReviewRoute.MAX_BODY_BYTES).toBe(64 * 1024)
  // The largest comment that fits is taken.
  expect((await comment(cookie, { job_id: 'job-1', comment: 'x'.repeat(ReviewRoute.MAX_BODY_BYTES - 100) })).status).toBe(200)
  expect(lines('reviews.jsonl')).toHaveLength(1)
})

it('answers 405 to the wrong method on each address', async () => {
  await serve()
  const cookie = await signIn()
  for (const [method, path, allow] of [['POST', '/review', 'GET'], ['PUT', '/review', 'GET'], ['DELETE', '/review/comment', 'POST'], ['PUT', '/review/talk', 'POST']] as const) {
    const answer = await call(method, path, { origin: origin(), cookie }, '{}')
    expect([method, path, answer.status, answer.headers.allow]).toEqual([method, path, 405, allow])
  }
  for (const path of ['/review/talk', '/review/comment']) expect([path, (await call('GET', path, { cookie })).status]).toEqual([path, 405])
})

it('answers 503 and writes nothing without a working records module, and 409 when the project lost its .factory folder', async () => {
  await serve([project], new FactoryRecordsModule())
  put('actions.jsonl', [action()])
  const cookie = await signIn()
  const page = await call('GET', '/review', { cookie })
  expect([page.status, dom(page.text).querySelector('p')!.textContent]).toEqual([503, 'No recordsModule is configured, so no job log line or comment is written or read'])
  const saved = await comment(cookie, { job_id: 'job-1', comment: 'Should not be saved.' })
  expect([saved.status, JSON.parse(saved.text)]).toEqual([503, { error: 'No recordsModule is configured, so no job log line or comment is written or read' }])
  expect(existsSync(file('reviews.jsonl'))).toBe(false)
  await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
  // A reader that still knows the job, though the folder is gone when the comment is written.
  const kept = JSON.stringify([{ project, jobs: [{ project, job_id: 'job-1', number: 1, started: NOW, stopped: null, last: NOW, steps: [], reviews: [] }], outside: [] }])
  await serve([project], new FactoryRecordsModule(recordsModule(root, `export const JobLogMask = { forProject: () => ({ maskAction: line => line, maskReview: line => line }) }
export class JobsReader { read() { return ${kept} } }\n`)))
  rmSync(join(project, FactoryRecordFile.FOLDER), { recursive: true })
  const refused = await comment(await signIn(), { job_id: 'job-1', comment: 'Should not be saved.' })
  expect([refused.status, JSON.parse(refused.text)]).toEqual([409, { error: 'The project has no .factory folder yet' }])
  expect(existsSync(join(project, FactoryRecordFile.FOLDER))).toBe(false)
})

it('puts every text of a record into the page as text, never as markup: a summary, a job id in the field and in a link', async () => {
  await serve()
  const odd = 'job "x"&y'
  put('actions.jsonl', [action({ summary: '<b>bold</b> & "q"' }), action({ job_id: odd, step_id: 'step-2', ts: '2026-11-25T08:00:00.000Z', summary: '<img src=x onerror=alert(1)>' })])
  const cookie = await signIn()
  const page = dom((await call('GET', '/review', { cookie })).text)
  expect(page.querySelector('ol li div')!.textContent).toBe('<b>bold</b> & "q"')
  expect([page.querySelector('b'), page.querySelector('img')]).toEqual([null, null])
  const href = page.querySelector('nav a.job:not(.on)')!.getAttribute('href')!
  expect(new URL(href, origin()).searchParams.get('job')).toBe(odd)
  // The link leads to that job, whose id is the field's, raw.
  const other = dom((await call('GET', href, { cookie })).text)
  expect([other.querySelector('textarea')!.dataset.job, other.querySelector('ol li div')!.textContent]).toEqual([odd, '<img src=x onerror=alert(1)>'])
  expect([other.querySelector('img'), other.querySelectorAll('textarea').length]).toEqual([null, 1])
})

it('shows the last comment line of a job, whatever the times say', async () => {
  await serve()
  put('actions.jsonl', [action()])
  // The clock was set back between the two comments.
  put('reviews.jsonl', [review({ ts: '2026-11-26T10:00:00.000Z', comment: 'Written first.' }), review({ ts: '2026-11-26T09:00:00.000Z', comment: 'Written last.' })])
  expect(dom((await call('GET', '/review', { cookie: await signIn() })).text).querySelector('textarea')!.value).toBe('Written last.')
})

it('shows the comment on the whole job, not a later comment on one of its steps', async () => {
  await serve()
  put('actions.jsonl', [action()])
  put('reviews.jsonl', [review({ comment: 'On the whole job.' }), review({ ts: '2026-11-26T10:00:00.000Z', step_id: 'step-1', comment: 'On one step.' })])
  expect(dom((await call('GET', '/review', { cookie: await signIn() })).text).querySelector('textarea')!.value).toBe('On the whole job.')
})

it('answers 500 with one fixed text when something else fails, and repeats nothing of the error', async () => {
  await serve([project], new FactoryRecordsModule(recordsModule(root, `export const JobLogMask = { forProject: () => ({ maskAction: line => line, maskReview: line => line }) }
export class JobsReader { read() { throw new Error(${JSON.stringify(PLANTED)}) } }\n`)))
  const cookie = await signIn()
  const page = await call('GET', '/review', { cookie })
  expect([page.status, dom(page.text).querySelector('p')!.textContent]).toEqual([500, 'The review page failed'])
  const failed = await comment(cookie, { job_id: 'job-1', comment: 'Should not be saved.' })
  expect([failed.status, JSON.parse(failed.text)]).toEqual([500, { error: 'The review page failed' }])
  await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
  // The write path: a folder where reviews.jsonl belongs makes the open fail with an error that is no refusal.
  await serve()
  put('actions.jsonl', [action()])
  mkdirSync(file('reviews.jsonl'))
  const unwritten = await comment(await signIn(), { job_id: 'job-1', comment: `Never print ${PLANTED}.` })
  expect([unwritten.status, JSON.parse(unwritten.text)]).toEqual([500, { error: 'The review page failed' }])
  for (const text of [page.text, failed.text, unwritten.text]) for (const leaked of [PLANTED, project, 'EISDIR']) expect(text).not.toContain(leaked)
})

it('cuts the connection, and does not throw, when something fails after the answer was begun', async () => {
  const route = new ReviewRoute([project], new SharedTokenFile(tokenPath()), new FactoryRecordsModule(recordsModule(root)), () => new Date(NOW))
  route.signIn.use(dsh)
  const { req } = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  const writeHead = vi.fn(), destroy = vi.fn()
  // The headers went out, then ending the answer fails.
  const res = { headersSent: false, writeHead: (...sent: unknown[]) => { writeHead(...sent); res.headersSent = true }, end: () => { throw new Error('broken pipe') }, destroy }
  await expect(route.handle(req, res as unknown as ServerResponse, 3083, 'page')).resolves.toBeUndefined()
  expect([writeHead.mock.calls.length, destroy.mock.calls.length]).toEqual([1, 1])
})

/** The page of one job in a browser stand-in whose `fetch` is the test's, with the page's script running. */
function browser(job: { job_id?: string; comment?: string }, fetch: (url: string, init: { method: string; body: string; credentials: string; headers: Record<string, string> }) => Promise<{ ok: boolean }>) {
  const jobId = job.job_id ?? 'job-1'
  const reviews = job.comment === undefined ? [] : [review({ job_id: jobId, comment: job.comment })]
  const shown: RecordedJob = { project, job_id: jobId, number: 1, started: NOW, stopped: null, last: NOW, steps: [{ automatic: false, ts: NOW, line: action({ job_id: jobId }) }], reviews }
  const entry: ProjectJobs = { project, jobs: [shown], outside: [] }
  const html = new ReviewPage('nonce').view({ projects: [entry], project: entry, job: shown, outside: false })
  const window = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:3083/review', beforeParse: view => { (view as unknown as { fetch: unknown }).fetch = fetch } }).window
  const field = window.document.querySelector('textarea')!
  const status = () => window.document.querySelector('#comment-status')!.textContent
  const type = (text: string) => { field.value = text; field.dispatchEvent(new window.Event('input')) }
  const leave = () => { field.dispatchEvent(new window.Event('blur')) }
  return { window, field, status, type, leave }
}
/** Lets the page's script run on after an answer arrived. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })

it('saves the comment when the owner leaves the field, showing "Saving…" then "Saved", and sends nothing for an unchanged or emptied field', async () => {
  const sent: { url: string; method: string; body: unknown; credentials: string; type: string | undefined }[] = []
  let answer: (ok: boolean) => void = () => {}
  const page = browser({ comment: 'Kept from before.' }, (url, init) => {
    sent.push({ url, method: init.method, body: JSON.parse(init.body), credentials: init.credentials, type: init.headers['content-type'] })
    return new Promise(resolve => { answer = ok => { resolve({ ok }) } })
  })
  expect([page.field.value, page.status()]).toEqual(['Kept from before.', ''])
  // Leaving the field as it was sends nothing.
  page.leave()
  expect(sent).toEqual([])
  page.type('Reject this at this stage.')
  page.leave()
  expect(page.status()).toBe('Saving…')
  expect(sent).toEqual([{ url: '/review/comment', method: 'POST', body: { project, job_id: 'job-1', comment: 'Reject this at this stage.' }, credentials: 'same-origin', type: 'application/json' }])
  answer(true)
  await settle()
  expect(page.status()).toBe('Saved')
  // Saved text is not sent a second time; an emptied field is not sent at all, and its text is not replaced.
  page.leave()
  page.type('   ')
  page.leave()
  expect(sent).toHaveLength(1)
  page.window.close()
})

it('saves text typed while a save is under way with a second request, once the first is answered', async () => {
  const bodies: string[] = []
  const answers: ((ok: boolean) => void)[] = []
  const page = browser({}, (_url, init) => {
    bodies.push((JSON.parse(init.body) as { comment: string }).comment)
    return new Promise(resolve => { answers.push(ok => { resolve({ ok }) }) })
  })
  page.type('A')
  page.leave()
  page.type('AB')
  page.leave()
  // One request at a time: the second waits for the first answer.
  expect(bodies).toEqual(['A'])
  answers[0]!(true)
  await settle()
  expect([bodies, page.status()]).toEqual([['A', 'AB'], 'Saving…'])
  answers[1]!(true)
  await settle()
  expect([bodies, page.status()]).toEqual([['A', 'AB'], 'Saved'])
  page.window.close()
})

it('sends unsaved text when the page is left inside the pause, in a request the browser finishes after the page is gone', async () => {
  const sent: { url: string; comment: string; keepalive: unknown }[] = []
  const page = browser({ comment: 'Kept from before.' }, (url, init) => {
    sent.push({ url, comment: (JSON.parse(init.body) as { comment: string }).comment, keepalive: (init as { keepalive?: unknown }).keepalive })
    return Promise.resolve({ ok: true })
  })
  const hide = () => { page.window.dispatchEvent(new page.window.Event('pagehide')) }
  // Nothing new, or nothing at all: nothing is sent.
  hide()
  page.type('  ')
  hide()
  expect(sent).toEqual([])
  page.type('Typed just before the tab closed.')
  hide()
  expect(sent).toEqual([{ url: ReviewRoute.COMMENT_PATH, comment: 'Typed just before the tab closed.', keepalive: true }])
  // Sent once: neither a second leave nor the pause that was running sends it again.
  hide()
  page.leave()
  await settle()
  expect(sent).toHaveLength(1)
  page.window.close()
})

it('keeps the text and says so when a save fails, and tries again when the owner types', async () => {
  const outcomes: (boolean | Error)[] = [false, new Error('offline'), true]
  const bodies: string[] = []
  const page = browser({}, (_url, init) => {
    bodies.push((JSON.parse(init.body) as { comment: string }).comment)
    const outcome = outcomes.shift()!
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve({ ok: outcome })
  })
  for (const text of ['First try.', 'Second try.']) {
    page.type(text)
    page.leave()
    await settle()
    expect([page.status(), page.field.value]).toEqual(['Not saved. Your text is kept here; it is tried again when you type.', text])
  }
  page.type('Third try.')
  page.leave()
  await settle()
  expect([page.status(), bodies]).toEqual(['Saved', ['First try.', 'Second try.', 'Third try.']])
  page.window.close()
})

it('saves after a pause in typing, once, with the text as it is then', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const bodies: string[] = []
    // The page's timers are the test's fake ones, so the pause passes without waiting.
    const page = browser({}, (_url, init) => { bodies.push((JSON.parse(init.body) as { comment: string }).comment); return Promise.resolve({ ok: true }) })
    Object.assign(page.window, { setTimeout, clearTimeout })
    page.type('Keep')
    await vi.advanceTimersByTimeAsync(ReviewPage.PAUSE_MS - 1)
    page.type('Keep to the minimum feature.')
    await vi.advanceTimersByTimeAsync(ReviewPage.PAUSE_MS - 1)
    expect(bodies).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(bodies).toEqual(['Keep to the minimum feature.'])
    expect(page.status()).toBe('Saved')
    expect(ReviewPage.PAUSE_MS).toBe(1000)
    page.window.close()
  } finally { vi.useRealTimers() }
})

/**
 * A fake of the plugin's context. `connection` is DSH's connection service, or `undefined` when DSH has none: then the plugin's `ctx.inject` callback
 * never runs, as cordis runs it only while the service is there. `withdraw` takes the service away again, running what the callback left.
 */
function pluginContext(registered: Route[], connection: DshConnection | undefined, logger = { info: vi.fn(), warn: vi.fn() }) {
  const left: (() => unknown)[] = []
  const ctx = { webServer: { host: '127.0.0.1', port: 3083, register: (route: Route) => { registered.push(route); return () => {} } },
    effect: (effect: () => () => void) => effect(), logger, on: () => () => {},
    inject: (names: string[], callback: (child: unknown) => void) => {
      expect(names).toEqual(['connection', 'connection.authentication'])
      if (connection !== undefined) callback({ connection, effect: (effect: () => () => unknown) => { left.push(effect()) } })
      return () => {}
    } }
  return { ctx, withdraw: () => { for (const each of left.splice(0)) each() } }
}

it('is wired into the plugin: the page reads the configured token file and records module, and DSH\'s connection service signs the browser in', async () => {
  put('actions.jsonl', [action()])
  const registered: Route[] = []
  const info = vi.fn(), warn = vi.fn()
  const { ctx, withdraw } = pluginContext(registered, dsh, { info, warn })
  plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: tokenPath(), recordsModule: recordsModule(root) }))
  const handler = (path: string) => registered.find(route => route.path === path)!.handler
  expect(registered.map(route => route.path)).not.toContain('/review/login')
  const page = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await handler('/review')(page.req, page.res)
  expect([page.answer.status, page.answer.text.includes('The first job started.')]).toEqual([200, true])
  const unsigned = direct('127.0.0.1', 'GET', {})
  await handler('/review')(unsigned.req, unsigned.res)
  expect([unsigned.answer.status, dom(unsigned.answer.text).querySelector('p')!.textContent]).toEqual([401, ReviewSignIn.SIGNED_OUT])
  // When DSH takes its connection service away, the page answers nobody.
  withdraw()
  const after = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await handler('/review')(after.req, after.res)
  expect(after.answer.status).toBe(503)
  // The token reaches no log line.
  expect(info).toHaveBeenCalled()
  expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toContain(TOKEN)
  expect([plugin.ReviewRoute, plugin.ReviewPage, plugin.ReviewAccess, plugin.ReviewSignIn]).toEqual([ReviewRoute, ReviewPage, ReviewAccess, ReviewSignIn])
})

it('is wired into the plugin without DSH\'s connection service: the page refuses with a plain 503, and the proposal address still takes the token', async () => {
  put('actions.jsonl', [action()])
  const registered: Route[] = []
  const { ctx } = pluginContext(registered, undefined)
  plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: tokenPath(), recordsModule: recordsModule(root) }))
  const handler = (path: string) => registered.find(route => route.path === path)!.handler
  const page = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await handler('/review')(page.req, page.res)
  expect([page.answer.status, dom(page.answer.text).querySelector('p')!.textContent]).toEqual([503, ReviewSignIn.NO_SERVICE])
  expect(page.answer.text).not.toContain('The first job started.')
  // `/assess` is mounted whatever DSH's connection service does.
  expect(registered.map(route => route.path)).toContain('/assess')
  const proposed = direct('127.0.0.1', 'POST', { [SharedTokenFile.HEADER]: TOKEN, 'content-type': 'application/json' }, JSON.stringify({ job_id: 'job-1', text: 'x' }))
  await handler('/review/proposal')(proposed.req, proposed.res)
  // Past the token: refused only because job-1 has no talk.
  expect(proposed.answer.status).toBe(409)
})

it('is wired into the plugin for Accept and the guideline: with review.saveBranch set, sessions read that branch after the start fetch, and Accept merges the new version and the old one\'s trend report into it through the configured glab, leaving main untouched', async () => {
  const emptyConfig = join(root, 'gitconfig'); writeFileSync(emptyConfig, '')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  const TRIAL = 'zty3776/epic-3-guideline-trial'
  // A throwaway factory: a bare remote and a clone, the clone holding the records module so its guideline reader names the clone's folder.
  const bare = join(root, 'remote.git'), factory = join(root, 'factory'), other = join(root, 'other')
  git(root, 'init', '--bare', '--quiet', '--initial-branch=main', bare)
  git(root, 'clone', '--quiet', bare, factory)
  // The plugin's git reads the owner's global config: the clone's own settings decide identity and signing here.
  for (const [name, value] of [['user.name', 'Test Owner'], ['user.email', 'owner@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(factory, 'config', name!, value!)
  mkdirSync(join(factory, 'guideline'))
  writeFileSync(join(factory, 'guideline', 'v1.md'), '# Guideline\nKeep it small.\n')
  git(factory, 'add', 'guideline'); git(factory, 'commit', '--quiet', '-m', 'v1'); git(factory, 'push', '--quiet', 'origin', 'main', `main:refs/heads/${TRIAL}`)
  // Another session merged v2 on the trial branch, and main moved to a v5 of its own; the clone has not fetched them, and its checkout keeps v1.
  git(root, 'clone', '--quiet', bare, other)
  git(other, 'checkout', '--quiet', '-b', 'trial', `origin/${TRIAL}`)
  writeFileSync(join(other, 'guideline', 'v2.md'), '# Guideline\nKeep to the minimum feature.\n')
  git(other, 'add', '.'); git(other, '-c', 'user.name=Other', '-c', 'user.email=o@example.invalid', 'commit', '--quiet', '-m', 'v2'); git(other, 'push', '--quiet', 'origin', `HEAD:refs/heads/${TRIAL}`)
  git(other, 'checkout', '--quiet', '-b', 'later', 'origin/main')
  writeFileSync(join(other, 'guideline', 'v5.md'), '# Guideline\nMain only.\n')
  git(other, 'add', '.'); git(other, '-c', 'user.name=Other', '-c', 'user.email=o@example.invalid', 'commit', '--quiet', '-m', 'v5'); git(other, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
  const main = git(bare, 'rev-parse', 'main')
  const records = recordsModule(factory)
  writeFileSync(join(factory, 'proposeServer.js'), '// stand-in for the built propose server\n')
  put('actions.jsonl', [action({ guideline_version: 'v2' })])
  put('reviews.jsonl', [review()])
  // A stand-in for the factory's built guard, and for DSH's Sessions: the trend report's one-off thread answers with a fixed text.
  const guardModule = join(root, 'guard.mjs')
  writeFileSync(guardModule, 'export const JudgeToolGuard = { forHome: () => ({ check: () => undefined }) }\n')
  const threads = fakeDsh(() => 'Fewer wide approvals under v2.')
  // Stand-ins for orca and glab, named by the settings: glab's merge moves the merge request's target branch on the bare remote to the commit it
  // is given, as GitLab would.
  const orca = join(root, 'fake-orca')
  writeFileSync(orca, `#!/bin/sh\n[ "$2" = list ] && printf '%s' '{"result":{"repos":[]}}'\nexit 0\n`)
  const glab = join(root, 'fake-glab'), glabLog = join(root, 'fake-glab.log'), glabTarget = join(root, 'fake-glab.target')
  writeFileSync(glab, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${glabLog}'\n`
    + `if [ "$2" = create ]; then while [ $# -gt 0 ]; do if [ "$1" = --target-branch ]; then printf '%s' "$2" > '${glabTarget}'; fi; shift; done; echo 'https://gitlab.example/factory/-/merge_requests/9'; exit 0; fi\n`
    + `while [ $# -gt 0 ]; do if [ "$1" = --sha ]; then git --git-dir='${bare}' update-ref "refs/heads/$(cat '${glabTarget}')" "$2"; exit $?; fi; shift; done\nexit 1\n`)
  chmodSync(orca, 0o755); chmodSync(glab, 0o755)
  const registered: Route[] = []
  const { ctx } = pluginContext(registered, dsh)
  Object.assign(ctx, threads.ctx)
  const listeners: Record<string, (payload: { agent: unknown }) => Promise<unknown>> = {}
  Object.assign(ctx, { on: (name: string, listener: (payload: { agent: unknown }) => Promise<unknown>) => { listeners[name] = listener; return () => {} } })
  const root0 = TalkFolder.ROOT
  Object.assign(TalkFolder, { ROOT: talkRoot() })
  try { plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: tokenPath(), recordsModule: records, guardModule, review: { orca, glab, saveBranch: TRIAL } })) } finally { Object.assign(TalkFolder, { ROOT: root0 }) }
  // The start fetch runs in the background and brings the trial branch: wait for the clone's copy of it to reach v2.
  for (let tries = 0; git(factory, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${TRIAL}`) !== git(bare, 'rev-parse', TRIAL); tries++) {
    if (tries > 200) throw new Error('the start fetch never landed')
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  const sectionOf = async (id: string) => {
    const session = new Context()
    try {
      await session.plugin(SystemPrompt)
      await listeners['agent/created']!({ agent: { id, ctx: session } })
      return (await session.systemPrompt.assemble()).sections.find(section => section.name === plugin.GuidelineSection.NAME)?.text ?? ''
    } finally { await session.fiber.dispose() }
  }
  expect(await sectionOf('main-1')).toContain('version 2')
  expect(await sectionOf('main-1')).not.toContain('Main only.')
  // A talk, a proposal, then the owner's Accept through the plugin's own routes.
  const handler = (path: string) => registered.find(route => route.path === path)!.handler
  const talk = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083', cookie: DSH_COOKIE }, JSON.stringify({ project, job_id: 'job-1' }))
  await handler('/review/talk')(talk.req, talk.res)
  expect(talk.answer.status).toBe(200)
  const proposed = direct('127.0.0.1', 'POST', { [SharedTokenFile.HEADER]: TOKEN, 'content-type': 'application/json' }, JSON.stringify({ job_id: 'job-1', text: '# Guideline\nThree.\n' }))
  await handler('/review/proposal')(proposed.req, proposed.res)
  expect(proposed.answer.status).toBe(200)
  const asked = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await handler('/review/proposal')(asked.req, asked.res)
  const { ts } = (JSON.parse(asked.answer.text) as { waiting: { ts: string }[] }).waiting[0]!
  const accepted = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083', cookie: DSH_COOKIE }, JSON.stringify({ project, job_id: 'job-1', ts, answer: 'accept', base: 2 }))
  await handler('/review/answer')(accepted.req, accepted.res)
  expect([accepted.answer.status, JSON.parse(accepted.answer.text)]).toMatchObject([200, { answered: 'accepted', version: 3, mr: 'https://gitlab.example/factory/-/merge_requests/9' }])
  expect(git(bare, 'show', `${TRIAL}:guideline/v3.md`)).toContain('Three.')
  // The trend report of v2, the version Accept replaced, is in the same commit, written by one fresh thread that was asked about v2's job.
  expect(git(bare, 'show', '--name-only', '--format=', TRIAL).split('\n').sort()).toEqual(['guideline/v2-trends.md', 'guideline/v3.md'])
  const report = git(bare, 'show', `${TRIAL}:guideline/v2-trends.md`)
  expect(report).toMatch(/^---\nversion: 2\ndate: \d{4}-\d{2}-\d{2}\njobs: 1\ncompared_with: 1\nwritten: accepted\n---\n# Trend report for guideline v2\n\nCompared with v1\.\n\nFewer wide approvals under v2\.\n/)
  expect([threads.agents.size, [...threads.agents.values()][0]!.asked[0]]).toMatchObject([1, expect.stringContaining('## Jobs under v2 (1)')])
  // The merge request went into the trial branch, and was merged at the pushed commit.
  const glabLines = readFileSync(glabLog, 'utf8')
  expect(glabLines).toContain(`--target-branch ${TRIAL} `)
  expect(glabLines).not.toContain('--target-branch main')
  expect(glabLines).toContain(`mr merge 9 --repo ${bare} --yes --auto-merge=false --sha`)
  expect(readdirSync(join(factory, 'guideline'))).toEqual(['v1.md'])
  expect(await sectionOf('main-2')).toContain('version 3')
  // main: its commit and its guideline are as they were.
  expect([git(bare, 'rev-parse', 'main'), git(bare, 'ls-tree', '--name-only', 'main', 'guideline/').split('\n')]).toEqual([main, ['guideline/v1.md', 'guideline/v5.md']])
  expect([git(factory, 'worktree', 'list').split('\n').length, git(factory, 'branch', '--show-current'), git(factory, 'status', '--porcelain')])
    .toEqual([1, 'main', expect.not.stringContaining('guideline')])
})

it('is wired into the plugin with review.saveBranch unset: the guideline is read from main, and "Write trend report" and Accept refuse before any thread, git or glab', async () => {
  const emptyConfig = join(root, 'gitconfig'); writeFileSync(emptyConfig, '')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  const bare = join(root, 'remote.git'), factory = join(root, 'factory')
  git(root, 'init', '--bare', '--quiet', '--initial-branch=main', bare)
  git(root, 'clone', '--quiet', bare, factory)
  mkdirSync(join(factory, 'guideline'))
  writeFileSync(join(factory, 'guideline', 'v1.md'), '# Guideline\nFactory only.\n')
  git(factory, 'add', '.'); git(factory, '-c', 'user.name=Factory', '-c', 'user.email=f@example.invalid', 'commit', '--quiet', '-m', 'v1'); git(factory, 'push', '--quiet', 'origin', 'main')
  // A trial branch with a v2 of its own, which is not read while no save branch is set.
  git(factory, 'checkout', '--quiet', '-b', 'trial')
  writeFileSync(join(factory, 'guideline', 'v2.md'), '# Guideline\nTrial only.\n')
  git(factory, 'add', '.'); git(factory, '-c', 'user.name=Factory', '-c', 'user.email=f@example.invalid', 'commit', '--quiet', '-m', 'v2'); git(factory, 'push', '--quiet', 'origin', 'HEAD:refs/heads/zty3776/epic-3-guideline-trial')
  git(factory, 'checkout', '--quiet', 'main')
  const before = git(bare, 'rev-parse', 'main')
  const records = recordsModule(factory)
  put('actions.jsonl', [action({ guideline_version: 'v1' })])
  const guardModule = join(root, 'guard.mjs')
  writeFileSync(guardModule, 'export const JudgeToolGuard = { forHome: () => ({ check: () => undefined }) }\n')
  const threads = fakeDsh(() => 'never asked')
  writeFileSync(join(factory, 'proposeServer.js'), '// stand-in for the built propose server\n')
  put('reviews.jsonl', [review()])
  const glab = join(root, 'fake-glab'), glabLog = join(root, 'fake-glab.log')
  writeFileSync(glab, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${glabLog}'\nexit 1\n`)
  const orca = join(root, 'fake-orca')
  writeFileSync(orca, `#!/bin/sh\n[ "$2" = list ] && printf '%s' '{"result":{"repos":[]}}'\nexit 0\n`)
  chmodSync(glab, 0o755); chmodSync(orca, 0o755)
  const registered: Route[] = []
  const { ctx } = pluginContext(registered, dsh)
  Object.assign(ctx, threads.ctx)
  const listeners: Record<string, (payload: { agent: unknown }) => Promise<unknown>> = {}
  Object.assign(ctx, { on: (name: string, listener: (payload: { agent: unknown }) => Promise<unknown>) => { listeners[name] = listener; return () => {} } })
  const root0 = TalkFolder.ROOT
  Object.assign(TalkFolder, { ROOT: talkRoot() })
  try { plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: tokenPath(), recordsModule: records, guardModule, review: { orca, glab } })) } finally { Object.assign(TalkFolder, { ROOT: root0 }) }
  // Sessions start with main's guideline, as before.
  const session = new Context()
  try {
    await session.plugin(SystemPrompt)
    await listeners['agent/created']!({ agent: { id: 'main-1', ctx: session } })
    const text = (await session.systemPrompt.assemble()).sections.find(section => section.name === plugin.GuidelineSection.NAME)?.text
    expect([text, text]).toEqual([expect.stringContaining('Factory only.'), expect.not.stringContaining('Trial only.')])
  } finally { await session.fiber.dispose() }
  const handler = (path: string) => registered.find(route => route.path === path)!.handler
  const refused = { error: 'Not saved: no save branch is set (review.saveBranch)' }
  const asked = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083', cookie: DSH_COOKIE }, JSON.stringify({ version: 1 }))
  await handler('/review/trends')(asked.req, asked.res)
  expect([asked.answer.status, JSON.parse(asked.answer.text)]).toEqual([503, refused])
  // Accept, after a talk and a proposal, refuses the same way, and the proposal stays waiting.
  const talk = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083', cookie: DSH_COOKIE }, JSON.stringify({ project, job_id: 'job-1' }))
  await handler('/review/talk')(talk.req, talk.res)
  expect(talk.answer.status).toBe(200)
  const proposed = direct('127.0.0.1', 'POST', { [SharedTokenFile.HEADER]: TOKEN, 'content-type': 'application/json' }, JSON.stringify({ job_id: 'job-1', text: '# Guideline\nTwo.\n' }))
  await handler('/review/proposal')(proposed.req, proposed.res)
  expect(proposed.answer.status).toBe(200)
  const waiting = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await handler('/review/proposal')(waiting.req, waiting.res)
  const { ts } = (JSON.parse(waiting.answer.text) as { waiting: { ts: string }[] }).waiting[0]!
  const accepted = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083', cookie: DSH_COOKIE }, JSON.stringify({ project, job_id: 'job-1', ts, answer: 'accept', base: 1 }))
  await handler('/review/answer')(accepted.req, accepted.res)
  expect([accepted.answer.status, JSON.parse(accepted.answer.text)]).toEqual([503, refused])
  const still = direct('127.0.0.1', 'GET', { cookie: DSH_COOKIE })
  await handler('/review/proposal')(still.req, still.res)
  expect((JSON.parse(still.answer.text) as { waiting: unknown[] }).waiting).toHaveLength(1)
  expect([threads.agents.size, existsSync(glabLog), git(bare, 'rev-parse', 'main'), git(factory, 'worktree', 'list').split('\n').length]).toEqual([0, false, before, 1])
})

it('is wired into the plugin for the review talk: a start writes .mcp.json with the propose server beside the configured records module and the configured token file', async () => {
  put('actions.jsonl', [action()])
  put('reviews.jsonl', [review()])
  const dist = join(root, 'factory', 'lib', 'dist')
  mkdirSync(dist, { recursive: true })
  const records = recordsModule(dist)
  writeFileSync(join(dist, 'proposeServer.js'), '// stand-in for the built propose server\n')
  const registered: Route[] = []
  const { ctx } = pluginContext(registered, dsh)
  // The plugin's talks go under `TalkFolder.ROOT`, read when it is applied: pointed at the test's folder here, so nothing lands in the owner's home.
  const root0 = TalkFolder.ROOT
  Object.assign(TalkFolder, { ROOT: talkRoot() })
  // A stand-in orca, named by the review.orca setting: it writes down its arguments and runs nothing, so no real Orca is ever called from here.
  const orca = join(root, 'fake-orca'), orcaLog = join(root, 'fake-orca.log')
  writeFileSync(orca, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${orcaLog}'; done\nprintf -- '--\\n' >> '${orcaLog}'\n`
    + `[ "$2" = list ] && printf '%s' '{"result":{"repos":[]}}'\nexit 0\n`)
  chmodSync(orca, 0o755)
  try { plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: tokenPath(), recordsModule: records, review: { orca } })) } finally { Object.assign(TalkFolder, { ROOT: root0 }) }
  const handler = (path: string) => registered.find(route => route.path === path)!.handler
  const cookie = DSH_COOKIE
  const started = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083', cookie }, JSON.stringify({ project, job_id: 'job-1' }))
  await handler('/review/talk')(started.req, started.res)
  expect([started.answer.status, (JSON.parse(started.answer.text) as { opened: boolean }).opened]).toEqual([200, true])
  const folder = readdirSync(talkRoot()).map(name => join(talkRoot(), name))[0]!
  const mcp = JSON.parse(readFileSync(join(folder, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }
  const { args } = mcp.mcpServers[TalkFolder.SERVER_NAME]!
  expect([args[0], args[2], args[4]]).toEqual([join(dist, 'proposeServer.js'), 'http://127.0.0.1:3083/review/proposal', tokenPath()])
  // The configured orca was the one run, with the pinned commands.
  expect(readFileSync(orcaLog, 'utf8').split('--\n').filter(Boolean).map(call => call.trimEnd().split('\n'))).toEqual([['repo', 'list', '--json'],
    ['repo', 'add', '--path', folder, '--kind', 'git'],
    ['agent', 'launch', '--agent', 'claude', '--worktree', `path:${folder}`, '--surface', 'terminal', '--focus', '--prompt', 'Review talk · project job 1. Read opening.md in this folder and follow it.']])
})

/** An answer of the fixed checks, as the factory's `JobsReader` gives it. */
const automatic = (fields: Partial<AutomaticAnswer> = {}): AutomaticAnswer => ({ ts: '2026-11-26T08:05:00.000Z', request_id: 'req-1', session_id: 'worker-1', tool_name: 'Bash',
  tool_input: { command: 'git push origin story-4-2' }, reason: 'Share the branch.', answer: 'allow', ...fields })

it('shows an answer of the fixed checks in the job\'s timeline as automatic, with what was asked and the answer, and no comment field of its own', () => {
  const started = action(), yes = automatic(), no = automatic({ request_id: 'req-2', ts: '2026-11-26T08:06:00.000Z', tool_name: 'Write', tool_input: { file_path: '/etc/hosts', content: '<x>' }, reason: '', answer: 'refuse' })
  const job: RecordedJob = { project, job_id: 'job-1', number: 1, started: started.ts, stopped: null, last: no.ts, reviews: [],
    steps: [{ automatic: false, ts: started.ts, line: started }, { automatic: true, ts: yes.ts, answer: yes }, { automatic: true, ts: no.ts, answer: no }] }
  const entry: ProjectJobs = { project, jobs: [job], outside: [automatic({ request_id: 'req-3', ts: '2026-11-27T08:00:00.000Z', answer: 'refuse' })] }
  const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false }))
  const rows = [...page.querySelectorAll('ol li')]
  expect(rows.map(row => [row.className, row.getAttribute('data-automatic'), row.querySelector('strong')!.textContent, row.querySelector('.pill')?.textContent ?? null]))
    .toEqual([['', null, 'Job started', null], ['auto', 'allow', 'Bash', 'automatic yes'], ['auto', 'refuse', 'Write', 'automatic no']])
  expect([...rows[1]!.querySelectorAll('div')].map(part => part.textContent))
    .toEqual(['Asked: git push origin story-4-2', 'Reason given: Share the branch.', 'worker-1 · answered by the fixed checks · not reviewed'])
  // Anything but a command is shown in full as JSON, as text and never as markup.
  expect(rows[2]!.querySelector('code')!.textContent).toBe('{"file_path":"/etc/hosts","content":"<x>"}')
  expect(page.querySelector('x')).toBeNull()
  // One comment field, on the whole job, and none in a row.
  expect([page.querySelectorAll('textarea').length, page.querySelectorAll('ol textarea').length]).toEqual([1, 0])
  // The job ended without a stop, and the project's answers outside a job are the last entry of the left panel.
  expect([...page.querySelectorAll('nav a.job')].map(link => [...link.querySelectorAll('span')].filter(part => part.parentElement === link).map(part => part.textContent)))
    .toEqual([['Job 1', expect.stringMatching(/ · ended without a stop$/), '3 steps · no comments yet'], ['Outside a job', '1 automatic answer']])
})

it('shows the guideline version a job ran under on its entry in the job list, in the crumb and on its start row', () => {
  const started = action({ guideline_version: 'v2' }), other = action({ job_id: 'job-2', step_id: 'step-2', ts: '2026-11-25T08:00:00.000Z' })
  const job: RecordedJob = { project, job_id: 'job-1', number: 2, started: started.ts, stopped: null, last: started.ts, reviews: [], guideline_version: 'v2',
    steps: [{ automatic: false, ts: started.ts, line: started }] }
  const before: RecordedJob = { project, job_id: 'job-2', number: 1, started: other.ts, stopped: null, last: other.ts, reviews: [], steps: [{ automatic: false, ts: other.ts, line: other }] }
  const entry: ProjectJobs = { project, jobs: [job, before], outside: [] }
  const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false }))
  expect([...page.querySelectorAll('nav a.job')].map(link => link.querySelector('.pill')?.textContent ?? null)).toEqual(['v2', null])
  expect(page.querySelector('.crumb .pill')!.textContent).toBe('guideline v2')
  expect(page.querySelector('ol li .pill')!.textContent).toBe('guideline v2')
})

it('lists the answers outside a job on their own, with no comment field', () => {
  const entry: ProjectJobs = { project, jobs: [], outside: [automatic(), automatic({ request_id: 'req-2', answer: 'refuse' })] }
  const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, outside: true }))
  expect([page.querySelector('.crumb')!.textContent, page.querySelector('main h2')!.textContent]).toEqual(['project › Outside a job', 'Outside a job · 2 automatic answers'])
  expect([...page.querySelectorAll('ol li')].map(row => row.querySelector('.pill')!.textContent)).toEqual(['automatic yes', 'automatic no'])
  expect([page.querySelector('textarea'), page.querySelector('#start-talk'), page.querySelector('#talk-notice')]).toEqual([null, null, null])
  expect(page.querySelector('nav a.job.on')!.getAttribute('href')).toBe(ReviewRoute.address(project, undefined, true))
})

/** A job of three steps: the start, a permission answer, and a message. */
function threeSteps(): { job: RecordedJob; entry: ProjectJobs; answer: JobLogLine; message: JobLogLine } {
  const started = action(), answer = action({ step_id: 'step-2', ts: '2026-11-26T08:10:00.000Z', kind: 'permission_answer', summary: 'Approved: run the tests.', ref: 'decision-1', tokens: 1, ms: 1 })
  const message = action({ step_id: 'step-3', ts: '2026-11-26T08:20:00.000Z', kind: 'message_in', summary: 'Start the ready stories.', from: 'owner', to: 'super agent' })
  const job: RecordedJob = { project, job_id: 'job-1', number: 1, started: started.ts, stopped: null, last: message.ts, reviews: [],
    steps: [started, answer, message].map(line => ({ automatic: false as const, ts: line.ts, line })) }
  return { job, entry: { project, jobs: [job], outside: [] }, answer, message }
}
/** A permission answer's detail with every part recorded. */
const FULL: StepDetail = {
  asked: { kind: 'request', tool_name: 'Bash', tool_input: { command: 'bun test' }, reason: 'Run the tests.', session_id: 'worker-1' },
  looked_at: [{ path: 'stories/4-2.md', used: true }, { path: 'package.json', used: false }],
  why: { by: 'super_agent', decision: 'approve', choice: null, risk: 'low', reason: 'The story\'s own tests change nothing <outside>.', alternative: '', cites: 'story 4.2' },
  next: { outcome: 'ran_ok', tool_use_id: 'toolu_1', detail: '12 pass\n0 fail' },
  cost: { tokens: 980, seconds: 2.2 },
}
const NONE: StepDetail = { asked: null, looked_at: null, why: null, next: null, cost: null }
/** The step detail panel as label → value text, in the order shown. */
const partsOf = (page: Document) => [...page.querySelectorAll('aside.detail .lbl')].map(label => [label.textContent, label.nextElementSibling!.textContent])

it('makes every timeline row a link to its step, and marks the picked row', () => {
  const { job, entry, answer } = threeSteps()
  const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false, step: job.steps[1], detail: FULL }))
  expect([...page.querySelectorAll('ol li a.step')].map(link => link.getAttribute('href'))).toEqual(['step-1', 'step-2', 'step-3'].map(id => ReviewRoute.address(project, 'job-1', false, id)))
  expect([...page.querySelectorAll('ol li')].map(row => [row.className, row.querySelector('a')!.getAttribute('aria-current')])).toEqual([['', null], ['on', 'true'], ['', null]])
  expect(page.querySelector('aside.detail h2')!.textContent).toMatch(/^Step detail · \d\d:\d\d · Permission answered$/)
  expect(ReviewPage.stepIdOf(job.steps[1]!)).toBe(answer.step_id)
  // One comment field, at the bottom of the detail panel, for the picked step.
  const field = page.querySelector('aside.detail textarea')!
  expect([page.querySelectorAll('textarea').length, field.id, field.getAttribute('data-step'), page.querySelector('aside.detail label')!.textContent])
    .toEqual([1, 'comment', 'step-2', ReviewPage.STEP_COMMENT])
})

it('shows all five parts of a permission answer in full, in the panel\'s order, as text and never as markup', () => {
  const { job, entry } = threeSteps()
  const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false, step: job.steps[1], detail: FULL }))
  expect(partsOf(page)).toEqual([
    ['What was asked', 'Tool: Bash · bun testReason given by the worker: Run the tests.Session worker-1'],
    ['Why', 'Approved · risk lowThe story\'s own tests change nothing <outside>.Rests on: story 4.2'],
    ['What it looked at', 'stories/4-2.md · usedpackage.json · not used'],
    ['What happened next', 'Ran and succeeded12 pass\n0 fail'],
    ['Cost', '980 tokens · 2.2 s'],
  ])
  expect(page.querySelector('outside')).toBeNull()
  expect(page.querySelectorAll('aside .none').length).toBe(0)
})

it('shows a message\'s text, sender and receiver, and says the other parts are not recorded', () => {
  const { job, entry } = threeSteps()
  const detail: StepDetail = { ...NONE, asked: { kind: 'message', text: 'Start the ready stories.', from: 'owner', to: 'super agent' } }
  const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false, step: job.steps[2], detail }))
  expect(partsOf(page)).toEqual([
    ['What was asked', 'owner ──▶ super agentStart the ready stories.'],
    ['Why', 'Not recorded'], ['What it looked at', 'Not recorded'], ['What happened next', 'Not recorded'], ['Cost', 'Not recorded'],
  ])
})

it('names the other answers, the fixed checks\' answer, an empty read list and every outcome in words', () => {
  const { job, entry } = threeSteps()
  const view = (detail: StepDetail) => partsOf(dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false, step: job.steps[1], detail })))
  const denied: StepDetail = { ...FULL, looked_at: [], why: { by: 'super_agent', decision: 'deny', choice: 'the smaller fix', risk: 'high', reason: 'Too wide.', alternative: 'Ask first.', cites: '' } }
  expect(view(denied).slice(1, 3)).toEqual([['Why', 'Denied · risk highToo wide.Chosen: the smaller fixInstead: Ask first.'], ['What it looked at', 'Nothing was read.']])
  expect(view({ ...NONE, why: { by: 'fixed_checks', answer: 'refuse' } })[1]).toEqual(['Why', 'automatic no · answered by the fixed checks · not reviewed'])
  const outcomes = (['ran_failed', 'refused', 'owner_no', 'unknown'] as const).map(outcome => view({ ...NONE, next: { outcome, tool_use_id: null, detail: '' } })[3]![1])
  expect(outcomes).toEqual(['Ran and failed', 'Refused', 'The owner said no', 'Cannot be told yet: the worker\'s transcript holds no result for it'])
  expect(view({ ...NONE, asked: { kind: 'step', text: 'Started a worker.' } })[0]).toEqual(['What was asked', 'Started a worker.'])
})

it('asks the owner to pick a step while none is picked, and shows no panel outside a job', () => {
  const { job, entry } = threeSteps()
  const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false }))
  expect([page.querySelector('aside.detail p')!.textContent, page.querySelectorAll('ol li.on').length]).toEqual([ReviewPage.PICK_STEP, 0])
  const outside: ProjectJobs = { project, jobs: [], outside: [automatic()] }
  const list = dom(new ReviewPage('nonce').view({ projects: [outside], project: outside, outside: true }))
  expect([list.querySelector('aside'), list.querySelector('ol li a'), list.querySelector('.cols')!.className]).toEqual([null, null, 'cols'])
  expect(page.querySelector('.cols')!.className).toBe('cols with-detail')
})

it('puts every text of a step\'s detail on the page as text, never as markup', () => {
  const { job, entry } = threeSteps()
  const mark = '<x>'
  const request: StepDetail = {
    asked: { kind: 'request', tool_name: mark, tool_input: { file_path: mark }, reason: mark, session_id: mark },
    looked_at: [{ path: mark, used: true }],
    why: { by: 'super_agent', decision: 'deny', choice: mark, risk: 'low', reason: mark, alternative: mark, cites: mark },
    next: { outcome: 'ran_failed', tool_use_id: null, detail: mark },
    cost: null,
  }
  const message: StepDetail = { ...NONE, asked: { kind: 'message', text: mark, from: mark, to: mark } }
  for (const detail of [request, message]) {
    const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false, step: job.steps[1], detail }))
    expect(page.querySelector('x')).toBeNull()
    expect(page.querySelector('aside.detail')!.textContent).toContain(mark)
  }
})

it('serves a step\'s detail from the step reader at its address, and 404 for a step the job does not hold', async () => {
  put('actions.jsonl', [action(), action({ step_id: 'step-2', ts: '2026-11-26T08:10:00.000Z', kind: 'permission_answer', summary: 'Approved: run the tests.', ref: 'decision-1' })])
  writeFileSync(file('step-details.json'), JSON.stringify({ 'step-2': FULL }))
  await serve()
  const cookie = await signIn()
  const picked = await call('GET', ReviewRoute.address(project, 'job-1', false, 'step-2'), { cookie })
  expect(picked.status).toBe(200)
  expect(partsOf(dom(picked.text)).at(-1)).toEqual(['Cost', '980 tokens · 2.2 s'])
  const plain = dom((await call('GET', ReviewRoute.address(project, 'job-1', false, 'step-1'), { cookie })).text)
  expect(partsOf(plain).map(([, value]) => value)).toEqual(Array(5).fill(ReviewPage.NOT_RECORDED))
  const missing = await call('GET', ReviewRoute.address(project, 'job-1', false, 'step-9'), { cookie })
  expect([missing.status, dom(missing.text).querySelector('p')!.textContent]).toEqual([404, 'That step is not in this job'])
  expect((await call('GET', `${ReviewRoute.address(project, undefined, true)}&step=step-1`, { cookie })).status).toBe(404)
})

it('answers 503 for a picked step when the records module has no step reader, and still shows the job without one', async () => {
  put('actions.jsonl', [action()])
  const source = readFileSync(recordsModule(root), 'utf8').replace('export class StepDetailReader', 'class StepDetailReader')
  await serve([project], new FactoryRecordsModule(recordsModule(root, source)))
  const cookie = await signIn()
  expect((await call('GET', ReviewRoute.address(project, 'job-1'), { cookie })).status).toBe(200)
  const picked = await call('GET', ReviewRoute.address(project, 'job-1', false, 'step-1'), { cookie })
  expect([picked.status, dom(picked.text).querySelector('p')!.textContent]).toEqual([503, 'The configured recordsModule does not export StepDetailReader, so no record is read'])
})

describe('comments on a job and on any step', () => {
  /** One job: its start, a permission answer, a message and its stop. */
  const steps = () => [
    action(),
    action({ step_id: 'step-2', ts: '2026-11-26T08:10:00.000Z', kind: 'permission_answer', summary: 'Approved: run the tests.' }),
    action({ step_id: 'step-3', ts: '2026-11-26T08:20:00.000Z', kind: 'message_in', summary: 'Start the ready stories.', from: 'owner', to: 'super agent' }),
    action({ step_id: 'step-4', ts: '2026-11-26T08:30:00.000Z', kind: 'job_stop', summary: 'Stopped.' }),
  ]
  /** The "Comments" block as [heading, comment] pairs, and the echoes under the timeline's rows as [row id, comment]. */
  const listed = (page: Document) => [...page.querySelectorAll('ul.comments li')].map(entry => [entry.querySelector('strong')!.textContent, entry.querySelector('.mine')!.textContent])
  const echoes = (page: Document) => [...page.querySelectorAll('ol li')].flatMap(row => {
    const echo = row.querySelector('.mine')
    return echo === null ? [] : [[new URL(row.querySelector('a')!.href, 'http://x').searchParams.get('step'), echo.textContent]]
  })
  const fieldOf = (page: Document) => {
    const field = page.querySelector<HTMLTextAreaElement>('aside.detail textarea')
    return field === null ? null : [page.querySelector('aside.detail label')!.textContent, field.getAttribute('data-step'), field.value]
  }

  it('saves a comment on one step masked, with its step_id, and shows it under the step, in the job\'s comments and in that step\'s field', async () => {
    await serve()
    put('actions.jsonl', steps())
    const cookie = await signIn()
    const answer = await comment(cookie, { project, job_id: 'job-1', step_id: 'step-2', comment: `Too wide; never print ${PLANTED}.` })
    expect([answer.status, JSON.parse(answer.text)]).toEqual([200, { saved: true }])
    const written = lines('reviews.jsonl')
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]!)).toEqual({ ts: NOW, project, job_id: 'job-1', step_id: 'step-2', comment: `Too wide; never print ${REDACTED}.` })
    expect(Object.keys(JSON.parse(written[0]!) as object)).toEqual(['ts', 'project', 'job_id', 'step_id', 'comment'])
    expect(readFileSync(file('reviews.jsonl'), 'utf8')).not.toContain(PLANTED)
    const job = await call('GET', ReviewRoute.address(project, 'job-1'), { cookie })
    expect(job.text).not.toContain(PLANTED)
    const page = dom(job.text)
    expect(listed(page)).toEqual([['Permission answered', `You: Too wide; never print ${REDACTED}.`]])
    expect(echoes(page)).toEqual([['step-2', `You: Too wide; never print ${REDACTED}.`]])
    // With no step picked the field is the whole job's, which has no comment yet.
    expect(fieldOf(page)).toEqual([ReviewPage.JOB_COMMENT, null, ''])
    expect(fieldOf(dom((await call('GET', ReviewRoute.address(project, 'job-1', false, 'step-2'), { cookie })).text)))
      .toEqual([ReviewPage.STEP_COMMENT, 'step-2', `Too wide; never print ${REDACTED}.`])
  })

  it('writes a changed comment as a new line and shows only the newest text of each, once', async () => {
    await serve()
    put('actions.jsonl', steps())
    const cookie = await signIn()
    for (const body of [{ comment: 'Good pace.' }, { step_id: 'step-2', comment: 'Too wide.' }, { step_id: 'step-3', comment: 'Fine.' }, { step_id: 'step-2', comment: 'Ask me next time.' }]) {
      expect((await comment(cookie, { project, job_id: 'job-1', ...body })).status).toBe(200)
    }
    expect(lines('reviews.jsonl')).toHaveLength(4)
    const html = (await call('GET', ReviewRoute.address(project, 'job-1'), { cookie })).text
    const page = dom(html)
    expect(listed(page)).toEqual([[ReviewPage.WHOLE_JOB, 'You: Good pace.'], ['Permission answered', 'You: Ask me next time.'], ['Message received', 'You: Fine.']])
    // The whole job's comment shows under the row that stops the job.
    expect(echoes(page)).toEqual([['step-2', 'You: Ask me next time.'], ['step-3', 'You: Fine.'], ['step-4', 'You: Good pace.']])
    expect(html).not.toContain('Too wide.')
    expect(page.querySelector('nav a.job')!.textContent).toContain('3 comments')
    // The job's start and stop rows hold the whole job's comment.
    for (const id of ['step-1', 'step-4']) {
      expect(fieldOf(dom((await call('GET', ReviewRoute.address(project, 'job-1', false, id), { cookie })).text))).toEqual([ReviewPage.JOB_COMMENT, null, 'Good pace.'])
    }
    // The changed step's own field holds its newest text.
    expect(fieldOf(dom((await call('GET', ReviewRoute.address(project, 'job-1', false, 'step-2'), { cookie })).text))).toEqual([ReviewPage.STEP_COMMENT, 'step-2', 'Ask me next time.'])
  })

  it('refuses a step comment it cannot keep, and writes nothing', async () => {
    const answer = automatic({ ts: '2026-11-26T08:05:00.000Z' })
    // The stand-in reader reads no automatic answer, so this records module adds one to the job.
    class WithAutomatic extends FactoryRecordsModule {
      override async jobsReader() {
        const reader = await super.jobsReader()
        return { read: (projects: readonly string[]) => reader.read(projects).map(entry => ({ ...entry, jobs: entry.jobs.map(job => ({
          ...job, steps: [...job.steps, { automatic: true as const, ts: answer.ts, answer }].sort((x, y) => x.ts.localeCompare(y.ts)) })) })) }
      }
    }
    await serve([project], new WithAutomatic(recordsModule(root)))
    put('actions.jsonl', steps())
    const cookie = await signIn()
    const refused = async (step_id: unknown) => {
      const sent = await comment(cookie, { project, job_id: 'job-1', step_id, comment: 'Hm.' })
      return [sent.status, (JSON.parse(sent.text) as { error: string }).error]
    }
    expect(await refused('step-9')).toEqual([404, 'That step is not in this job'])
    expect(await refused(answer.request_id)).toEqual([400, 'An automatic answer takes no comment'])
    expect(await refused('step-1')).toEqual([400, 'Comment on the whole job without a step'])
    expect(await refused('step-4')).toEqual([400, 'Comment on the whole job without a step'])
    expect(await refused('')).toEqual([400, 'step_id must be non-empty text'])
    expect(await refused(7)).toEqual([400, 'step_id must be non-empty text'])
    expect(existsSync(file('reviews.jsonl'))).toBe(false)
    // The automatic answer's detail has no comment field.
    expect(fieldOf(dom((await call('GET', ReviewRoute.address(project, 'job-1', false, answer.request_id), { cookie })).text))).toBeNull()
  })

  it('lists the whole job\'s comment only among the job\'s comments when the job has no stop row', () => {
    const { job, entry } = threeSteps()
    job.reviews.push(review({ comment: 'Good pace.' }), review({ step_id: 'step-3', comment: 'Fine.' }))
    const page = dom(new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false }))
    expect(listed(page)).toEqual([[ReviewPage.WHOLE_JOB, 'You: Good pace.'], ['Message received', 'You: Fine.']])
    expect(echoes(page)).toEqual([['step-3', 'You: Fine.']])
    expect([...page.querySelectorAll('ul.comments a')].map(link => link.getAttribute('href'))).toEqual([ReviewRoute.address(project, 'job-1'), ReviewRoute.address(project, 'job-1', false, 'step-3')])
  })

  it('sends the picked step\'s id with its comment, and none with the whole job\'s', async () => {
    const { job, entry } = threeSteps()
    const sent: unknown[] = []
    for (const step of [job.steps[1], undefined]) {
      const html = new ReviewPage('nonce').view({ projects: [entry], project: entry, job, outside: false, step, detail: step === undefined ? undefined : NONE })
      const window = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:3083/review', beforeParse: view => {
        (view as unknown as { fetch: unknown }).fetch = (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return Promise.resolve({ ok: true }) }
      } }).window
      const field = window.document.querySelector('textarea')!
      field.value = 'Ask me next time.'
      field.dispatchEvent(new window.Event('blur'))
      await settle()
    }
    expect(sent).toEqual([
      { project, job_id: 'job-1', step_id: 'step-2', comment: 'Ask me next time.' },
      { project, job_id: 'job-1', comment: 'Ask me next time.' },
    ])
  })

  it('writes nothing but comment lines: reading, signing in and refused writes leave the records as they were, and the page offers no mark or setting', async () => {
    await serve()
    put('actions.jsonl', steps())
    const before = readFileSync(file('actions.jsonl'), 'utf8')
    const cookie = await signIn()
    const html = (await call('GET', ReviewRoute.address(project, 'job-1', false, 'step-2'), { cookie })).text
    expect((await call('POST', ReviewRoute.address(project, 'job-1'), { cookie, origin: origin() }, '{}')).status).toBe(405)
    expect((await comment(cookie, { project, job_id: 'job-1', step_id: 'step-2', comment: 'Ask me next time.' })).status).toBe(200)
    expect([readFileSync(file('actions.jsonl'), 'utf8'), lines('reviews.jsonl').length]).toEqual([before, 1])
    expect(readdirSync(join(project, FactoryRecordFile.FOLDER)).sort()).toEqual(['actions.jsonl', 'reviews.jsonl'])
    // The only controls are the comment field and the review talk's button: no form, other button, select, radio or checkbox, and no word of a mark,
    // grade or setting.
    const page = dom(html)
    expect([...page.querySelectorAll('form, button, select, input')].map(control => control.id)).toEqual(['start-talk'])
    expect(page.body.textContent).not.toMatch(/\b(mark|grade|score|rating|never[- ]decide|setting)s?\b/i)
  })
})

describe('the Guideline tab', () => {
  const v = (version: number, fields: Partial<GuidelineVersion> = {}): GuidelineVersion =>
    ({ version, date: `2026-11-2${version}`, from_job: version === 1 ? null : `job-${version}`, from_version: version === 1 ? null : version - 1, text: `Text of v${version}.`, ...fields })
  /** The stand-in records module with a guideline reader that gives `read`. */
  class GuidelineRecords extends FactoryRecordsModule {
    constructor(private readonly given: GuidelineRead) { super(recordsModule(root)) }
    override async guidelineReader(): Promise<GuidelineSource> { return { read: () => this.given } }
  }
  const twoVersions = (): GuidelineRead => {
    const versions = [v(2, { text: 'Ask me before <b>any</b> push.\nKeep it small.' }), v(1)]
    return { folder: '/factory/guideline', versions, current: versions[0]!, reason: null }
  }
  const versionsOf = (page: Document) => [...page.querySelectorAll('nav a.version')].map(link => [...link.querySelectorAll('span')].map(part => part.textContent))

  it('lists the versions newest first with their date and source job, and opens the current one\'s text, escaped', async () => {
    await serve([project], new GuidelineRecords(twoVersions()))
    const answer = await call('GET', ReviewRoute.guidelineAddress(), { cookie: await signIn() })
    expect(answer.status).toBe(200)
    const page = dom(answer.text)
    expect(versionsOf(page)).toEqual([['v2 · current', '2026-11-22 · from the review of job job-2', 'No trend report yet'], ['v1', '2026-11-21', 'No trend report yet']])
    expect(page.querySelector('nav a.version.on')!.getAttribute('href')).toBe(ReviewRoute.guidelineAddress(2))
    expect(page.querySelector('main h2')!.textContent).toBe('Guideline v2 · current')
    expect(page.querySelector('.guideline-text')!.textContent).toBe('Ask me before <b>any</b> push.\nKeep it small.')
    expect(page.querySelector('.guideline-text b')).toBeNull()
    expect(page.querySelector('nav.tabs a.on')!.textContent).toBe(ReviewPage.TAB_GUIDELINE)
  })

  it('opens an older version with its own text, date and job, and refuses a version that does not exist with 404', async () => {
    await serve([project], new GuidelineRecords(twoVersions()))
    const cookie = await signIn()
    const page = dom((await call('GET', ReviewRoute.guidelineAddress(1), { cookie })).text)
    expect([page.querySelector('main h2')!.textContent, page.querySelector('main .meta')!.textContent, page.querySelector('.guideline-text')!.textContent])
      .toEqual(['Guideline v1', '2026-11-21', 'Text of v1.'])
    for (const wanted of ['9', 'two', '']) {
      const answer = await call('GET', `${ReviewRoute.PATH}?tab=guideline&version=${wanted}`, { cookie })
      expect([answer.status, answer.text.includes('That guideline version does not exist')]).toEqual([404, true])
    }
  })

  it('says there is no guideline yet when the folder holds no version', async () => {
    await serve([project], new GuidelineRecords({ folder: '/factory/guideline', versions: [], current: null, reason: 'No guideline yet. The first review talk writes version 1.' }))
    const page = dom((await call('GET', ReviewRoute.guidelineAddress(), { cookie: await signIn() })).text)
    expect(page.querySelector('main')!.textContent!.trim()).toBe(ReviewPage.NO_GUIDELINE)
    expect(page.querySelectorAll('nav a.version').length).toBe(0)
  })

  it('says the guideline folder was not found, with the reader\'s reason, when the factory repository is not known', async () => {
    await serve([project], new GuidelineRecords({ folder: null, versions: [], current: null, reason: 'No zees-software-factory folder entry.' }))
    const page = dom((await call('GET', ReviewRoute.guidelineAddress(), { cookie: await signIn() })).text)
    expect([...page.querySelectorAll('main p')].map(line => line.textContent)).toEqual([ReviewPage.NO_GUIDELINE_FOLDER, 'No zees-software-factory folder entry.'])
  })

  it('is reached from the Jobs tab, has only the trend report\'s button, keeps the six routes, and needs DSH\'s sign-in', async () => {
    const registered = await serve([project], new GuidelineRecords(twoVersions()))
    expect(registered.map(route => route.path)).toEqual(['/review', '/review/comment', '/review/talk', '/review/proposal', '/review/answer', '/review/trends'])
    expect((await call('GET', ReviewRoute.guidelineAddress())).status).toBe(401)
    const cookie = await signIn()
    const jobs = dom((await call('GET', ReviewRoute.PATH, { cookie })).text)
    expect([...jobs.querySelectorAll('nav.tabs a')].map(link => [link.textContent, link.getAttribute('href'), link.classList.contains('on')]))
      .toEqual([['Jobs', '/review', true], ['Guideline', ReviewRoute.guidelineAddress(), false]])
    const page = dom((await call('GET', ReviewRoute.guidelineAddress(), { cookie })).text)
    expect([...page.querySelectorAll('form, button, select, input, textarea')].map(control => control.id)).toEqual(['write-trend'])
  })
})

describe('the review talk and its proposals', () => {
  /** A job of three steps with a comment on the whole job and one on its second step, and a guideline v1 next to the stand-in records module. */
  function sample(): void {
    put('actions.jsonl', [action(), action({ step_id: 'step-2', ts: '2026-11-26T08:10:00.000Z', kind: 'permission_answer', summary: 'Approved: run the tests.' }),
      action({ step_id: 'step-3', ts: '2026-11-26T08:30:00.000Z', kind: 'job_stop', summary: 'Stopped.' })])
    put('reviews.jsonl', [review({ comment: 'Good pace.' }), review({ step_id: 'step-2', comment: 'Reject this at this stage.' })])
    mkdirSync(join(root, 'guideline'), { recursive: true })
    writeFileSync(join(root, 'guideline', 'v1.md'), '# Guideline\nKeep it small.\nAsk first.\n')
  }
  /** Clicks "Start review talk" as the page's script does. */
  const startTalk = (cookie: string | undefined, body: object = { project, job_id: 'job-1' }, headers: Record<string, string | undefined> = {}) =>
    call('POST', ReviewRoute.TALK_PATH, { origin: origin(), cookie, 'content-type': 'application/json', ...headers }, JSON.stringify(body))
  /** Posts a proposal as the talk's tool does: no Origin, no cookie, the shared token in its header. */
  const propose = (body: unknown, headers: Record<string, string | undefined> = {}) =>
    call('POST', ReviewRoute.PROPOSAL_PATH, { 'content-type': 'application/json', [SharedTokenFile.HEADER]: TOKEN, ...headers }, typeof body === 'string' ? body : JSON.stringify(body))
  const talkFolder = () => readdirSync(talkRoot()).map(name => join(talkRoot(), name))[0]!
  const filesOf = (folder: string) => readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(folder.length + 1)).filter(name => !name.startsWith('.git/')).sort()

  it('starts a talk on a signed-in click: the folder holds the pinned files, the job\'s files and opening.md, Orca opens it, and the answer carries the notice', async () => {
    await serve()
    sample()
    const cookie = await signIn()
    const answer = await startTalk(cookie)
    const body = JSON.parse(answer.text) as Record<string, unknown>
    expect([answer.status, body]).toEqual([200, { opened: true, notice: ReviewPage.TALK_OPENED }])
    expect(ReviewPage.TALK_OPENED).toBe('Review talk opened in Orca. Trust the folder there and approve the zees-factory-propose server if asked.')
    const folder = talkFolder()
    expect(filesOf(folder)).toEqual(['.claude/settings.json', '.mcp.json', 'comments.md', 'guideline.md', 'job.md', 'opening.md', 'talk.json'])
    expect(readFileSync(join(folder, '.mcp.json'), 'utf8')).toContain(`"http://127.0.0.1:${port}/review/proposal"`)
    expect(orcaCalls).toEqual([['repo', 'list', '--json'], ['repo', 'add', '--path', folder, '--kind', 'git'],
      ['agent', 'launch', '--agent', 'claude', '--worktree', `path:${folder}`, '--surface', 'terminal', '--focus', '--prompt', 'Review talk · project job 1. Read opening.md in this folder and follow it.']])
    const message = readFileSync(join(folder, 'opening.md'), 'utf8')
    for (const part of ['Review talk · project job 1', 'Good pace.', 'Reject this at this stage.', 'Keep it small.', 'never job text, comments, project code or a file path']) {
      expect(message).toContain(part)
    }
    // Opened later, the job shows the notice that names the talk, with the link that starts a fresh one.
    const page = dom((await call('GET', ReviewRoute.address(project, 'job-1'), { cookie })).text)
    expect(page.querySelector('#talk-notice span')!.textContent).toBe('A review talk for this job was started on 26 Nov 2026. Continue it in Orca: \'Review talk · project job 1\'.')
    expect([page.querySelector('#talk-notice')!.hasAttribute('hidden'), page.querySelector('#fresh-talk')!.textContent]).toEqual([false, ReviewPage.FRESH_TALK])
    const button = page.querySelector<HTMLButtonElement>('#start-talk')!
    expect([button.textContent, button.dataset.project, button.dataset.job, button.closest('.head') !== null]).toEqual([ReviewPage.START_TALK, project, 'job-1', true])
  })

  it('opens nothing and rewrites nothing on a second click, and writes the files again for a fresh talk', async () => {
    await serve()
    sample()
    const cookie = await signIn()
    expect((await startTalk(cookie)).status).toBe(200)
    const folder = talkFolder()
    const before = filesOf(folder).map(name => readFileSync(join(folder, name), 'utf8'))
    const again = JSON.parse((await startTalk(cookie)).text) as Record<string, unknown>
    expect(again).toEqual({ opened: false, notice: expect.stringContaining('was started on 26 Nov 2026'), fresh: ReviewPage.FRESH_TALK })
    expect(filesOf(folder).map(name => readFileSync(join(folder, name), 'utf8'))).toEqual(before)
    expect(orcaCalls.filter(args => args[1] === 'launch')).toHaveLength(1)
    put('reviews.jsonl', [review({ comment: 'Changed my mind.' })])
    const fresh = JSON.parse((await startTalk(cookie, { project, job_id: 'job-1', fresh: true })).text) as { opened: boolean }
    expect(orcaCalls.filter(args => args[1] === 'launch')).toHaveLength(2)
    expect([fresh.opened, readFileSync(join(folder, 'comments.md'), 'utf8').includes('Changed my mind.')]).toEqual([true, true])
  })

  it('asks for a comment first, says why a talk cannot be prepared, and marks nothing as started', async () => {
    await serve()
    put('actions.jsonl', [action()])
    const cookie = await signIn()
    const none = await startTalk(cookie)
    expect([none.status, JSON.parse(none.text)]).toEqual([409, { error: 'Comment on the job or a step first.' }])
    expect(existsSync(talkRoot())).toBe(false)
    put('reviews.jsonl', [review()])
    rmSync(proposeServer())
    const cannot = await startTalk(cookie)
    expect([cannot.status, (JSON.parse(cannot.text) as { error: string }).error]).toEqual([503, expect.stringMatching(/^The review talk could not be prepared: /)])
    expect(existsSync(talkRoot())).toBe(false)
    const page = dom((await call('GET', ReviewRoute.address(project, 'job-1'), { cookie })).text)
    expect([page.querySelector('#talk-notice')!.hasAttribute('hidden'), page.querySelector('#talk-notice')!.textContent]).toEqual([true, ''])
    const unknown = await startTalk(cookie, { project, job_id: 'nope' })
    expect(unknown.status).toBe(404)
  })

  it('refuses a start without DSH\'s sign-in, from another site or with the wrong method, and writes nothing', async () => {
    await serve()
    sample()
    const cookie = await signIn()
    expect((await startTalk(undefined)).status).toBe(401)
    expect((await startTalk(cookie, undefined, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await startTalk(cookie, undefined, { origin: undefined })).status).toBe(403)
    const wrong = await call('GET', ReviewRoute.TALK_PATH, { cookie })
    expect([wrong.status, wrong.headers.allow]).toEqual([405, 'POST'])
    expect(existsSync(talkRoot())).toBe(false)
  })

  it('keeps a proposal posted with the token for a job whose talk was started, echoes the token, and shows it on both tabs before → after', async () => {
    await serve()
    sample()
    const cookie = await signIn()
    expect((await startTalk(cookie)).status).toBe(200)
    const first = await propose({ job_id: 'job-1', text: '# Guideline\nKeep it small.\nAsk first.\nNever add a dependency unasked.\n' })
    expect([first.status, first.headers[SharedTokenFile.HEADER], (JSON.parse(first.text) as { kept: boolean }).kept]).toEqual([200, TOKEN, true])
    const second = await propose({ job_id: 'job-1', text: '# Guideline\nKeep to the minimum feature.\nAsk first.\n' })
    expect(second.status).toBe(200)
    // The notice on both tabs links to the newest proposal.
    for (const address of [ReviewRoute.address(project, 'job-1'), ReviewRoute.guidelineAddress()]) {
      const page = dom((await call('GET', address, { cookie })).text)
      expect([page.querySelector('#proposal-notice')!.hasAttribute('hidden'), page.querySelector('#proposal-link')!.textContent, page.querySelector('#proposal-link')!.getAttribute('href')])
        .toEqual([false, ReviewPage.PROPOSAL_WAITING, ReviewRoute.proposalAddress(project, 'job-1')])
    }
    const guideline = dom((await call('GET', ReviewRoute.guidelineAddress(), { cookie })).text)
    expect([...guideline.querySelectorAll('nav.left a')].map(link => link.className)).toEqual(['proposal', 'version on'])
    const view = dom((await call('GET', ReviewRoute.proposalAddress(project, 'job-1'), { cookie })).text)
    const [left, right] = [...view.querySelectorAll('.halves section')]
    expect([left!.querySelector('h3')!.textContent, right!.querySelector('h3')!.textContent]).toEqual(['Guideline v1 · current', 'Proposed v2'])
    // The newer text stands on the right, whole; only the changed line is marked, as a deletion on the left and an insertion on the right.
    expect([...left!.querySelectorAll('.line')].map(each => [each.tagName, each.textContent])).toEqual([['SPAN', '# Guideline'], ['DEL', 'Keep it small.'], ['SPAN', 'Ask first.']])
    expect([...right!.querySelectorAll('.line')].map(each => [each.tagName, each.textContent])).toEqual([['SPAN', '# Guideline'], ['INS', 'Keep to the minimum feature.'], ['SPAN', 'Ask first.']])
    expect(view.querySelector('main')!.textContent).toContain(ReviewPage.NOTHING_SAVED)
    // Its only controls are the owner's two answers, for the proposal shown.
    expect([...view.querySelectorAll('form, button, select, input, textarea')].map(control => [control.id, control.textContent])).toEqual([['accept-proposal', 'Accept as v2'], ['reject-proposal', 'Reject']])
    expect((view.getElementById('accept-proposal') as HTMLElement).dataset).toMatchObject({ project, job: 'job-1', ts: NOW })
    // What waits, for the page's script: no text, only where to open it.
    const waiting = await call('GET', ReviewRoute.PROPOSAL_PATH, { cookie })
    expect(JSON.parse(waiting.text)).toEqual({ waiting: [{ project, job_id: 'job-1', number: 1, ts: NOW, href: ReviewRoute.proposalAddress(project, 'job-1') }] })
    expect((await call('GET', ReviewRoute.PROPOSAL_PATH, {})).status).toBe(401)
    // Text from the talk is text on the page, never markup.
    expect((await propose({ job_id: 'job-1', text: 'Ask before <b>any</b> push.' })).status).toBe(200)
    const escaped = dom((await call('GET', ReviewRoute.proposalAddress(project, 'job-1'), { cookie })).text)
    expect([escaped.querySelector('b'), escaped.querySelector('ins')!.textContent]).toEqual([null, 'Ask before <b>any</b> push.'])
  })

  it('keeps nothing without the token, with a wrong one, with an Origin, or from a caller that is not on loopback', async () => {
    await serve()
    sample()
    const cookie = await signIn()
    expect((await startTalk(cookie)).status).toBe(200)
    const body = { job_id: 'job-1', text: 'New text.' }
    expect((await propose(body, { [SharedTokenFile.HEADER]: undefined })).status).toBe(401)
    expect((await propose(body, { [SharedTokenFile.HEADER]: OTHER_TOKEN })).status).toBe(401)
    // DSH's sign-in cookie alone does not stand in for the token here, and DSH is not asked: the caller is a program, not a browser.
    const asked = dsh.asked.length
    expect((await propose(body, { [SharedTokenFile.HEADER]: undefined, cookie })).status).toBe(401)
    expect(dsh.asked).toHaveLength(asked)
    expect((await propose(body, { origin: origin() })).status).toBe(403)
    expect((await propose(body, { origin: origin(), cookie })).status).toBe(403)
    expect((await propose(body, { host: `evil.example:${port}` })).status).toBe(403)
    for (const refused of [await propose(body, { [SharedTokenFile.HEADER]: undefined }), await propose(body, { origin: origin() })]) {
      expect(refused.headers[SharedTokenFile.HEADER]).toBeUndefined()
      expect(refused.text).not.toContain(TOKEN)
    }
    const away = direct('192.168.1.9', 'POST', { [SharedTokenFile.HEADER]: TOKEN }, JSON.stringify(body))
    await reviewRoute!.handle(away.req, away.res, 3083, 'proposal')
    expect(away.answer.status).toBe(403)
    expect(reviewRoute!.proposals.newest()).toEqual([])
  })

  it('refuses a bad proposal and says why: not JSON, no text, too large, the same as now, an unknown job, a job with no talk', async () => {
    await serve()
    sample()
    put('actions.jsonl', [...lines('actions.jsonl'), JSON.stringify(action({ job_id: 'job-2', step_id: 'other-1', ts: '2026-11-26T10:00:00.000Z' }))])
    const cookie = await signIn()
    expect((await startTalk(cookie)).status).toBe(200)
    const cases: [unknown, number, string][] = [
      ['not json', 400, 'The request body is not JSON'],
      [{ job_id: 'job-1' }, 400, 'text must be the whole new guideline text'],
      [{ job_id: 'job-1', text: '   ' }, 400, 'text must be the whole new guideline text'],
      [{ text: 'New text.' }, 400, 'job_id must be non-empty text'],
      [{ job_id: 'job-1', text: 'x'.repeat(ReviewRoute.MAX_BODY_BYTES) }, 413, `Request exceeds ${ReviewRoute.MAX_BODY_BYTES} bytes`],
      [{ job_id: 'job-1', text: '# Guideline\nKeep it small.\nAsk first.\n' }, 400, 'The proposal is the same as the current version'],
      [{ job_id: 'job-1', text: '# Guideline\r\nKeep it small.\r\nAsk first.\r\n' }, 400, 'The proposal is the same as the current version'],
      [{ job_id: 'nope', text: 'New text.' }, 404, 'No listed project holds that job'],
      [{ job_id: 'job-2', text: 'New text.' }, 409, 'No review talk was started for that job'],
    ]
    for (const [body, status, error] of cases) {
      const answer = await propose(body)
      expect([body === 'not json' ? body : Object.keys(body as object), answer.status, JSON.parse(answer.text)]).toEqual([body === 'not json' ? body : Object.keys(body as object), status, { error }])
    }
    expect(reviewRoute!.proposals.newest()).toEqual([])
    const page = dom((await call('GET', ReviewRoute.guidelineAddress(), { cookie })).text)
    expect(page.querySelector('#proposal-notice')!.hasAttribute('hidden')).toBe(true)
    expect((await call('GET', ReviewRoute.proposalAddress(project, 'job-1'), { cookie })).status).toBe(404)
  })

  it('keeps a proposal under the one project whose talk for a shared job id was started, and refuses when both were started', async () => {
    const other = join(root, 'other')
    mkdirSync(join(other, FactoryRecordFile.FOLDER), { recursive: true })
    await serve([project, other])
    sample()
    put('actions.jsonl', [action({ project: other })], other)
    put('reviews.jsonl', [review({ project: other, comment: 'On the other project.' })], other)
    const cookie = await signIn()
    expect((await startTalk(cookie, { project: other, job_id: 'job-1' })).status).toBe(200)
    expect((await propose({ job_id: 'job-1', text: 'For the other project.' })).status).toBe(200)
    expect(reviewRoute!.proposals.newest().map(each => [each.project, each.text])).toEqual([[other, 'For the other project.']])
    expect(reviewRoute!.proposals.of(project, 'job-1')).toBeUndefined()
    expect((await startTalk(cookie, { project, job_id: 'job-1' })).status).toBe(200)
    const both = await propose({ job_id: 'job-1', text: 'For which project?' })
    expect([both.status, JSON.parse(both.text)]).toEqual([409, { error: 'Review talks for that job id were started in more than one project' }])
    expect(reviewRoute!.proposals.newest().map(each => [each.project, each.text])).toEqual([[other, 'For the other project.']])
  })

  it('writes no record: the job log, the comments, the guideline folder and the project\'s .factory folder are as they were', async () => {
    await serve()
    sample()
    const before = { actions: readFileSync(file('actions.jsonl'), 'utf8'), reviews: readFileSync(file('reviews.jsonl'), 'utf8'), guideline: readFileSync(join(root, 'guideline', 'v1.md'), 'utf8') }
    const cookie = await signIn()
    expect((await startTalk(cookie)).status).toBe(200)
    expect((await startTalk(cookie, { project, job_id: 'job-1', fresh: true })).status).toBe(200)
    expect((await propose({ job_id: 'job-1', text: 'New text.' })).status).toBe(200)
    expect({ actions: readFileSync(file('actions.jsonl'), 'utf8'), reviews: readFileSync(file('reviews.jsonl'), 'utf8'), guideline: readFileSync(join(root, 'guideline', 'v1.md'), 'utf8') })
      .toEqual(before)
    expect([readdirSync(join(project, FactoryRecordFile.FOLDER)).sort(), readdirSync(join(root, 'guideline'))]).toEqual([['actions.jsonl', 'reviews.jsonl'], ['v1.md']])
    // The talk folder is outside the project.
    expect(talkFolder().startsWith(project)).toBe(false)
  })

  /** The page of one job in a browser stand-in whose `fetch` is the test's, with the page's script running; links it opens are written down. */
  function talkBrowser(talk: { started?: string; reviews?: ReviewLine[] }, answers: (url: string, init: { method?: string; body?: string }) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
    const reviews = talk.reviews ?? [review({ comment: 'Good pace.' })]
    const shown: RecordedJob = { project, job_id: 'job-1', number: 1, started: NOW, stopped: null, last: NOW, steps: [{ automatic: false, ts: NOW, line: action() }], reviews }
    const entry: ProjectJobs = { project, jobs: [shown], outside: [] }
    const state = talk.started === undefined ? undefined : { project, job_id: 'job-1', number: 1, title: 'Review talk · project job 1', started: talk.started }
    const html = new ReviewPage('nonce').view({ projects: [entry], project: entry, job: shown, outside: false, ...(state === undefined ? {} : { talk: state }) })
    const sent: { url: string; method: string; body: unknown }[] = []
    const opened: string[] = []
    const timers: { run: () => void; ms: number }[] = []
    const window = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:3083/review', beforeParse: view => {
      // The page's repeated question, written down so the test can run it when it likes.
      (view as unknown as { setInterval: unknown }).setInterval = (run: () => void, ms: number) => { timers.push({ run, ms }); return timers.length }
      (view as unknown as { fetch: unknown }).fetch = (url: string, init: { method?: string; body?: string } = {}) => {
        sent.push({ url, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) })
        return answers(url, init)
      }
      // A click on a link would hand its address to the browser; the stand-in writes it down instead, so a test can show the page opens no link.
      view.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { opened.push(this.href) }
    } }).window
    const notice = () => window.document.querySelector('#talk-notice')!
    /** A real click on a link of the page, which runs its handlers (the stand-in `click` above only writes the address down). */
    const press = (link: Element) => { link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) }
    return { window, sent, opened, notice, timers, press }
  }
  const json = (ok: boolean, body: unknown) => Promise.resolve({ ok, json: () => Promise.resolve(body) })

  it('the button posts the job and shows the notice that the talk opened in Orca, with no link, without leaving the page', async () => {
    const page = talkBrowser({}, () => json(true, { opened: true, notice: ReviewPage.TALK_OPENED }))
    expect(page.notice().hasAttribute('hidden')).toBe(true)
    page.window.document.querySelector<HTMLButtonElement>('#start-talk')!.click()
    await settle(); await settle()
    expect(page.sent).toEqual([{ url: ReviewRoute.TALK_PATH, method: 'POST', body: { project, job_id: 'job-1', fresh: false } }])
    expect([page.notice().hasAttribute('hidden'), page.notice().querySelector('span')!.textContent]).toEqual([false, ReviewPage.TALK_OPENED])
    expect([page.notice().querySelector('a'), page.opened, page.window.location.href]).toEqual([null, [], 'http://127.0.0.1:3083/review'])
    page.window.close()
  })

  it('a second click shows the notice that names the talk; "Start a fresh talk instead" posts again with fresh; a refusal shows its reason', async () => {
    const answers = [
      { ok: true, body: { opened: false, notice: 'A review talk for this job was started on 26 Nov 2026. Continue it in Orca: \'Review talk · project job 1\'.', fresh: ReviewPage.FRESH_TALK } },
      { ok: true, body: { opened: true, notice: ReviewPage.TALK_OPENED } },
      { ok: false, body: { error: 'The review talk could not be prepared: the factory\'s mask cannot be had' } },
    ]
    const page = talkBrowser({}, () => { const next = answers.shift()!; return json(next.ok, next.body) })
    page.window.document.querySelector<HTMLButtonElement>('#start-talk')!.click()
    await settle(); await settle()
    expect(page.notice().querySelector('span')!.textContent).toContain('Continue it in Orca')
    expect(page.opened).toEqual([])
    page.press(page.notice().querySelector('#fresh-talk')!)
    await settle(); await settle()
    expect(page.sent.map(each => (each.body as { fresh: boolean }).fresh)).toEqual([false, true])
    expect([page.notice().querySelector('span')!.textContent, page.opened]).toEqual([ReviewPage.TALK_OPENED, []])
    page.window.document.querySelector<HTMLButtonElement>('#start-talk')!.click()
    await settle(); await settle()
    expect(page.notice().textContent).toBe('The review talk could not be prepared: the factory\'s mask cannot be had')
    page.window.close()
  })

  it('ignores a second click, on the button or the fresh link, while a start runs, and takes clicks again once it is answered', async () => {
    let answer: () => void = () => {}
    const page = talkBrowser({ started: '2026-11-25T10:00:00.000Z' }, () => new Promise(resolve => {
      answer = () => { resolve({ ok: true, json: () => Promise.resolve({ opened: true, notice: ReviewPage.TALK_OPENED }) }) }
    }))
    const button = page.window.document.querySelector<HTMLButtonElement>('#start-talk')!
    button.click()
    button.click()
    page.press(page.notice().querySelector('#fresh-talk')!)
    expect([page.sent.length, button.disabled]).toEqual([1, true])
    answer()
    await settle(); await settle()
    expect([button.disabled, page.notice().querySelector('span')!.textContent, page.opened]).toEqual([false, ReviewPage.TALK_OPENED, []])
    button.click()
    expect(page.sent.length).toBe(2)
    page.window.close()
  })

  it('a job with no comment shows the button disabled with the hint; a comment saved on the page enables it and removes the hint, without a reload', async () => {
    const saves = [false, true]
    const page = talkBrowser({ reviews: [] }, url => url === ReviewRoute.COMMENT_PATH ? json(saves.shift()!, {})
      : json(true, { opened: true, notice: ReviewPage.TALK_OPENED }))
    const document = page.window.document
    const button = document.querySelector<HTMLButtonElement>('#start-talk')!
    const hint = () => document.querySelector('#talk-hint')
    expect([button.disabled, hint()?.textContent]).toEqual([true, TalkComments.NONE])
    button.click()
    expect(page.sent).toEqual([])
    const field = document.querySelector<HTMLTextAreaElement>('#comment')!
    // A save that fails leaves the button disabled: the job still has no comment.
    field.value = 'Too slow.'
    field.dispatchEvent(new page.window.FocusEvent('blur'))
    await settle(); await settle()
    expect([page.sent.map(each => each.url), button.disabled, hint()?.textContent]).toEqual([[ReviewRoute.COMMENT_PATH], true, TalkComments.NONE])
    field.dispatchEvent(new page.window.FocusEvent('blur'))
    await settle(); await settle()
    expect([page.sent.map(each => each.url), button.disabled, hint()]).toEqual([[ReviewRoute.COMMENT_PATH, ReviewRoute.COMMENT_PATH], false, null])
    button.click()
    await settle(); await settle()
    expect([page.sent[2]!.url, page.notice().querySelector('span')!.textContent]).toEqual([ReviewRoute.TALK_PATH, ReviewPage.TALK_OPENED])
    page.window.close()
  })

  it('a job with a comment shows the button enabled and no hint; one with only a blank comment counts as none', () => {
    const commented = talkBrowser({}, () => json(true, {}))
    expect([commented.window.document.querySelector<HTMLButtonElement>('#start-talk')!.disabled, commented.window.document.querySelector('#talk-hint')]).toEqual([false, null])
    commented.window.close()
    const blank = talkBrowser({ reviews: [review({ comment: '   ' })] }, () => json(true, {}))
    expect([blank.window.document.querySelector<HTMLButtonElement>('#start-talk')!.disabled, blank.window.document.querySelector('#talk-hint')?.textContent]).toEqual([true, TalkComments.NONE])
    blank.window.close()
  })

  it('a start that ends does not re-enable a button that has to stay disabled, and a comment saved while it runs enables it once it ends', async () => {
    let answer: () => void = () => {}
    const page = talkBrowser({ started: '2026-11-25T10:00:00.000Z', reviews: [] }, url => url === ReviewRoute.COMMENT_PATH ? json(true, {}) : new Promise(resolve => {
      answer = () => { resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: TalkComments.NONE }) }) }
    }))
    const button = page.window.document.querySelector<HTMLButtonElement>('#start-talk')!
    page.press(page.notice().querySelector('#fresh-talk')!)
    expect([page.sent.length, button.disabled]).toEqual([1, true])
    answer()
    await settle(); await settle()
    expect([button.disabled, page.notice().textContent]).toEqual([true, TalkComments.NONE])
    // Again, with a comment saved while the start runs: the button is pressable once the start is answered, not before.
    const fresh = talkBrowser({ started: '2026-11-25T10:00:00.000Z', reviews: [] }, url => url === ReviewRoute.COMMENT_PATH ? json(true, {}) : new Promise(resolve => {
      answer = () => { resolve({ ok: true, json: () => Promise.resolve({ opened: true, notice: ReviewPage.TALK_OPENED }) }) }
    }))
    const again = fresh.window.document.querySelector<HTMLButtonElement>('#start-talk')!
    fresh.press(fresh.notice().querySelector('#fresh-talk')!)
    const field = fresh.window.document.querySelector<HTMLTextAreaElement>('#comment')!
    field.value = 'Too slow.'
    field.dispatchEvent(new fresh.window.FocusEvent('blur'))
    await settle(); await settle()
    expect(again.disabled).toBe(true)
    answer()
    await settle(); await settle()
    expect(again.disabled).toBe(false)
    page.window.close(); fresh.window.close()
  })

  it('shows the reason of any answer that is not OK in the notice, from a real 409 answer and from one with no JSON', async () => {
    const answers = [
      new Response(JSON.stringify({ error: TalkComments.NONE }), { status: 409, headers: { 'content-type': 'application/json; charset=utf-8' } }),
      new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    ]
    // A job with a comment, so the button is pressable; the server's 409 is what a stale page would get.
    const page = talkBrowser({}, () => Promise.resolve(answers.shift()!))
    const button = page.window.document.querySelector<HTMLButtonElement>('#start-talk')!
    button.click()
    await settle(); await settle()
    expect([page.notice().hasAttribute('hidden'), page.notice().textContent, page.notice().classList.contains('refused'), button.disabled]).toEqual([false, TalkComments.NONE, true, false])
    button.click()
    await settle(); await settle()
    expect(page.notice().textContent).toBe(`${ReviewPage.CANNOT_PREPARE}the review page answered HTTP 502`)
    page.window.close()
  })

  it('a job whose talk was started shows its notice on opening, and its fresh link posts with fresh', async () => {
    const page = talkBrowser({ started: '2026-11-25T10:00:00.000Z' }, () => json(true, { opened: true, notice: ReviewPage.TALK_OPENED }))
    expect(page.notice().querySelector('span')!.textContent).toBe('A review talk for this job was started on 25 Nov 2026. Continue it in Orca: \'Review talk · project job 1\'.')
    page.press(page.notice().querySelector('#fresh-talk')!)
    await settle(); await settle()
    expect(page.sent).toEqual([{ url: ReviewRoute.TALK_PATH, method: 'POST', body: { project, job_id: 'job-1', fresh: true } }])
    expect(page.window.location.href).toBe('http://127.0.0.1:3083/review')
    page.window.close()
  })

  it('the proposal notice appears without a reload: the page asks when its window gets focus, and every 5 seconds', async () => {
    {
      let waiting: object[] = []
      const page = talkBrowser({}, () => json(true, { waiting }))
      const notice = page.window.document.querySelector('#proposal-notice')!
      expect([notice.hasAttribute('hidden'), page.sent]).toEqual([true, []])
      waiting = [{ project, job_id: 'job-1', number: 1, ts: NOW, href: ReviewRoute.proposalAddress(project, 'job-1') }]
      page.window.dispatchEvent(new page.window.Event('focus'))
      await settle(); await settle()
      expect(page.sent).toEqual([{ url: ReviewRoute.PROPOSAL_PATH, method: 'GET', body: undefined }])
      expect([notice.hasAttribute('hidden'), page.window.document.querySelector('#proposal-link')!.getAttribute('href')]).toEqual([false, ReviewRoute.proposalAddress(project, 'job-1')])
      waiting = []
      expect(page.timers.map(timer => timer.ms)).toEqual([ReviewPage.POLL_MS])
      page.timers[0]!.run()
      await settle(); await settle()
      expect([page.sent.length, notice.hasAttribute('hidden')]).toEqual([2, true])
      page.window.close()
    }
  })
})

describe('the owner\'s answer to a proposal', () => {
  /** A stand-in for the guideline's save path: it writes down what it was asked to save and answers what the test says. */
  class Saver implements GuidelineAnswerer {
    busy = false
    readonly asked: GuidelineProposal[] = []
    answer: GuidelineSaved = { saved: true, version: 2, mr: 'https://gitlab.example/factory/-/merge_requests/7' }
    async accept(proposal: GuidelineProposal, _base: number | null): Promise<GuidelineSaved> { this.asked.push(proposal); return this.answer }
    readonly reports: number[] = []
    async report(version: number): Promise<GuidelineSaved> { this.reports.push(version); return this.answer }
  }
  const TEXT = '# Guideline\nKeep to the minimum feature.\nAsk first.\n'
  /** A page with v1 and one proposal for job 1 waiting, as a talk's tool leaves it. */
  async function waiting(saver?: Saver): Promise<string> {
    put('actions.jsonl', [action()])
    put('reviews.jsonl', [review()])
    mkdirSync(join(root, 'guideline'), { recursive: true })
    writeFileSync(join(root, 'guideline', 'v1.md'), '# Guideline\nKeep it small.\nAsk first.\n')
    await serve(undefined, undefined, undefined, saver)
    reviewRoute!.proposals.put({ project, job_id: 'job-1', number: 1, text: TEXT, ts: NOW })
    return signIn()
  }
  const answer = (cookie: string | undefined, body: unknown, headers: Record<string, string | undefined> = {}) =>
    call('POST', ReviewRoute.ANSWER_PATH, { origin: origin(), cookie, 'content-type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body))
  const listed = async (cookie: string) => (JSON.parse((await call('GET', ReviewRoute.PROPOSAL_PATH, { cookie })).text) as { waiting: unknown[] }).waiting.length

  it('Accept saves the proposal shown through the saver, drops it, and sends the page to the new version', async () => {
    const saver = new Saver()
    const cookie = await waiting(saver)
    const accepted = await answer(cookie, { project, job_id: 'job-1', ts: NOW, answer: 'accept', base: 1 })
    expect([accepted.status, JSON.parse(accepted.text)]).toEqual([200, { answered: 'accepted', version: 2, href: ReviewRoute.guidelineAddress(2), mr: 'https://gitlab.example/factory/-/merge_requests/7' }])
    expect(saver.asked).toEqual([{ project, job_id: 'job-1', number: 1, text: TEXT, ts: NOW }])
    expect(await listed(cookie)).toBe(0)
  })

  it('Reject drops the proposal and saves nothing', async () => {
    const saver = new Saver()
    const cookie = await waiting(saver)
    const rejected = await answer(cookie, { project, job_id: 'job-1', ts: NOW, answer: 'reject' })
    expect([rejected.status, JSON.parse(rejected.text)]).toEqual([200, { answered: 'rejected', href: ReviewRoute.guidelineAddress() }])
    expect([saver.asked, await listed(cookie), readdirSync(join(root, 'guideline'))]).toEqual([[], 0, ['v1.md']])
    // The Guideline tab shows the current version again, and the proposal view is gone.
    expect((await call('GET', ReviewRoute.proposalAddress(project, 'job-1'), { cookie })).status).toBe(404)
  })

  it('a failed save keeps the proposal and answers 503 with the step and the merge request\'s address', async () => {
    const saver = new Saver()
    saver.answer = { saved: false, reason: 'Not saved: the merge step failed: merge conflict', mr: 'https://gitlab.example/factory/-/merge_requests/8' }
    const cookie = await waiting(saver)
    const failed = await answer(cookie, { project, job_id: 'job-1', ts: NOW, answer: 'accept', base: 1 })
    expect([failed.status, JSON.parse(failed.text)]).toEqual([503, { error: 'Not saved: the merge step failed: merge conflict', mr: 'https://gitlab.example/factory/-/merge_requests/8' }])
    expect(await listed(cookie)).toBe(1)
  })

  it('a newer proposal that comes while the save runs stays, and the saver is told the version the page showed', async () => {
    const saver = new Saver()
    const cookie = await waiting(saver)
    const bases: (number | null)[] = []
    saver.accept = async (_shown: GuidelineProposal, base: number | null): Promise<GuidelineSaved> => {
      bases.push(base)
      reviewRoute!.proposals.put({ project, job_id: 'job-1', number: 1, text: `${TEXT}Newer.\n`, ts: '2026-11-26T12:05:00.000Z' })
      return { saved: true, version: 2, mr: undefined }
    }
    expect((await answer(cookie, { project, job_id: 'job-1', ts: NOW, answer: 'accept', base: 1 })).status).toBe(200)
    expect(bases).toEqual([1])
    const left = JSON.parse((await call('GET', ReviewRoute.PROPOSAL_PATH, { cookie })).text) as { waiting: { ts: string }[] }
    expect(left.waiting.map(each => each.ts)).toEqual(['2026-11-26T12:05:00.000Z'])
    // An Accept that does not say which version it was shown against is refused.
    for (const base of [undefined, 0, 1.5, '1']) expect((await answer(cookie, { project, job_id: 'job-1', ts: '2026-11-26T12:05:00.000Z', answer: 'accept', base })).status).toBe(400)
  })

  it('answers only the proposal shown: a newer one for the job is not answered, and stays', async () => {
    const saver = new Saver()
    const cookie = await waiting(saver)
    reviewRoute!.proposals.put({ project, job_id: 'job-1', number: 1, text: `${TEXT}Newer.\n`, ts: '2026-11-26T12:05:00.000Z' })
    for (const choice of ['accept', 'reject']) {
      const stale = await answer(cookie, { project, job_id: 'job-1', ts: NOW, answer: choice, base: 1 })
      expect([stale.status, (JSON.parse(stale.text) as { error: string }).error]).toEqual([409, 'A newer proposal for this job replaced the one shown, so nothing was answered. Reload the page to see it.'])
    }
    expect([saver.asked, await listed(cookie)]).toEqual([[], 1])
  })

  it('refuses a bad answer, a proposal not waiting, a save already running, and Accept without a saver; and needs DSH\'s sign-in and an Origin', async () => {
    const saver = new Saver()
    const cookie = await waiting(saver)
    const status = async (body: unknown, headers: Record<string, string | undefined> = {}, signedIn: string | null = cookie) => (await answer(signedIn ?? undefined, body, headers)).status
    expect(await status({ project, job_id: 'job-1', ts: NOW, answer: 'maybe' })).toBe(400)
    expect(await status({ project, job_id: 'job-1', answer: 'accept' })).toBe(400)
    expect(await status('not json')).toBe(400)
    expect(await status({ project, job_id: 'job-2', ts: NOW, answer: 'accept', base: 1 })).toBe(404)
    expect(await status({ project, job_id: 'job-1', ts: NOW, answer: 'accept', base: 1 }, {}, null)).toBe(401)
    expect(await status({ project, job_id: 'job-1', ts: NOW, answer: 'accept', base: 1 }, { origin: 'https://elsewhere.example' })).toBe(403)
    expect((await call('GET', ReviewRoute.ANSWER_PATH, { cookie })).status).toBe(405)
    saver.busy = true
    expect(await status({ project, job_id: 'job-1', ts: NOW, answer: 'accept', base: 1 })).toBe(409)
    expect([saver.asked, await listed(cookie)]).toEqual([[], 1])
    // The page with no saver given saves nothing, so no default ever runs git; Reject still works there.
    await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
    const plain = await waiting()
    const refused = await answer(plain, { project, job_id: 'job-1', ts: NOW, answer: 'accept', base: 1 })
    expect([refused.status, (JSON.parse(refused.text) as { error: string }).error]).toEqual([503, 'Not saved: saving a guideline version is not set up here'])
    expect((await answer(plain, { project, job_id: 'job-1', ts: NOW, answer: 'reject' })).status).toBe(200)
  })

  it('the buttons post the answer for the proposal shown, go to the address the answer names, and show a refusal with the merge request\'s link', async () => {
    const read: GuidelineRead = { folder: '/factory/guideline', versions: [{ version: 1, date: null, from_job: null, from_version: null, text: '# Guideline\n' }], current: null, reason: null }
    read.current = read.versions[0]!
    const open: GuidelineProposal = { project, job_id: 'job-1', number: 1, text: TEXT, ts: NOW }
    const html = new ReviewPage('nonce').guideline(read, undefined, [open], open)
    let reply: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { answered: 'accepted', version: 2, href: ReviewRoute.guidelineAddress(2) } }
    const sent: unknown[] = []
    // jsdom cannot navigate: it reports each navigation the page asks for, and the test counts them.
    const went: string[] = []
    const browse = () => {
      const virtualConsole = new VirtualConsole()
      virtualConsole.on('jsdomError', error => { if (error.message.includes('navigation')) went.push(error.message) })
      const window = new JSDOM(html, { runScripts: 'dangerously', virtualConsole, url: 'http://127.0.0.1:3083/review?tab=guideline', beforeParse: view => {
        (view as unknown as { setInterval: unknown }).setInterval = () => 0
        ;(view as unknown as { fetch: unknown }).fetch = (url: string, init: { method?: string; body?: string } = {}) => {
          if (url === ReviewRoute.PROPOSAL_PATH) return Promise.resolve({ ok: true, json: () => Promise.resolve({ waiting: [] }) })
          sent.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) })
          return Promise.resolve({ ok: reply.ok, status: reply.status, json: () => Promise.resolve(reply.body) })
        }
      } }).window
      const document = window.document
      return { window, accept: document.getElementById('accept-proposal') as HTMLButtonElement, reject: document.getElementById('reject-proposal') as HTMLButtonElement,
        notice: document.getElementById('answer-notice')! }
    }
    const ok = browse()
    expect(ok.notice.hasAttribute('hidden')).toBe(true)
    ok.accept.click()
    expect([ok.accept.disabled, ok.reject.disabled, ok.notice.textContent]).toEqual([true, true, ReviewPage.savingWithReport(1)])
    await settle(); await settle(); await settle()
    expect(sent).toEqual([{ url: ReviewRoute.ANSWER_PATH, method: 'POST', body: { project, job_id: 'job-1', ts: NOW, answer: 'accept', base: 1 } }])
    expect(went.length).toBe(1)
    ok.window.close()
    // A failed save: the reason and the link to the merge request, as text; the buttons work again.
    reply = { ok: false, status: 503, body: { error: 'Not saved: the merge step failed: <b>conflict</b>', mr: 'https://gitlab.example/factory/-/merge_requests/8' } }
    const page = browse()
    page.accept.click()
    await settle(); await settle(); await settle()
    expect([page.notice.querySelector('span')!.textContent, page.notice.querySelector('b'), page.notice.querySelector('a')!.getAttribute('href'), page.notice.classList.contains('refused')])
      .toEqual(['Not saved: the merge step failed: <b>conflict</b>', null, 'https://gitlab.example/factory/-/merge_requests/8', true])
    expect([page.accept.disabled, page.reject.disabled, went.length]).toEqual([false, false, 1])
    // A refused Reject shows its reason; a link that is not https is never shown.
    reply = { ok: false, status: 409, body: { error: 'A newer proposal for this job replaced the one shown', mr: 'javascript:alert(1)' } }
    page.reject.click()
    await settle(); await settle(); await settle()
    expect([(sent.at(-1) as { body: { answer: string } }).body.answer, page.notice.querySelector('a')]).toEqual(['reject', null])
    page.window.close()
  })

  const trends = (cookie: string | undefined, body: unknown, headers: Record<string, string | undefined> = {}) =>
    call('POST', ReviewRoute.TRENDS_PATH, { origin: origin(), cookie, 'content-type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body))

  it('"Write trend report" asks the saver for the current version\'s report and sends the page to that version; a failure answers 503 with the step and the merge request', async () => {
    const saver = new Saver()
    saver.answer = { saved: true, version: 1, mr: 'https://gitlab.example/factory/-/merge_requests/9' }
    const cookie = await waiting(saver)
    const written = await trends(cookie, { version: 1 })
    expect([written.status, JSON.parse(written.text)]).toEqual([200, { written: 1, href: ReviewRoute.guidelineAddress(1), mr: 'https://gitlab.example/factory/-/merge_requests/9' }])
    expect(saver.reports).toEqual([1])
    saver.answer = { saved: false, reason: 'Not saved: the merge step failed: not mergeable', mr: 'https://gitlab.example/factory/-/merge_requests/10' }
    const failed = await trends(cookie, { version: 1 })
    expect([failed.status, JSON.parse(failed.text)]).toEqual([503, { error: 'Not saved: the merge step failed: not mergeable', mr: 'https://gitlab.example/factory/-/merge_requests/10' }])
  })

  it('refuses a report of a version that is not current, a bad body, a save running, and the button without a saver; and needs DSH\'s sign-in and an Origin', async () => {
    const saver = new Saver()
    const cookie = await waiting(saver)
    const status = async (body: unknown, headers: Record<string, string | undefined> = {}, signedIn: string | null = cookie) => (await trends(signedIn ?? undefined, body, headers)).status
    const notCurrent = await trends(cookie, { version: 2 })
    expect([notCurrent.status, (JSON.parse(notCurrent.text) as { error: string }).error]).toEqual([409, 'Not saved: only the current version\'s trend report can be written. Reload the page.'])
    for (const body of [{}, { version: 0 }, { version: 1.5 }, { version: '1' }, 'not json']) expect(await status(body)).toBe(400)
    expect(await status({ version: 1 }, {}, null)).toBe(401)
    expect(await status({ version: 1 }, { origin: 'https://elsewhere.example' })).toBe(403)
    expect((await call('GET', ReviewRoute.TRENDS_PATH, { cookie })).status).toBe(405)
    saver.busy = true
    expect(await status({ version: 1 })).toBe(409)
    expect(saver.reports).toEqual([])
    await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
    const plain = await waiting()
    const refused = await trends(plain, { version: 1 })
    expect([refused.status, (JSON.parse(refused.text) as { error: string }).error]).toEqual([503, 'Not saved: writing a trend report is not set up here'])
  })

  it('shows the picked version\'s report beside it, with when it was written; the current version has the button, an older one without a report says none was written', () => {
    const versions: GuidelineVersion[] = [3, 2, 1].map(version => ({ version, date: `2026-11-2${version}`, from_job: null, from_version: null, text: `Text of v${version}.` }))
    const read: GuidelineRead = { folder: '/factory/guideline', versions, current: versions[0]!, reason: null, reports: [
      { version: 2, date: '2026-11-24', jobs: 5, compared_with: 1, written: 'accepted', text: '# Trend report for guideline v2\n\nCompared with v1.\n\n<b>Fewer</b> wide approvals.\n' },
    ] }
    const pageOf = (version: number) => dom(new ReviewPage('n').guideline(read, versions.find(each => each.version === version)))
    const v2 = pageOf(2)
    expect([...v2.querySelectorAll('nav a.version')].map(row => row.querySelectorAll('span')[2]!.textContent)).toEqual(['No trend report yet', 'Trend report · 5 jobs', 'No trend report yet'])
    expect([v2.querySelector('aside.report h2')!.textContent, v2.querySelector('aside.report .pill')!.textContent, v2.querySelector('#write-trend')]).toEqual(['Trend report for v2', 'written 24 Nov, when v3 replaced it', null])
    expect([v2.querySelector('.report-text')!.textContent, v2.querySelector('.report-text b')]).toEqual(['# Trend report for guideline v2\n\nCompared with v1.\n\n<b>Fewer</b> wide approvals.', null])
    expect(v2.querySelector('.cols')!.classList.contains('with-detail')).toBe(true)
    const v3 = pageOf(3)
    expect([v3.querySelector('#write-trend')!.textContent, v3.querySelector('#write-trend')!.getAttribute('data-replace'), v3.querySelector('aside.report .meta')!.textContent])
      .toEqual(['Write trend report for v3', null, 'No trend report yet for v3.'])
    expect(pageOf(1).querySelector('aside.report .meta')!.textContent).toBe(ReviewPage.NONE_WRITTEN)
    // With a report there, the current version's button asks before it replaces it.
    const replaced = dom(new ReviewPage('n').guideline({ ...read, reports: [{ version: 3, date: '2026-11-26', jobs: 1, compared_with: 2, written: 'asked', text: 'R' }] }, versions[0]))
    expect([replaced.querySelector('#write-trend')!.getAttribute('data-replace'), replaced.querySelector('aside.report .pill')!.textContent])
      .toEqual(['Replace the report written on 26 Nov?', 'written 26 Nov, on request'])
    // The button sits in the panel's header, beside its title.
    expect(replaced.querySelector('aside.report .head #write-trend')).not.toBeNull()
    // A report file that says no date, no job count or no reason still reads plainly, and a date not in the usual form is shown as written.
    const plain = (fields: Partial<TrendReport>) => dom(new ReviewPage('n').guideline({ ...read, reports: [{ version: 3, date: null, jobs: null, compared_with: null, written: null, text: 'R', ...fields }] }, versions[0]))
    const undated = plain({})
    expect([undated.querySelector('nav a.version')!.querySelectorAll('span')[2]!.textContent, undated.querySelector('aside.report .pill')!.textContent,
      undated.querySelector('#write-trend')!.getAttribute('data-replace')]).toEqual(['Trend report', 'written on a day not recorded', ReviewPage.REPLACE_UNDATED])
    expect(plain({ date: 'late Nov' }).querySelector('aside.report .pill')!.textContent).toBe('written late Nov')
  })

  it('the button asks before it replaces a report, says the report is being written, posts the version and goes where the answer names; a refusal shows its reason', async () => {
    const versions: GuidelineVersion[] = [{ version: 2, date: '2026-11-22', from_job: null, from_version: 1, text: 'Two.' }]
    const read: GuidelineRead = { folder: '/factory/guideline', versions, current: versions[0]!, reason: null, reports: [{ version: 2, date: '2026-11-26', jobs: 1, compared_with: 1, written: 'asked', text: 'R' }] }
    const html = new ReviewPage('nonce').guideline(read, versions[0])
    let reply: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { written: 2, href: ReviewRoute.guidelineAddress(2) } }
    let confirmed = true
    const sent: unknown[] = [], went: string[] = [], asked: string[] = []
    const browse = () => {
      const virtualConsole = new VirtualConsole()
      virtualConsole.on('jsdomError', error => { if (error.message.includes('navigation')) went.push(error.message) })
      const window = new JSDOM(html, { runScripts: 'dangerously', virtualConsole, url: 'http://127.0.0.1:3083/review?tab=guideline', beforeParse: view => {
        (view as unknown as { setInterval: unknown }).setInterval = () => 0
        ;(view as unknown as { confirm: unknown }).confirm = (text: string) => { asked.push(text); return confirmed }
        ;(view as unknown as { fetch: unknown }).fetch = (url: string, init: { method?: string; body?: string } = {}) => {
          if (url === ReviewRoute.PROPOSAL_PATH) return Promise.resolve({ ok: true, json: () => Promise.resolve({ waiting: [] }) })
          sent.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) })
          return Promise.resolve({ ok: reply.ok, status: reply.status, json: () => Promise.resolve(reply.body) })
        }
      } }).window
      return { window, button: window.document.getElementById('write-trend') as HTMLButtonElement, notice: window.document.getElementById('trend-notice')! }
    }
    // The owner says no to replacing it: nothing is sent.
    confirmed = false
    const no = browse()
    no.button.click()
    await settle()
    expect([asked, sent]).toEqual([['Replace the report written on 26 Nov?'], []])
    no.window.close()
    confirmed = true
    const ok = browse()
    ok.button.click()
    expect([ok.button.disabled, ok.notice.textContent, ok.notice.hasAttribute('hidden')]).toEqual([true, ReviewPage.writingTrend(2), false])
    await settle(); await settle(); await settle()
    expect([sent, went.length]).toEqual([[{ url: ReviewRoute.TRENDS_PATH, method: 'POST', body: { version: 2 } }], 1])
    ok.window.close()
    reply = { ok: false, status: 503, body: { error: 'Not saved: the trend report for v2 could not be written: the report thread gave no answer', mr: 'https://gitlab.example/factory/-/merge_requests/8' } }
    const page = browse()
    page.button.click()
    await settle(); await settle(); await settle()
    expect([page.notice.querySelector('span')!.textContent, page.notice.querySelector('a')!.getAttribute('href'), page.notice.classList.contains('refused'), page.button.disabled])
      .toEqual(['Not saved: the trend report for v2 could not be written: the report thread gave no answer', 'https://gitlab.example/factory/-/merge_requests/8', true, false])
    page.window.close()
  })
})

/** The factory's folder, when the environment says where it is: its built job log file and its review sample are read from it. */
const FACTORY = process.env.ZEES_FACTORY_DIR?.trim() ?? ''
const realTitle = FACTORY === '' ? 'the factory\'s real built JobsReader (SKIPPED: set ZEES_FACTORY_DIR to the factory\'s folder to run it)' : 'the factory\'s real built JobsReader'

describe.skipIf(FACTORY === '')(realTitle, () => {
  const built = join(FACTORY, 'lib', 'dist', 'jobLog.js')
  /**
   * The real built file, with its step reader looking for worker transcripts in `claudeHome` instead of this machine's Claude home.
   * The plugin itself builds the reader with no arguments (`FactoryRecordsModule.stepReader`), which the last test checks.
   */
  class SampleRecords extends FactoryRecordsModule {
    constructor(private readonly claudeHome: string, private readonly factoryDir = join(root, 'factory')) { super(built) }
    override async stepReader(): Promise<StepSource> {
      const { StepDetailReader } = await import(built) as { StepDetailReader: new (options: { claudeHome: string }) => StepSource }
      return new StepDetailReader({ claudeHome: this.claudeHome })
    }
    /** The real guideline reader, pointed at a throwaway factory folder that holds a copy of the sample's guideline (`lib/fixtures/guideline`). */
    override async guidelineReader(): Promise<GuidelineSource> {
      const { GuidelineReader } = await import(built) as { GuidelineReader: new (options: { factoryDir: string }) => GuidelineSource }
      return new GuidelineReader({ factoryDir: this.factoryDir })
    }
  }
  /**
   * Writes the factory's review sample (`lib/fixtures/review-jobs.json`) into two projects, its worker transcripts into a Claude home, and serves the page
   * with the real built file.
   */
  async function serveSample(): Promise<{ a: string; b: string; cookie: string }> {
    const a = join(root, 'project-a'), b = join(root, 'project-b'), claudeHome = join(root, 'claude-home')
    let text = readFileSync(join(FACTORY, 'lib', 'fixtures', 'review-jobs.json'), 'utf8')
    text = text.replaceAll('<project-a>', a).replaceAll('<project-b>', b)
    const sample = JSON.parse(text) as { projects: Record<string, Record<string, (string | object)[]>>; transcripts: Record<string, object[]> }
    for (const [folder, files] of Object.entries(sample.projects)) {
      mkdirSync(join(folder, FactoryRecordFile.FOLDER), { recursive: true })
      for (const [name, written] of Object.entries(files)) if (written.length > 0) put(name, written, folder)
    }
    const transcripts = join(claudeHome, 'projects', '-sample-worktree')
    mkdirSync(transcripts, { recursive: true })
    for (const [session, written] of Object.entries(sample.transcripts)) writeFileSync(join(transcripts, `${session}.jsonl`), written.map(line => JSON.stringify(line)).join('\n') + '\n')
    cpSync(join(FACTORY, 'lib', 'fixtures', 'guideline'), join(root, 'factory', 'guideline'), { recursive: true })
    expect(existsSync(built), `${built} is missing: run the factory's build`).toBe(true)
    const records = new SampleRecords(claudeHome)
    // The real built propose server, next to the real built job log file.
    await serve([a, b], records, talksFor(records, join(FACTORY, 'lib', 'dist', 'proposeServer.js')))
    return { a, b, cookie: await signIn() }
  }
  const jobsOf = (page: Document) => [...page.querySelectorAll('nav a.job')].map(link => [...link.querySelectorAll('span')].filter(part => part.parentElement === link).map(part => part.textContent))
  const rowsOf = (page: Document) => [...page.querySelectorAll('ol li')].map(row => [row.getAttribute('data-automatic'), row.querySelector('.pill')?.textContent ?? null, row.querySelector('div')!.textContent])

  it('lists the sample\'s three jobs under the right projects, newest first, the crashed one ended without a stop', async () => {
    const { a, b, cookie } = await serveSample()
    const first = dom((await call('GET', ReviewRoute.address(a), { cookie })).text)
    expect([...first.querySelectorAll('nav a.proj')].map(link => link.textContent)).toEqual(['project-a', 'project-b'])
    expect(jobsOf(first)).toEqual([
      ['Job 2 v1', expect.stringMatching(/ · ended without a stop$/), '3 steps · no comments yet'],
      ['Job 1', expect.stringMatching(/ · 1 h 00 min$/), '5 steps · 1 comment'],
      ['Outside a job', '1 automatic answer'],
    ])
    const second = dom((await call('GET', ReviewRoute.address(b), { cookie })).text)
    expect(jobsOf(second)).toEqual([['Job 1', expect.stringMatching(/ · 30 min$/), '4 steps · no comments yet'], ['Outside a job', '1 automatic answer']])
  })

  it('shows the automatic answers in the timeline labelled automatic, with no comment box, and the ones outside a job on their own', async () => {
    const { a, b, cookie } = await serveSample()
    const job = dom((await call('GET', ReviewRoute.address(a, 'job-a1'), { cookie })).text)
    expect(rowsOf(job)).toEqual([
      [null, null, 'The super agent started.'],
      ['allow', 'automatic yes', 'Asked: git status'],
      [null, null, 'Approved: run the upload tests.'],
      ['allow', 'automatic yes', 'Asked: git push origin story-4-2'],
      [null, null, 'The super agent stopped.'],
    ])
    expect([job.querySelectorAll('textarea').length, job.querySelectorAll('ol textarea').length, job.querySelector('textarea')!.value]).toEqual([1, 0, 'Good pace.'])
    const outside = dom((await call('GET', ReviewRoute.address(a, undefined, true), { cookie })).text)
    expect([rowsOf(outside), outside.querySelector('textarea')]).toEqual([[['refuse', 'automatic no', 'Asked: {"file_path":"/etc/hosts","content":"x"}']], null])
    const other = dom((await call('GET', ReviewRoute.address(b), { cookie })).text)
    expect(rowsOf(other).map(row => row[1])).toEqual([null, null, 'automatic no', null])
  })

  it('shows all five parts of the sample\'s permission answer, with the same tokens and time as its decision record', async () => {
    const { a, cookie } = await serveSample()
    const page = dom((await call('GET', ReviewRoute.address(a, 'job-a1', false, 'a1-2'), { cookie })).text)
    const decision = JSON.parse(lines('decisions.jsonl', a)[0]!) as { decision_id: string; tokens: number; seconds: number }
    expect(decision.decision_id).toBe('decision-a1')
    expect(partsOf(page)).toEqual([
      ['What was asked', 'Tool: Bash · bun testReason given by the worker: Run the tests.Session worker-1'],
      ['Why', 'Approved · risk lowRunning the story\'s own tests changes nothing outside the worktree.Rests on: story 4.2: the upload tests must pass'],
      ['What it looked at', 'stories/4-2.md · usedpackage.json · not used'],
      ['What happened next', 'Ran and succeeded12 pass\n0 fail'],
      ['Cost', `${decision.tokens} tokens · ${decision.seconds.toFixed(1)} s`],
    ])
    expect(partsOf(page).at(-1)).toEqual(['Cost', '980 tokens · 2.2 s'])
  })

  it('shows the sample\'s message with its text, sender and receiver, and says the other parts are not recorded', async () => {
    const { a, cookie } = await serveSample()
    const page = dom((await call('GET', ReviewRoute.address(a, 'job-a2', false, 'a2-2'), { cookie })).text)
    expect(partsOf(page)).toEqual([
      ['What was asked', 'owner ──▶ super agentStart the ready stories.'],
      ['Why', 'Not recorded'], ['What it looked at', 'Not recorded'], ['What happened next', 'Not recorded'], ['Cost', 'Not recorded'],
    ])
  })

  it('shows an automatic answer\'s detail with the fixed checks\' answer, and the plugin\'s own step reader loads from the built file', async () => {
    const { a, cookie } = await serveSample()
    const page = dom((await call('GET', ReviewRoute.address(a, 'job-a1', false, 'req-a-yes'), { cookie })).text)
    expect(partsOf(page).slice(0, 2)).toEqual([
      ['What was asked', 'Tool: Bash · git push origin story-4-2Reason given by the worker: Share the branch.Session worker-1'],
      ['Why', 'automatic yes · answered by the fixed checks · not reviewed'],
    ])
    expect(typeof (await new FactoryRecordsModule(built).stepReader()).read).toBe('function')
  })

  it('keeps a comment on a job, comments on two steps and a change to one as four masked lines, and shows the changed text once', async () => {
    const { a, cookie } = await serveSample()
    rmSync(file('reviews.jsonl', a))
    const secret = 'sk-made-up-0000000000000000'
    for (const body of [{ comment: 'Good pace.' }, { step_id: 'a2-2', comment: 'Too wide.' }, { step_id: 'a2-3', comment: `Never print ${secret}.` },
      { step_id: 'a2-2', comment: 'Ask me next time.' }]) {
      expect((await comment(cookie, { project: a, job_id: 'job-a2', ...body })).status).toBe(200)
    }
    const written = lines('reviews.jsonl', a).map(line => JSON.parse(line) as ReviewLine)
    expect(written.map(line => [line.job_id, line.step_id ?? null])).toEqual([['job-a2', null], ['job-a2', 'a2-2'], ['job-a2', 'a2-3'], ['job-a2', 'a2-2']])
    // The real mask cleaned the planted secret before the line was written.
    expect(readFileSync(file('reviews.jsonl', a), 'utf8')).not.toContain(secret)
    expect(written[2]!.comment).toMatch(/^Never print \S+\.$/)
    const html = (await call('GET', ReviewRoute.address(a, 'job-a2'), { cookie })).text
    expect([html.includes(secret), html.includes('Too wide.')]).toEqual([false, false])
    const entries = [...dom(html).querySelectorAll('ul.comments li')].map(entry => [entry.querySelector('strong')!.textContent, entry.querySelector('.mine')!.textContent])
    expect(entries).toEqual([[ReviewPage.WHOLE_JOB, 'You: Good pace.'], ['Message received', 'You: Ask me next time.'], ['Session started', `You: ${written[2]!.comment}`]])
  })

  it('lists the sample guideline\'s versions and opens version 2 with its text, date and the job it came from', async () => {
    const { cookie } = await serveSample()
    const list = dom((await call('GET', ReviewRoute.guidelineAddress(), { cookie })).text)
    expect([...list.querySelectorAll('nav a.version')].map(link => [...link.querySelectorAll('span')].map(part => part.textContent)))
      .toEqual([['v2 · current', '2026-11-24 · from the review of job job-a1', 'No trend report yet'], ['v1', '2026-11-20', 'No trend report yet']])
    const page = dom((await call('GET', ReviewRoute.guidelineAddress(2), { cookie })).text)
    expect([page.querySelector('main h2')!.textContent, page.querySelector('main .meta')!.textContent]).toEqual(['Guideline v2 · current', '2026-11-24 · from the review of job job-a1'])
    expect(page.querySelector('.guideline-text')!.textContent).toBe(readFileSync(join(FACTORY, 'lib', 'fixtures', 'guideline', 'v2.md'), 'utf8').split('---\n')[2])
    // The plugin's own reader comes from the same built file and is built with no location: it finds the factory repository itself.
    expect(typeof (await new FactoryRecordsModule(built).guidelineReader()).read).toBe('function')
  })

  /** Every file under a folder, as paths below it, sorted. */
  const filesUnder = (folder: string) => readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(folder.length + 1)).filter(name => !name.startsWith('.git/')).sort()
  /** Starts the talk of the sample's job-a1, which has the whole job's comment, after a second comment on its permission answer. */
  async function startSampleTalk(a: string, cookie: string): Promise<{ folder: string }> {
    expect((await comment(cookie, { project: a, job_id: 'job-a1', step_id: 'a1-2', comment: 'Keep to the minimum feature.' })).status).toBe(200)
    const answer = await call('POST', ReviewRoute.TALK_PATH, { origin: origin(), cookie, 'content-type': 'application/json' }, JSON.stringify({ project: a, job_id: 'job-a1' }))
    const body = JSON.parse(answer.text) as { opened: boolean }
    expect([answer.status, body.opened]).toEqual([200, true])
    const folder = readdirSync(talkRoot()).map(name => join(talkRoot(), name))[0]!
    return { folder }
  }
  /** Starts the server `.mcp.json` names as Claude Code would, `${HOME}` expanded, and calls its tool over standard input and output once per text. */
  async function proposeOverStdio(folder: string, texts: readonly string[]): Promise<{ isError?: boolean; content: { text: string }[] }[]> {
    const mcp = JSON.parse(readFileSync(join(folder, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }
    const { command, args } = mcp.mcpServers[TalkFolder.SERVER_NAME]!
    const expand = (value: string) => value.replaceAll('${HOME}', homedir())
    const child = spawn(expand(command), args.map(expand), { cwd: folder, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    const answerTo = async (id: number) => {
      for (let tries = 0; tries < 200; tries++) {
        const found = out.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as { id?: number; result?: unknown }).find(each => each.id === id)
        if (found) return found.result
        await new Promise(resolve => { setTimeout(resolve, 25) })
      }
      throw new Error(`no answer to ${id}`)
    }
    const send = (message: object) => { child.stdin.write(`${JSON.stringify(message)}\n`) }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    await answerTo(1)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const results = []
    for (const [index, text] of texts.entries()) {
      send({ jsonrpc: '2.0', id: 10 + index, method: 'tools/call', params: { name: 'propose_guideline_change', arguments: { job_id: 'job-a1', text } } })
      results.push(await answerTo(10 + index) as { isError?: boolean; content: { text: string }[] })
    }
    child.stdin.end()
    await new Promise(resolve => { child.on('close', resolve) })
    return results
  }

  it('starts the sample job\'s talk, and the built propose server, started with Node over stdio, proposes twice: the page shows the newer text and no record changed', async () => {
    const { a, cookie } = await serveSample()
    const recordsBefore = () => ({ actions: readFileSync(file('actions.jsonl', a), 'utf8'), reviews: readFileSync(file('reviews.jsonl', a), 'utf8'),
      guideline: Object.fromEntries(readdirSync(join(root, 'factory', 'guideline')).map(name => [name, readFileSync(join(root, 'factory', 'guideline', name), 'utf8')])) })
    const { folder } = await startSampleTalk(a, cookie)
    const before = recordsBefore()
    expect(filesUnder(folder)).toEqual(['.claude/settings.json', '.mcp.json', 'comments.md', 'guideline.md', 'job.md', 'opening.md', 'talk.json'])
    expect(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8')).toBe(TalkFolder.SETTINGS)
    const message = readFileSync(join(folder, 'opening.md'), 'utf8')
    for (const part of ['Review talk · project-a job 1', 'Good pace.', 'Keep to the minimum feature.', 'Reject a feature for an edge case', 'never job text, comments, project code or a file path']) {
      expect(message).toContain(part)
    }
    const current = readFileSync(join(FACTORY, 'lib', 'fixtures', 'guideline', 'v2.md'), 'utf8').split('---\n')[2]!
    const results = await proposeOverStdio(folder, [`${current}- First idea.\n`, `${current}- Ask before adding a dependency.\n`])
    expect(results.map(result => [result.isError ?? false, result.content[0]!.text])).toEqual([[false, expect.stringContaining('is on the review page')], [false, expect.stringContaining('is on the review page')]])
    const view = dom((await call('GET', ReviewRoute.proposalAddress(a, 'job-a1'), { cookie })).text)
    expect([...view.querySelectorAll('.halves ins')].map(each => each.textContent)).toEqual(['- Ask before adding a dependency.'])
    expect(view.querySelector('.halves h3')!.textContent).toBe('Guideline v2 · current')
    expect(recordsBefore()).toEqual(before)
    expect(readdirSync(join(a, FactoryRecordFile.FOLDER)).sort()).toEqual(['actions.jsonl', 'decisions.jsonl', 'requests.jsonl', 'reviews.jsonl'])
  })

  it('writes masked copies only: a secret and the owner\'s home path planted raw in the job log, the comments and the guideline are in no talk file and no Orca argument', async () => {
    const { a, cookie } = await serveSample()
    const secret = 'sk-made-up-0000000000000000', home = `${homedir()}/private-notes.md`
    // Planted raw, past every mask: straight into the files on disk.
    put('actions.jsonl', [...lines('actions.jsonl', a), JSON.stringify({ ts: '2026-11-22T11:30:00.000Z', project: a, job_id: 'job-a1', step_id: 'a1-planted', kind: 'message_in',
      summary: `Read ${home} and use ${secret}.`, from: 'owner', to: 'super agent' })], a)
    put('reviews.jsonl', [...lines('reviews.jsonl', a), JSON.stringify({ ts: '2026-11-22T12:30:00.000Z', project: a, job_id: 'job-a1', comment: `Never print ${secret}; see ${home}.` })], a)
    const v2 = join(root, 'factory', 'guideline', 'v2.md')
    writeFileSync(v2, `${readFileSync(v2, 'utf8')}- Keep ${secret} out of ${home}.\n`)
    const { folder } = await startSampleTalk(a, cookie)
    for (const name of filesUnder(folder)) {
      const text = readFileSync(join(folder, name), 'utf8')
      expect([name, text.includes(secret), text.includes(homedir())]).toEqual([name, false, false])
    }
    // The planted texts did reach the talk, masked.
    expect(readFileSync(join(folder, 'comments.md'), 'utf8')).toContain('~/private-notes.md')
    expect(readFileSync(join(folder, 'guideline.md'), 'utf8')).toContain('~/private-notes.md')
    expect(readFileSync(join(folder, 'job.md'), 'utf8')).toContain('~/private-notes.md')
    expect(readFileSync(join(folder, 'opening.md'), 'utf8')).toContain('~/private-notes.md')
    const argv = orcaCalls.flat().join('\n')
    expect([orcaCalls.length > 0, argv.includes(secret), argv.includes('private-notes')]).toEqual([true, false, false])
  })
})
