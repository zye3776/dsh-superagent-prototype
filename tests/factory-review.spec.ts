/** The factory's review page, served by a real HTTP server on loopback, reading and writing a temporary project through a stand-in records module. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/factory/index.ts'
import { FactoryRecordFile, FactoryRecordsModule, type JobLogLine, type ReviewLine } from '../src/factory/records.ts'
import { ReviewAccess, ReviewPage, ReviewRoute, type ReviewedJob } from '../src/factory/review.ts'
import { SharedTokenFile } from '../src/factory/token.ts'
import { PLANTED, REDACTED, recordsModule } from './fixtures/factory-records.ts'

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

/** Serves the page of a fake DSH web server over real HTTP, reading the token file and the stand-in records module of the test. */
async function serve(projects: string[] = [project], records: FactoryRecordsModule = new FactoryRecordsModule(recordsModule(root))): Promise<Route[]> {
  routes = []
  // DSH's `exact` routes match the path alone, without the query.
  server = createServer((req, res) => { void routes.find(route => route.path === new URL(req.url ?? '/', 'http://127.0.0.1').pathname)!.handler(req, res) })
  await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
  const ctx = { webServer: { host: '127.0.0.1', port, register: (registered: Route) => { routes.push(registered); return () => {} } } }
  new ReviewRoute(projects, new SharedTokenFile(tokenPath()), records, () => new Date(NOW)).register(ctx as never)
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
/** Posts the sign-in form as a browser does: from the page's own origin, the token in the body. */
const login = (token: string, headers: Record<string, string | undefined> = {}) =>
  call('POST', '/review/login', { origin: origin(), 'content-type': 'application/x-www-form-urlencoded', ...headers }, new URLSearchParams({ token }).toString())
/** Signs in and returns the `Cookie` header a browser would send from then on. */
async function signIn(): Promise<string> {
  const answer = await login(TOKEN)
  expect(answer.status).toBe(303)
  return answer.headers['set-cookie']![0]!.split(';')[0]!
}
/** Posts a comment as the page's script does. */
const comment = (cookie: string | undefined, body: unknown, headers: Record<string, string | undefined> = {}) =>
  call('POST', '/review/comment', { origin: origin(), cookie, 'content-type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body))
/** The page as a document, to read what a browser would show. */
const dom = (html: string) => new JSDOM(html).window.document

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-review-'))
  project = join(root, 'project')
  mkdirSync(join(project, FactoryRecordFile.FOLDER), { recursive: true })
  writeToken()
})
afterEach(async () => {
  await new Promise<void>(resolve => { server ? server.close(() => { resolve() }) : resolve() })
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

it('registers three exact, anonymous routes and refuses a web server that is not on loopback', async () => {
  const registered = await serve()
  expect(registered.map(route => [route.kind, route.path, route.auth])).toEqual([['exact', '/review', 'anonymous'], ['exact', '/review/login', 'anonymous'],
    ['exact', '/review/comment', 'anonymous']])
  const disposed: string[] = []
  const ctx = { webServer: { host: '127.0.0.1', port: 3083, register: (route: Route) => () => { disposed.push(route.path) } } }
  new ReviewRoute([project]).register(ctx as never)()
  expect(disposed).toEqual(['/review', '/review/login', '/review/comment'])
  expect(() => new ReviewRoute([project]).register({ webServer: { host: '0.0.0.0', port: 3083, register: () => () => {} } } as never)).toThrow('loopback')
  expect(() => new ReviewRoute(['relative/project'])).toThrow('absolute')
})

it('answers 401 with the sign-in form and no record content to a request without the token\'s cookie', async () => {
  await serve()
  put('actions.jsonl', [action()])
  put('reviews.jsonl', [review()])
  const forged = `${ReviewAccess.COOKIE}=${'0'.repeat(64)}`
  for (const cookie of [undefined, forged, `${ReviewAccess.COOKIE}=${TOKEN}`, `${ReviewAccess.COOKIE}=`, 'other=1']) {
    const answer = await call('GET', '/review', { cookie })
    expect([cookie, answer.status]).toEqual([cookie, 401])
    // Nothing of the job or the comment is in the body, and nothing was signed in.
    for (const content of ['The first job started.', 'Keep it small.', 'job-1', project]) expect(answer.text).not.toContain(content)
    expect(answer.headers['set-cookie']).toBeUndefined()
    const form = dom(answer.text).querySelector('form')!
    expect([form.getAttribute('method'), form.getAttribute('action')]).toEqual(['post', '/review/login'])
    // One token field, and the token goes in the body of a POST, never in the address.
    expect([...form.querySelectorAll('input')].map(input => [input.name, input.type])).toEqual([['token', 'password']])
    expect(dom(answer.text).querySelector('textarea')).toBeNull()
  }
})

it('signs in with the right token: 303 to /review with a strict, script-proof cookie that is not the token', async () => {
  await serve()
  put('actions.jsonl', [action()])
  const answer = await login(TOKEN)
  expect([answer.status, answer.headers.location, answer.text]).toEqual([303, '/review', ''])
  const [cookie] = answer.headers['set-cookie']!
  expect(cookie).toMatch(new RegExp(`^${ReviewAccess.COOKIE}=[0-9a-f]{64}; Path=/review; HttpOnly; SameSite=Strict$`))
  expect(cookie).not.toContain(TOKEN)
  const page = await call('GET', '/review', { cookie: cookie!.split(';')[0] })
  expect(page.status).toBe(200)
  expect(page.text).toContain('The first job started.')
  // A browser may send the page's own Origin with a GET; other cookies beside this one do not matter.
  expect((await call('GET', '/review', { cookie: `a=b; ${cookie!.split(';')[0]}; c=d`, origin: origin() })).status).toBe(200)
  // A token pasted with the line break that ends the token file still signs in.
  expect((await login(`${TOKEN}\n`)).status).toBe(303)
  // Reached as localhost, the page's own origin is localhost.
  expect((await login(TOKEN, { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status).toBe(303)
})

it('refuses a wrong or empty token with 401, and answers 503 without a usable token file; neither sets a cookie', async () => {
  await serve()
  for (const typed of [OTHER_TOKEN, `${TOKEN}0`, '', ' ']) {
    const answer = await login(typed)
    expect([typed, answer.status, answer.headers['set-cookie']]).toEqual([typed, 401, undefined])
    expect(dom(answer.text).querySelector('[role=alert]')!.textContent).toBe('The token is missing or wrong')
    expect(answer.text).not.toContain(TOKEN)
  }
  // A form without the field at all.
  expect((await call('POST', '/review/login', { origin: origin() }, 'other=1')).status).toBe(401)
  writeToken(TOKEN, 0o644)
  expect([(await login(TOKEN)).status, (await login(TOKEN)).headers['set-cookie']]).toEqual([503, undefined])
  rmSync(tokenPath())
  const answer = await login(TOKEN)
  expect([answer.status, answer.headers['set-cookie']]).toEqual([503, undefined])
  expect(dom(answer.text).querySelector('[role=alert]')!.textContent).toBe('The review page has no usable token file, so nobody can sign in')
  // With no token file nobody is signed in, whatever cookie is sent.
  expect((await call('GET', '/review', { cookie: `${ReviewAccess.COOKIE}=${'0'.repeat(64)}` })).status).toBe(401)
})

it('stops accepting a cookie when the token file is replaced, and accepts it again after a restart with the same token', async () => {
  await serve()
  const cookie = await signIn()
  expect((await call('GET', '/review', { cookie })).status).toBe(200)
  writeToken(OTHER_TOKEN)
  expect((await call('GET', '/review', { cookie })).status).toBe(401)
  writeToken(TOKEN)
  // Another route object, as after a restart of DSH: the cookie needs no stored state.
  await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
  await serve()
  expect((await call('GET', '/review', { cookie })).status).toBe(200)
})

it('refuses a wrong Host and a foreign Origin with 403 on every address, before anything is read or written', async () => {
  await serve()
  put('actions.jsonl', [action()])
  const cookie = await signIn()
  const body = JSON.stringify({ job_id: 'job-1', comment: 'Should not be saved.' })
  const form = new URLSearchParams({ token: TOKEN }).toString()
  const refusals: Record<string, string | undefined>[] = [
    { host: `evil.example:${port}` }, { host: '127.0.0.1' }, { host: `127.0.0.1:${port + 1}` }, { host: `192.168.1.5:${port}` },
    { origin: 'http://evil.example' }, { origin: `https://127.0.0.1:${port}` }, { origin: `http://localhost:${port}` }, { origin: 'null' },
  ]
  for (const headers of refusals) {
    const page = await call('GET', '/review', { cookie, ...headers })
    expect([headers, page.status]).toEqual([headers, 403])
    expect(page.text).not.toContain('The first job started.')
    const signed = await call('POST', '/review/login', { origin: origin(), ...headers }, form)
    expect([headers, signed.status, signed.headers['set-cookie']]).toEqual([headers, 403, undefined])
    const saved = await call('POST', '/review/comment', { origin: origin(), cookie, ...headers }, body)
    expect([headers, saved.status]).toEqual([headers, 403])
  }
  // A POST must say where it comes from: a browser always does, so one without an Origin is not the page.
  expect((await call('POST', '/review/login', {}, form)).status).toBe(403)
  expect((await call('POST', '/review/comment', { cookie }, body)).status).toBe(403)
  expect(existsSync(file('reviews.jsonl'))).toBe(false)
})

/** A request handed straight to the route, so the test can say which address the caller connects from. */
function direct(remoteAddress: string | undefined, method: string, headers: Record<string, string>, body = '') {
  const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: '/review', socket: { remoteAddress }, headers: { host: '127.0.0.1:3083', ...headers } })
  const resume = vi.spyOn(req, 'resume')
  const answer = { status: 0, headers: {} as Record<string, string>, text: '' }
  const res = { writeHead: (status: number, sent: Record<string, string>) => { answer.status = status; answer.headers = sent }, end: (text = '') => { answer.text = text } }
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, answer, resume }
}

it('refuses a caller whose address is not loopback, whatever its Host header and cookie say', async () => {
  put('actions.jsonl', [action()])
  const route = new ReviewRoute([project], new SharedTokenFile(tokenPath()), new FactoryRecordsModule(recordsModule(root)), () => new Date(NOW))
  // A real cookie, taken from a sign-in over loopback.
  const signing = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083' }, new URLSearchParams({ token: TOKEN }).toString())
  await route.handle(signing.req, signing.res, 3083, 'login')
  expect(signing.answer.status).toBe(303)
  const cookie = signing.answer.headers['set-cookie']!.split(';')[0]!
  const body = JSON.stringify({ job_id: 'job-1', comment: 'Should not be saved.' })
  for (const address of ['192.168.1.9', '10.0.0.1', '::ffff:192.168.1.9', 'fe80::1', '127.0.0.2', '', undefined]) {
    const page = direct(address, 'GET', { cookie })
    await route.handle(page.req, page.res, 3083, 'page')
    expect([address, page.answer.status]).toEqual([address, 403])
    expect(page.answer.text).not.toContain('The first job started.')
    const signed = direct(address, 'POST', { origin: 'http://127.0.0.1:3083' }, new URLSearchParams({ token: TOKEN }).toString())
    await route.handle(signed.req, signed.res, 3083, 'login')
    expect([address, signed.answer.status, signed.answer.headers['set-cookie']]).toEqual([address, 403, undefined])
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

it('shows the newest job: its lines in time order and an always-open comment field with its newest comment, and no Save button', async () => {
  const other = join(root, 'other')
  mkdirSync(join(other, FactoryRecordFile.FOLDER), { recursive: true })
  await serve([project, other])
  // An older job in the first project, and the newest job in the second, its lines written out of time order.
  put('actions.jsonl', [action()])
  put('reviews.jsonl', [review()])
  put('actions.jsonl', [
    action({ project: other, job_id: 'job-2', step_id: 'step-b', ts: '2026-11-26T11:30:00.000Z', summary: 'Second line of the newest job.' }),
    action({ project: other, job_id: 'job-2', step_id: 'step-a', ts: '2026-11-26T11:00:00.000Z', summary: 'First line of the newest job.' }),
    action({ project: other, job_id: 'job-0', step_id: 'step-z', ts: '2026-11-25T07:00:00.000Z', summary: 'The oldest job.' }),
  ], other)
  put('reviews.jsonl', [
    review({ project: other, job_id: 'job-2', ts: '2026-11-26T11:40:00.000Z', comment: 'An earlier comment.' }),
    review({ project: other, job_id: 'job-2', ts: '2026-11-26T11:50:00.000Z', comment: 'The newest comment <b>&</b> "quoted".' }),
    review({ project: other, job_id: 'job-0', ts: '2026-11-26T11:55:00.000Z', comment: 'On another job.' }),
  ], other)
  const cookie = await signIn()
  const answer = await call('GET', '/review', { cookie })
  expect(answer.status).toBe(200)
  const page = dom(answer.text)
  expect([...page.querySelectorAll('ol li')].map(row => [row.querySelector('time')!.textContent, row.querySelector('strong')!.textContent, row.querySelector('div')!.textContent]))
    .toEqual([['2026-11-26T11:00:00.000Z', 'Job started', 'First line of the newest job.'], ['2026-11-26T11:30:00.000Z', 'Job started', 'Second line of the newest job.']])
  const field = page.querySelector('textarea')!
  expect([field.id, field.dataset.job, field.value, field.disabled, field.readOnly]).toEqual(['comment', 'job-2', 'The newest comment <b>&</b> "quoted".', false, false])
  // The comment is text in the field, never markup of the page.
  expect(page.querySelector('b')).toBeNull()
  expect(page.querySelector('#comment-status')!.textContent).toBe('')
  // No button, no form, no dialog: the field saves by itself.
  expect([page.querySelector('button'), page.querySelector('form'), page.querySelector('dialog'), page.querySelector('input')]).toEqual([null, null, null, null])
  // Plain links to the other jobs, the newer first.
  expect([...page.querySelectorAll('nav a')].map(link => [link.getAttribute('href'), link.textContent]))
    .toEqual([['/review?job=job-1', '2026-11-26T08:00:00.000Z'], ['/review?job=job-0', '2026-11-25T07:00:00.000Z']])
  // Another job on request, with its own comment.
  const first = dom((await call('GET', '/review?job=job-1', { cookie })).text)
  expect([first.querySelector('ol li div')!.textContent, first.querySelector('textarea')!.value]).toEqual(['The first job started.', 'Keep it small.'])
  const unknown = await call('GET', '/review?job=nope', { cookie })
  expect([unknown.status, dom(unknown.text).querySelector('textarea')]).toEqual([404, null])
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
    // same-origin, not no-referrer: under no-referrer a browser sends Origin: null with the sign-in form, which admit refuses (owner's check, story 3.1).
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

it('says "No job recorded yet." when no listed project holds a job, and skips lines it cannot read', async () => {
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
  expect(dom((await call('GET', '/review', { cookie })).text).querySelector('textarea')!.value).toBe(`Reject this; never print ${REDACTED}.`)
})

it('saves nothing without access: no cookie or a wrong one is 401', async () => {
  await serve()
  put('actions.jsonl', [action()])
  for (const cookie of [undefined, `${ReviewAccess.COOKIE}=${'0'.repeat(64)}`]) {
    const answer = await comment(cookie, { job_id: 'job-1', comment: 'Should not be saved.' })
    expect([answer.status, JSON.parse(answer.text)]).toEqual([401, { error: 'Sign in with the shared token first' }])
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
  for (const [method, path, allow] of [['POST', '/review', 'GET'], ['PUT', '/review', 'GET'], ['DELETE', '/review/comment', 'POST'], ['PUT', '/review/login', 'POST']] as const) {
    const answer = await call(method, path, { origin: origin(), cookie }, '{}')
    expect([method, path, answer.status, answer.headers.allow]).toEqual([method, path, 405, allow])
  }
  for (const path of ['/review/login', '/review/comment']) expect([path, (await call('GET', path, { cookie })).status]).toEqual([path, 405])
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
  const kept = JSON.stringify([action()])
  await serve([project], new FactoryRecordsModule(recordsModule(root, `export const JobLogMask = { forProject: () => ({ maskAction: line => line, maskReview: line => line }) }
export class JobLogReader { read() { return { actions: ${kept}, reviews: [] } } }\n`)))
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
  const href = page.querySelector('nav a')!.getAttribute('href')!
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

it('answers 500 with one fixed text when something else fails, and repeats nothing of the error', async () => {
  await serve([project], new FactoryRecordsModule(recordsModule(root, `export const JobLogMask = { forProject: () => ({ maskAction: line => line, maskReview: line => line }) }
export class JobLogReader { read() { throw new Error(${JSON.stringify(PLANTED)}) } }\n`)))
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
  const { req } = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083' }, new URLSearchParams({ token: TOKEN }).toString())
  const writeHead = vi.fn(), destroy = vi.fn()
  // The headers went out, then ending the answer fails.
  const res = { headersSent: false, writeHead: (...sent: unknown[]) => { writeHead(...sent); res.headersSent = true }, end: () => { throw new Error('broken pipe') }, destroy }
  await expect(route.handle(req, res as unknown as ServerResponse, 3083, 'login')).resolves.toBeUndefined()
  expect([writeHead.mock.calls.length, destroy.mock.calls.length]).toEqual([1, 1])
})

/** The page of one job in a browser stand-in whose `fetch` is the test's, with the page's script running. */
function browser(job: Partial<ReviewedJob>, fetch: (url: string, init: { method: string; body: string; credentials: string; headers: Record<string, string> }) => Promise<{ ok: boolean }>) {
  const html = new ReviewPage('nonce').job({ job_id: 'job-1', project, started: NOW, lines: [action()], comment: '', ...job }, [])
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
  expect(sent).toEqual([{ url: '/review/comment', method: 'POST', body: { job_id: 'job-1', comment: 'Reject this at this stage.' }, credentials: 'same-origin', type: 'application/json' }])
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

it('is wired into the plugin: the page reads the configured token file and the configured records module', async () => {
  put('actions.jsonl', [action()])
  const registered: Route[] = []
  const info = vi.fn(), warn = vi.fn()
  const ctx = { webServer: { host: '127.0.0.1', port: 3083, register: (route: Route) => { registered.push(route); return () => {} } },
    effect: (effect: () => () => void) => effect(), logger: { info, warn } }
  plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: tokenPath(), recordsModule: recordsModule(root) }))
  const handler = (path: string) => registered.find(route => route.path === path)!.handler
  const signing = direct('127.0.0.1', 'POST', { origin: 'http://127.0.0.1:3083' }, new URLSearchParams({ token: TOKEN }).toString())
  await handler('/review/login')(signing.req, signing.res)
  expect(signing.answer.status).toBe(303)
  const page = direct('127.0.0.1', 'GET', { cookie: signing.answer.headers['set-cookie']!.split(';')[0]! })
  await handler('/review')(page.req, page.res)
  expect([page.answer.status, page.answer.text.includes('The first job started.')]).toEqual([200, true])
  const unsigned = direct('127.0.0.1', 'GET', {})
  await handler('/review')(unsigned.req, unsigned.res)
  expect(unsigned.answer.status).toBe(401)
  // The token reaches no log line.
  await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
  expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toContain(TOKEN)
  expect([plugin.ReviewRoute, plugin.ReviewPage, plugin.ReviewAccess]).toEqual([ReviewRoute, ReviewPage, ReviewAccess])
})
