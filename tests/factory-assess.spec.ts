/** The factory's `/assess` route, served by a real HTTP server on loopback, writing into a temporary project. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PendingApprovals } from '../src/factory/approvals.ts'
import { AssessRoute, DecisionsFile, StubJudge, TempFactsShape, type AssessRequest, type Judge, type TempFacts, type Verdict } from '../src/factory/assess.ts'
import { DecisionWriter, FactoryMaskModule } from '../src/factory/decisions.ts'
import { FactoryGuardModule, JudgeSessions } from '../src/factory/judge.ts'
import * as plugin from '../src/factory/index.ts'
import { AskKey, SharedTokenFile } from '../src/factory/token.ts'
import { ModelJudge } from '../src/factory/verdict.ts'
import { fakeDsh, fakeGuard } from './fixtures/judge.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
interface Route { kind: string; path: string; auth?: string; handler: Handler }
interface Answer { status: number; text: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }

const NOW = '2026-11-23T08:09:10.123Z'
/** The token both sides share in these tests, another one of the same length, and one of another length. */
const TOKEN = 'test-token_0123456789abcdefghijklmnopqrstuvwxyz'
const OTHER_TOKEN = 'test-token_0123456789abcdefghijklmnopqrstuvwxyZ'
const LONGER_TOKEN = `${TOKEN}0`
let root = '', project = '', server: Server | undefined, port = 0
/** The route's token file: outside the project, as the real one is. */
const tokenPath = () => join(root, 'superagent-token')
function writeToken(content: string = TOKEN, mode = 0o600): void {
  rmSync(tokenPath(), { force: true })
  writeFileSync(tokenPath(), content)
  // Set after writing: the mode given to writeFileSync is cut down by the umask.
  chmodSync(tokenPath(), mode)
}
/**
 * A stand-in for the factory's built mask file, with the same export. It marks `reason`, so a test can tell that the line went through it, and it wraps a
 * request's `tool_input`, so a test can tell the masked input the judge sees from the raw input the key is made of.
 */
const maskPath = () => join(root, 'fake-mask.mjs')
const MASKED = ' [masked]'
const MASKED_REQUEST = ' [masked request]'
/** The fake key of a request: readable, so a test can tell that it was made from the raw values. */
const keyOf = (session: string, tool: string, input: unknown) => `key:${JSON.stringify([session, tool, input])}`
const FAKE_MASK = `export const DecisionMask = {
  requestKey: (session, tool, input) => 'key:' + JSON.stringify([session, tool, input]),
  forProject: () => ({
    mask: line => ({ ...line, reason: line.reason + ${JSON.stringify(MASKED)} }),
    maskRequest: fields => ({ ...fields, tool_input: { masked: fields.tool_input }, reason: fields.reason + ${JSON.stringify(MASKED_REQUEST)}, ...('context' in fields ? { context: fields.context + ${JSON.stringify(MASKED_REQUEST)} } : {}) }),
  }),
}\n`
/** The mask file of a factory from before "ask first": it masks a decision, and nothing else. */
const OLD_MASK = `export const DecisionMask = { forProject: () => ({ mask: line => line }) }\n`
/** The route's writer, loading the mask module at `path`. */
const writer = (path: string | undefined = maskPath()) => new DecisionWriter(new FactoryMaskModule(path))
const file = () => join(project, DecisionsFile.FOLDER, DecisionsFile.FILE)
const lines = () => readFileSync(file(), 'utf8').split('\n').filter(line => line !== '')
/** A masked request as the factory posts it; `project` is the raw path. */
const sample = (fields: Record<string, unknown> = {}) => ({ request_id: 'req-1', request_key: 'k1', session_id: 's1', tool_name: 'Bash',
  tool_input: { command: 'ls' }, reason: 'List files', project, ...fields })

/** What a fake judge Session answers in these tests: an approve, as the one JSON object `ModelJudge` reads. */
const JUDGED = 'Judged by the model.'
const judgeReply = () => JSON.stringify({ decision: 'approve', risk: 'low', undo: 'easy', reason: JUDGED, alternative: '', cites: 'Ticket 5', reads: [] })

/**
 * Serves the route of a fake DSH web server over real HTTP, reading the token file and the fake mask of the test, and returns the route as it was registered.
 * The stub decides unless a test gives another judge.
 */
let routes = new Map<string, Route>()
async function serve(projects: string[] = [project], mask: DecisionWriter = writer(), judge: Judge = new StubJudge(), approvals?: PendingApprovals): Promise<Route> {
  routes = new Map<string, Route>()
  // Each request goes to the route registered for its path, as DSH's web server sends it.
  server = createServer((req, res) => { void routes.get(req.url ?? '')!.handler(req, res) })
  await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
  const ctx = { webServer: { host: '127.0.0.1', port, register: (registered: Route) => { routes.set(registered.path, registered); return () => {} } } }
  new AssessRoute(projects, new SharedTokenFile(tokenPath()), judge, () => new Date(NOW), mask, approvals).register(ctx as never)
  return routes.get('/assess')!
}
/** Sends one request to `path` with the valid token, unless `headers` gives another one or `undefined` for none. */
function call(method: string, body?: unknown, headers: Record<string, string | undefined> = {}, path = '/assess'): Promise<Answer> {
  const sent = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return new Promise((resolve, reject) => {
    // Without a length, Node sends the body in chunks, so the route cannot refuse it by its length up front.
    const length = sent && !('transfer-encoding' in headers) ? { 'content-length': String(sent.length) } : {}
    const all = Object.fromEntries(Object.entries({ [SharedTokenFile.HEADER]: TOKEN, ...length, ...headers }).filter(([, value]) => value !== undefined))
    const req = request({ host: '127.0.0.1', port, path, method, headers: all as Record<string, string> }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: res.statusCode ?? 0, text, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers }) }
        catch (error) { reject(error as Error) }
      })
    })
    req.on('error', reject)
    req.end(sent)
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-assess-'))
  project = join(root, 'project')
  mkdirSync(join(project, DecisionsFile.FOLDER), { recursive: true })
  writeToken()
  writeFileSync(maskPath(), FAKE_MASK)
})
afterEach(async () => {
  await new Promise<void>(resolve => { server ? server.close(() => { resolve() }) : resolve() })
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

it('registers three exact, anonymous routes, removes them together, and refuses a web server that is not on loopback', async () => {
  const route = await serve()
  expect({ kind: route.kind, path: route.path, auth: route.auth }).toEqual({ kind: 'exact', path: '/assess', auth: 'anonymous' })
  expect([...routes.values()].map(({ kind, path, auth }) => ({ kind, path, auth }))).toEqual(['/assess', '/ask', '/claim'].map(path => ({ kind: 'exact', path, auth: 'anonymous' })))
  const removed: string[] = []
  const counting = { webServer: { host: '127.0.0.1', port: 3083, register: (registered: Route) => () => { removed.push(registered.path) } } }
  new AssessRoute([project]).register(counting as never)()
  expect(removed).toEqual(['/assess', '/ask', '/claim'])
  const ctx = { webServer: { host: '192.168.1.5', port: 3083, register: () => () => {} } }
  expect(() => new AssessRoute([project]).register(ctx as never)).toThrow('loopback')
  expect(() => new AssessRoute(['relative/project'])).toThrow('absolute')
})

it('answers a valid request with the stub decision, masked, and appends the same line last', async () => {
  await serve()
  writeFileSync(file(), '{"earlier":true}\n')
  const answer = await call('POST', sample())
  expect(answer.status).toBe(200)
  expect(answer.body).toEqual({ decision_id: expect.stringMatching(/^[0-9a-f-]{36}$/), request_id: 'req-1', kind: 'permission', decision: 'ask_owner',
    choice: null, risk: 'high', tier: 1, tier_set_by: 'judge', reason: `${StubJudge.REASON}${MASKED}`, alternative: '', cites: StubJudge.CITES, reads: [], tokens: 0, seconds: expect.any(Number),
    ts: NOW, project })
  // The factory's decision shape refuses an empty `cites`.
  expect(StubJudge.CITES).not.toBe('')
  expect(answer.body.seconds).toBeGreaterThanOrEqual(0)
  expect(lines()).toEqual(['{"earlier":true}', answer.text])
  // The reply carries the token in its header, and the token is in neither the reply's body nor the file.
  expect(answer.headers[SharedTokenFile.HEADER]).toBe(TOKEN)
  expect(readFileSync(file(), 'utf8')).not.toContain(TOKEN)
  // A second request gets a decision of its own, after the first.
  const second = await call('POST', sample({ request_id: 'req-2' }), { host: `localhost:${port}` })
  expect(second.body.request_id).toBe('req-2')
  expect(second.body.decision_id).not.toBe(answer.body.decision_id)
  expect(lines()).toEqual(['{"earlier":true}', answer.text, second.text])
})

/** Temp-folder facts as the factory's hook sends them: one path in `/tmp`, outside the session's own temp folder. */
const tempFacts = (): TempFacts => ({ session_dir: '/private/tmp/claude-502/-project/session/scratchpad',
  paths: [{ path: '/private/tmp/x', in_session_dir: false, created_by_session: false, in_exception: false }], variable_delete: false })

it('hands a well-formed temp to the judge unchanged, and a request without one as it is', async () => {
  const asked: AssessRequest[] = []
  const stub = new StubJudge()
  await serve([project], writer(), { decide: (request) => { asked.push(request); return stub.decide(request) } })
  const facts = tempFacts()
  const none: TempFacts = { session_dir: null, paths: [], variable_delete: true }
  for (const temp of [facts, none, null]) expect((await call('POST', sample({ temp }))).status).toBe(200)
  expect((await call('POST', sample())).status).toBe(200)

  expect(asked.map(request => request.temp)).toEqual([facts, none, null, undefined])
  expect('temp' in asked[3]!).toBe(false)
  // The rest of the request reaches the judge with it, and each request left its decision.
  expect(asked[0]).toEqual(sample({ temp: facts }))
  expect(lines()).toHaveLength(4)
  expect(plugin.TempFactsShape).toBe(TempFactsShape)
})

it('refuses a temp that is not null or the agreed facts with 400, and writes nothing', async () => {
  const asked: AssessRequest[] = []
  const stub = new StubJudge()
  await serve([project], writer(), { decide: (request) => { asked.push(request); return stub.decide(request) } })
  const facts = tempFacts()
  const fact = facts.paths[0]!
  const malformed: unknown[] = [
    { paths: 'x' }, 'facts', 7, true, [], [facts], {},
    { ...facts, session_dir: 7 }, { ...facts, session_dir: undefined }, { ...facts, paths: undefined }, { ...facts, paths: {} },
    { ...facts, variable_delete: 'false' }, { ...facts, variable_delete: undefined }, { ...facts, extra: true },
    { ...facts, paths: [null] }, { ...facts, paths: ['/tmp/x'] }, { ...facts, paths: [[]] },
    { ...facts, paths: [{ ...fact, path: 7 }] }, { ...facts, paths: [{ ...fact, in_session_dir: 'false' }] },
    { ...facts, paths: [{ ...fact, created_by_session: 0 }] }, { ...facts, paths: [{ ...fact, in_exception: null }] },
    { ...facts, paths: [{ ...fact, in_exception: undefined }] }, { ...facts, paths: [{ ...fact, extra: 1 }] }, { ...facts, paths: [fact, { path: '/tmp/y' }] },
  ]
  for (const temp of malformed) {
    const answer = await call('POST', sample({ temp }))
    expect([answer.status, answer.body], JSON.stringify(temp)).toEqual([400, { error: 'The request has a malformed temp' }])
  }
  expect(asked).toEqual([])
  expect(existsSync(file())).toBe(false)
})

it('answers 503 and writes nothing when no mask module is configured, when it does not load, and when its masker throws', async () => {
  const broken = join(root, 'broken-mask.mjs')
  writeFileSync(broken, 'export const DecisionMask = { forProject: () => ({ mask: () => { throw new Error("planted-detail") } }) }\n')
  for (const mask of [writer(''), new DecisionWriter(), writer(join(root, 'missing-mask.mjs')), writer(broken)]) {
    await serve([project], mask)
    const answer = await call('POST', sample())
    expect(answer.status).toBe(503)
    expect(Object.keys(answer.body)).toEqual(['error'])
    // The refusal does not repeat the mask's own error, which could quote the line.
    expect(answer.text).not.toContain('planted-detail')
    expect(answer.headers[SharedTokenFile.HEADER]).toBeUndefined()
    await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
    server = undefined
  }
  expect(existsSync(file())).toBe(false)
})

it('refuses a project that is not listed or has no .factory folder, and writes nothing', async () => {
  await serve()
  const other = join(root, 'other')
  mkdirSync(join(other, DecisionsFile.FOLDER), { recursive: true })
  const unlisted = await call('POST', sample({ project: other }))
  expect([unlisted.status, unlisted.body]).toEqual([403, { error: 'The project is not listed in the factory configuration' }])
  expect(existsSync(join(other, DecisionsFile.FOLDER, DecisionsFile.FILE))).toBe(false)

  rmSync(join(project, DecisionsFile.FOLDER), { recursive: true })
  const bare = await call('POST', sample())
  expect([bare.status, bare.body]).toEqual([409, { error: 'The project has no .factory folder yet' }])
  // The route never creates the folder.
  expect(existsSync(join(project, DecisionsFile.FOLDER))).toBe(false)
})

it('refuses to write through a symlink at the folder or at the file', async () => {
  await serve()
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  const target = join(elsewhere, 'target.txt')
  writeFileSync(target, 'untouched\n')
  symlinkSync(target, file())
  expect((await call('POST', sample())).status).toBe(409)
  expect(readFileSync(target, 'utf8')).toBe('untouched\n')

  rmSync(join(project, DecisionsFile.FOLDER), { recursive: true })
  symlinkSync(elsewhere, join(project, DecisionsFile.FOLDER))
  expect((await call('POST', sample())).status).toBe(409)
  expect(existsSync(join(elsewhere, DecisionsFile.FILE))).toBe(false)
})

it('refuses a body that is not JSON, too large, or without request_id or project, and writes nothing', async () => {
  await serve()
  expect((await call('POST', '{not json')).status).toBe(400)
  expect((await call('POST', [sample()])).status).toBe(400)
  expect((await call('POST', sample({ request_id: undefined }))).body).toEqual({ error: 'The request has no request_id' })
  expect((await call('POST', sample({ request_id: 7 }))).status).toBe(400)
  expect((await call('POST', sample({ project: undefined }))).body).toEqual({ error: 'The request has no project' })
  const nameless = await call('POST', sample({ session_id: undefined }))
  expect([nameless.status, nameless.body]).toEqual([400, { error: 'The request has no session_id' }])
  expect((await call('POST', sample({ session_id: '' }))).status).toBe(400)
  expect((await call('POST', sample({ session_id: 7 }))).status).toBe(400)
  const large = sample({ reason: 'x'.repeat(AssessRoute.MAX_BODY_BYTES) })
  expect((await call('POST', large)).status).toBe(413)
  // The same upload sent in pieces, without a length the route could refuse up front.
  expect((await call('POST', large, { 'transfer-encoding': 'chunked' })).status).toBe(413)
  expect(existsSync(file())).toBe(false)
})

it('refuses any method but POST, a Host header that is not loopback and a browser request with an Origin', async () => {
  await serve()
  const get = await call('GET')
  expect([get.status, get.headers.allow]).toEqual([405, 'POST'])
  expect((await call('PUT', sample())).status).toBe(405)
  expect((await call('POST', sample(), { host: `example.com:${port}` })).status).toBe(403)
  expect((await call('POST', sample(), { host: '127.0.0.1:1' })).status).toBe(403)
  expect((await call('POST', sample(), { origin: 'https://example.com' })).status).toBe(403)
  expect(existsSync(file())).toBe(false)
})

it('is a plugin that needs the web server and DSH\'s Session services, and mounts the route for the configured projects', () => {
  expect([plugin.name, plugin.inject]).toEqual(['dsh-superagent-factory', ['webServer', 'agents', 'sessionController', 'workspaceRegistry', 'permissionPresets']])
  expect(plugin.Config({ guardModule: '/factory/lib/dist/judgeGuard.js' })).toEqual({ projects: [], tokenFile: SharedTokenFile.DEFAULT_PATH, guardModule: '/factory/lib/dist/judgeGuard.js', approvalSeconds: 120 })
  expect(() => plugin.Config({ guardModule: 'relative/judgeGuard.js' })).toThrow()
  expect(plugin.Config({ projects: [project], tokenFile: tokenPath() })).toEqual({ projects: [project], tokenFile: tokenPath(), approvalSeconds: 120 })
  expect(plugin.Config({ maskModule: maskPath() })).toEqual({ projects: [], tokenFile: SharedTokenFile.DEFAULT_PATH, maskModule: maskPath(), approvalSeconds: 120 })
  expect(() => plugin.Config({ maskModule: 'relative/decisionMask.js' })).toThrow()
  expect(plugin.Config({})).toEqual({ projects: [], tokenFile: SharedTokenFile.DEFAULT_PATH, approvalSeconds: 120 })
  expect(plugin.Config({ approvalSeconds: 600 }).approvalSeconds).toBe(600)
  for (const seconds of [0, 601, 1.5]) expect(() => plugin.Config({ approvalSeconds: seconds }), String(seconds)).toThrow()
  expect(SharedTokenFile.DEFAULT_PATH).toBe(join(homedir(), '.config', 'zees-factory', 'superagent-token'))
  expect(() => plugin.Config({ projects: ['relative'] })).toThrow()
  expect(() => plugin.Config({ tokenFile: 'relative/token' })).toThrow()
  const registered: Route[] = []
  const dispose = vi.fn()
  const ctx = { webServer: { host: '127.0.0.1', port: 3083, register: (route: Route) => { registered.push(route); return dispose } },
    effect: (effect: () => () => void) => effect(), logger: { info: vi.fn() }, tools: { guard: vi.fn(() => () => {}) } }
  plugin.apply(ctx as never, plugin.Config({ projects: [project] }))
  expect(registered.map(route => route.path)).toEqual(['/assess', '/ask', '/claim'])
  // Story 2.25: the judge's helpers are processes its own tool starts, not DSH agents, so the plugin puts no global guard on DSH's tools.
  expect(ctx.tools.guard).not.toHaveBeenCalled()
})

it('is a plugin that reads the shared token from the configured token file, masks with the configured mask module, guards its judges with the configured guard module and answers with the judge\'s decision', async () => {
  // Not the file the other tests use, so only `tokenFile` can have led the route to it.
  const configured = join(root, 'configured-token')
  writeFileSync(configured, `${OTHER_TOKEN}\n`)
  chmodSync(configured, 0o600)
  const registered: Route[] = []
  const dsh = fakeDsh(judgeReply)
  const ctx = { ...dsh.ctx, webServer: { host: '127.0.0.1', port: 3083, register: (route: Route) => { registered.push(route); return () => {} } },
    effect: (effect: () => () => void) => effect(), logger: { info: vi.fn() }, tools: { guard: vi.fn(() => () => {}) } }
  // Without a guard module the plugin's route opens no judge Session and writes nothing.
  plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: configured, maskModule: maskPath() }))
  const unguarded = direct('127.0.0.1', { [SharedTokenFile.HEADER]: OTHER_TOKEN })
  await registered[0]!.handler(unguarded.req, unguarded.res)
  expect([unguarded.answer.status, JSON.parse(unguarded.answer.text)]).toEqual([503, { error: 'No guardModule is configured, so no judge session is opened and no decision is written' }])
  expect([existsSync(file()), dsh.agents.size]).toEqual([false, 0])
  registered.length = 0
  const guardPath = join(root, 'fake-guard.mjs')
  writeFileSync(guardPath, 'export const JudgeToolGuard = { forHome: () => ({ check: call => call.name === "write" ? "Refused: write" : undefined }) }\n')
  plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: configured, maskModule: maskPath(), guardModule: guardPath }))
  const accepted = direct('127.0.0.1', { [SharedTokenFile.HEADER]: OTHER_TOKEN })
  await registered[0]!.handler(accepted.req, accepted.res)
  expect([accepted.answer.status, accepted.answer.headers[SharedTokenFile.HEADER]]).toEqual([200, OTHER_TOKEN])
  // The request opened the judge Session of its worker session, guarded by the configured module.
  const judgeId = JudgeSessions.idOf(project, 's1')
  expect([...dsh.agents.keys()]).toEqual([judgeId])
  expect(dsh.run(judgeId, { name: 'write', arguments: {} })).toBe('Refused: write')
  // The decision is the judge's own, not the stub's: the plugin asked the judge one question.
  expect(JSON.parse(accepted.answer.text) as { decision: string; reason: string }).toMatchObject({ decision: 'approve', reason: `${JUDGED}${MASKED}` })
  expect(dsh.agents.get(judgeId)!.asked).toHaveLength(1)
  // The token of the default test file is not the configured one.
  const refused = direct('127.0.0.1')
  await registered[0]!.handler(refused.req, refused.res)
  expect(refused.answer.status).toBe(401)
  expect(lines()).toHaveLength(1)
})

it('matches a listed project written with a trailing slash', async () => {
  await serve([`${project}/`])
  expect((await call('POST', sample())).status).toBe(200)
})

it('refuses a caller that sends no token or another token, before reading the body, and writes nothing', async () => {
  await serve()
  const refused = { error: 'The shared token is missing or wrong' }
  for (const sent of [undefined, '', OTHER_TOKEN, LONGER_TOKEN, TOKEN.slice(0, -1), `${TOKEN}, ${TOKEN}`]) {
    const answer = await call('POST', sample(), { [SharedTokenFile.HEADER]: sent })
    expect([sent, answer.status, answer.body]).toEqual([sent, 401, refused])
    // A refusal never carries the token, in its header or in its text.
    expect(answer.headers[SharedTokenFile.HEADER]).toBeUndefined()
    expect(answer.text).not.toContain(TOKEN)
  }
  // The body is not read: one that is not JSON, or over the limit, gets the same answer.
  expect((await call('POST', '{not json', { [SharedTokenFile.HEADER]: OTHER_TOKEN })).status).toBe(401)
  expect((await call('POST', sample({ reason: 'x'.repeat(AssessRoute.MAX_BODY_BYTES) }), { [SharedTokenFile.HEADER]: undefined })).status).toBe(401)
  expect(existsSync(file())).toBe(false)
})

it('answers nobody while its own token file is missing, a symlink, open to others or malformed', async () => {
  await serve()
  const refused = { error: 'The route has no usable token file, so it answers nobody' }
  const states: (() => void)[] = [
    () => { rmSync(tokenPath()) },
    () => { writeToken(TOKEN, 0o644) },
    () => { writeToken(TOKEN, 0o640) },
    () => { writeToken('too-short') },
    () => { writeToken('') },
    () => {
      const real = join(root, 'real-token')
      writeFileSync(real, TOKEN, { mode: 0o600 })
      rmSync(tokenPath(), { force: true })
      symlinkSync(real, tokenPath())
    },
  ]
  for (const [index, change] of states.entries()) {
    change()
    const answer = await call('POST', sample())
    expect([index, answer.status, answer.body]).toEqual([index, 503, refused])
    expect(answer.text).not.toContain(tokenPath())
    // Even a caller without the token learns only that the route is not set up.
    expect((await call('POST', sample(), { [SharedTokenFile.HEADER]: undefined })).status).toBe(503)
  }
  expect(existsSync(file())).toBe(false)
})

it('reads its token file on every request, so a replaced token works without a restart', async () => {
  await serve()
  expect((await call('POST', sample())).status).toBe(200)
  writeToken(`${OTHER_TOKEN}\n`)
  expect((await call('POST', sample())).status).toBe(401)
  const answer = await call('POST', sample(), { [SharedTokenFile.HEADER]: OTHER_TOKEN })
  expect([answer.status, answer.headers[SharedTokenFile.HEADER]]).toEqual([200, OTHER_TOKEN])
  expect(lines()).toHaveLength(2)
})

it('checks in a fixed order: host and origin, the caller\'s address, the method, its own token file, then the caller\'s token', async () => {
  await serve()
  const none = { [SharedTokenFile.HEADER]: undefined }
  expect((await call('POST', sample(), { ...none, host: `example.com:${port}` })).status).toBe(403)
  expect((await call('GET', undefined, { ...none, origin: 'https://example.com' })).status).toBe(403)
  expect((await call('GET', undefined, none)).status).toBe(405)
  rmSync(tokenPath())
  expect((await call('GET', undefined, none)).status).toBe(405)
  expect((await call('POST', sample(), none)).status).toBe(503)
  expect(existsSync(file())).toBe(false)
})

/** A request that never touched the network, as a caller at `remoteAddress` would have sent it, and the reply the route gives it. */
function direct(remoteAddress: string | undefined, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(sample()))]), { method: 'POST', socket: { remoteAddress },
    headers: { host: '127.0.0.1:3083', [SharedTokenFile.HEADER]: TOKEN, ...headers } })
  const resume = vi.spyOn(req, 'resume')
  const answer = { status: 0, headers: {} as Record<string, string>, text: '' }
  const res = { writeHead: (status: number, sent: Record<string, string>) => { answer.status = status; answer.headers = sent }, end: (text: string) => { answer.text = text } }
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, answer, resume }
}

it('refuses a caller whose address is not loopback, whatever its Host header and token say', async () => {
  const route = new AssessRoute([project], new SharedTokenFile(tokenPath()), new StubJudge(), () => new Date(NOW), writer())
  for (const address of ['192.168.1.9', '10.0.0.1', '::ffff:192.168.1.9', 'fe80::1', '127.0.0.2', '', undefined]) {
    const { req, res, answer, resume } = direct(address)
    await route.handle(req, res, 3083)
    expect([address, answer.status, JSON.parse(answer.text)]).toEqual([address, 403, { error: 'Loopback request required' }])
    // The upload it did not read is thrown away.
    expect(resume).toHaveBeenCalled()
  }
  expect(existsSync(file())).toBe(false)
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const { req, res, answer } = direct(address)
    await route.handle(req, res, 3083)
    expect([address, answer.status, answer.headers[SharedTokenFile.HEADER]]).toEqual([address, 200, TOKEN])
  }
  expect(lines()).toHaveLength(3)
})

it('throws away the upload of a caller it refuses before the body, so the caller receives the answer', async () => {
  const route = new AssessRoute([project], new SharedTokenFile(tokenPath()))
  const refusals: [Record<string, string>, string | undefined, number][] = [
    [{ host: 'example.com:3083' }, '127.0.0.1', 403], [{ origin: 'https://example.com' }, '127.0.0.1', 403], [{}, '192.168.1.9', 403],
    [{ [SharedTokenFile.HEADER]: OTHER_TOKEN }, '127.0.0.1', 401],
  ]
  for (const [headers, address, status] of refusals) {
    const { req, res, answer, resume } = direct(address, headers)
    await route.handle(req, res, 3083)
    expect([answer.status, resume.mock.calls.length]).toEqual([status, 1])
  }
  // Over real HTTP: 8 MiB sent in pieces by a caller without the token is answered, not cut off.
  await serve()
  const upload = 'x'.repeat(8 * 1024 * 1024)
  expect((await call('POST', upload, { [SharedTokenFile.HEADER]: undefined, 'transfer-encoding': 'chunked' })).status).toBe(401)
  expect((await call('PUT', upload, { 'transfer-encoding': 'chunked' })).status).toBe(405)
  expect(existsSync(file())).toBe(false)
})

it('sends two requests of one session_id to one judge Session and gives another session_id its own, and asks the judge one question for each request', async () => {
  const dsh = fakeDsh(judgeReply), judges = new JudgeSessions(dsh.ctx, fakeGuard().source)
  await serve([project], writer(), new ModelJudge(judges))
  const [first, together] = await Promise.all([call('POST', sample()), call('POST', sample({ request_id: 'req-2' }))])
  expect([first.status, together.status]).toEqual([200, 200])
  expect((await call('POST', sample({ request_id: 'req-3' }))).status).toBe(200)
  const own = JudgeSessions.idOf(project, 's1')
  expect([...dsh.agents.keys()]).toEqual([own])
  expect(dsh.controller.create).toHaveBeenCalledTimes(1)
  expect((await call('POST', sample({ request_id: 'req-4', session_id: 's2' }))).status).toBe(200)
  expect([...dsh.agents.keys()]).toEqual([own, JudgeSessions.idOf(project, 's2')])
  expect(judges.count).toBe(2)
  // The judge decides, not the stub: every line is its answer, and each request was one question to the judge of its session.
  expect(lines().map(line => (JSON.parse(line) as { decision: string }).decision)).toEqual(['approve', 'approve', 'approve', 'approve'])
  expect([...dsh.agents.values()].map(agent => agent.asked.length)).toEqual([3, 1])
})

it('opens no judge Session for a project that is not listed, and answers 503 and writes nothing when the Session cannot be opened', async () => {
  const dsh = fakeDsh(judgeReply), judges = new JudgeSessions(dsh.ctx, fakeGuard().source)
  await serve([project], writer(), new ModelJudge(judges))
  expect((await call('POST', sample({ project: join(root, 'unlisted') }))).status).toBe(403)
  expect(dsh.controller.resolveAgent).not.toHaveBeenCalled()
  dsh.controller.create.mockRejectedValueOnce(new Error('planted-detail'))
  const failed = await call('POST', sample())
  expect([failed.status, failed.body]).toEqual([503, { error: 'The judge session could not be opened, so no decision is written' }])
  expect(existsSync(file())).toBe(false)
  // The next request tries again.
  expect((await call('POST', sample())).status).toBe(200)
  expect(lines()).toHaveLength(1)
})

it('answers 503 and writes nothing when no guard module is configured', async () => {
  const dsh = fakeDsh()
  await serve([project], writer(), new ModelJudge(new JudgeSessions(dsh.ctx, new FactoryGuardModule())))
  const answer = await call('POST', sample())
  expect([answer.status, answer.body]).toEqual([503, { error: 'No guardModule is configured, so no judge session is opened and no decision is written' }])
  expect([existsSync(file()), dsh.agents.size]).toEqual([false, 0])
})

/** A judge that gives every request the same answer and keeps what it was asked. */
function fixedJudge(decision: Verdict['decision'] = 'approve'): Judge & { seen: AssessRequest[] } {
  const seen: AssessRequest[] = []
  return { seen, decide: (asked: AssessRequest): Verdict => {
    seen.push(asked)
    return { decision_id: `d-${seen.length}`, request_id: asked.request_id, kind: 'permission', decision, choice: null, risk: 'low', tier: 3, tier_set_by: 'judge', reason: JUDGED,
      alternative: decision === 'deny' ? 'Do it another way.' : '', cites: 'Ticket 19', reads: [], tokens: 7 }
  } }
}
/** What a worker posts to `/ask`: the call it is about to make, and why. */
const asking = (fields: Record<string, unknown> = {}) => ({ project, session_id: 's1', tool_name: 'Bash', tool_input: { command: 'pnpm test', description: 'Run the tests' },
  description: 'Run the tests of ticket 19', ...fields })
/** What the hook posts to `/claim` for the call `asking()` describes. */
const claiming = (fields: Record<string, unknown> = {}) => ({ request_id: 'hook-req-1', request_key: keyOf('s1', 'Bash', asking().tool_input), session_id: 's1', project, ...fields })
/** The ask key a worker session holds: the key of `session` under the test token. */
const keyFor = (session: unknown, token: string = TOKEN) => AskKey.compute(token, String(session))
/**
 * Sends a worker's ask: no shared token, and by default the right ask key for the body's `session_id`. `headers` adds to these or replaces them;
 * `undefined` leaves a header out.
 */
const ask = (fields: Record<string, unknown> = {}, headers: Record<string, string | undefined> = {}) => {
  const body = asking(fields)
  return call('POST', body, { [SharedTokenFile.HEADER]: undefined, [AskKey.HEADER]: keyFor(body.session_id), ...headers }, '/ask')
}
const claim = (fields: Record<string, unknown> = {}, headers: Record<string, string | undefined> = {}) => call('POST', claiming(fields), headers, '/claim')

it('judges an ask without a token, masked and keyed with the factory\'s functions, and holds the approve for one claim', async () => {
  const judge = fixedJudge()
  await serve([project], writer(), judge)
  const asked = await ask({ context: 'The plan lists this test run.' })
  expect(asked.status).toBe(200)
  // A worker holds no token: none was sent, and none comes back.
  expect(asked.headers[SharedTokenFile.HEADER]).toBeUndefined()
  expect(asked.text).not.toContain(TOKEN)
  expect(Object.keys(asked.body)).toEqual(['decision', 'pending_until'])
  expect(asked.body.pending_until).toBe(new Date(Date.parse(NOW) + 120_000).toISOString())
  // The decision is the line as written, and it is the only line.
  expect(lines()).toEqual([JSON.stringify(asked.body.decision)])
  const decision = asked.body.decision as Record<string, unknown>
  expect([decision.decision, decision.decision_id, decision.reason, decision.project]).toEqual(['approve', 'd-1', JUDGED + MASKED, project])

  // What the judge saw: an /assess-shaped request with a new id, the key of the raw call, and the masked description and context.
  expect(judge.seen).toHaveLength(1)
  const seen = judge.seen[0]!
  expect(Object.keys(seen)).toEqual(['request_id', 'request_key', 'project', 'session_id', 'tool_name', 'tool_input', 'reason', 'context'])
  expect(seen.request_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(decision.request_id).toBe(seen.request_id)
  expect(seen).toMatchObject({ request_key: keyOf('s1', 'Bash', asking().tool_input), project, session_id: 's1', tool_name: 'Bash',
    // The judge sees the masked input; the key is made of the raw one.
    tool_input: { masked: asking().tool_input },
    reason: `Run the tests of ticket 19${MASKED_REQUEST}`, context: `The plan lists this test run.${MASKED_REQUEST}` })

  // The hook claims it: the ask's decision id, the token back, no judge asked, nothing written.
  const first = await claim()
  expect([first.status, first.body]).toEqual([200, { claimed: true, request_id: 'hook-req-1', decision_id: 'd-1', project }])
  expect(first.headers[SharedTokenFile.HEADER]).toBe(TOKEN)
  expect(first.text).not.toContain(TOKEN)
  // One use: the same claim again finds nothing.
  const second = await claim({ request_id: 'hook-req-2' })
  expect([second.status, second.body]).toEqual([200, { claimed: false, request_id: 'hook-req-2', decision_id: null, project }])
  expect(second.headers[SharedTokenFile.HEADER]).toBe(TOKEN)
  expect(judge.seen).toHaveLength(1)
  expect(lines()).toHaveLength(1)
})

it('holds nothing for an ask the judge denies or hands to the owner, and an ask without context has none', async () => {
  for (const decision of ['deny', 'ask_owner'] as const) {
    const judge = fixedJudge(decision)
    await serve([project], writer(), judge)
    const asked = await ask()
    expect([asked.status, asked.body.pending_until, (asked.body.decision as Record<string, unknown>).decision], decision).toEqual([200, null, decision])
    expect('context' in judge.seen[0]!, decision).toBe(false)
    expect((await claim()).body, decision).toMatchObject({ claimed: false, decision_id: null })
    await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
  }
  expect(lines()).toHaveLength(2)
})

it('keeps a held approve claimable when a newer ask of the same call is denied or handed to the owner', async () => {
  for (const later of ['deny', 'ask_owner'] as const) {
    const answers: string[] = ['approve', later]
    const seen: Record<string, unknown>[] = []
    const judge = { decide: (asked: AssessRequest) => {
      seen.push(asked)
      const decision = answers[seen.length - 1] as 'approve' | 'deny' | 'ask_owner'
      return { decision_id: `d-${seen.length}`, request_id: asked.request_id, kind: 'permission' as const, decision, choice: null, risk: 'low' as const, tier: 3 as const, tier_set_by: 'judge' as const,
        reason: JUDGED, alternative: decision === 'deny' ? 'Do it another way.' : '', cites: 'Ticket 19', reads: [], tokens: 7 }
    } }
    await serve([project], writer(), judge)
    expect((await ask()).body.pending_until, later).not.toBeNull()
    expect((await ask({ context: 'The plan changed.' })).body.pending_until, later).toBeNull()
    // A weak ask cannot cancel the approval: the call that was approved can still run on it.
    expect((await claim()).body, later).toEqual({ claimed: true, request_id: 'hook-req-1', decision_id: 'd-1', project })
    await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
  }
})

it('holds an approve for the configured approvalSeconds when it runs as the plugin', async () => {
  const registered: Route[] = []
  const dsh = fakeDsh(judgeReply)
  const ctx = { ...dsh.ctx, webServer: { host: '127.0.0.1', port: 3083, register: (route: Route) => { registered.push(route); return () => {} } },
    effect: (effect: () => () => void) => effect(), logger: { info: vi.fn() }, tools: { guard: vi.fn(() => () => {}) } }
  const guardPath = join(root, 'fake-guard.mjs')
  writeFileSync(guardPath, 'export const JudgeToolGuard = { forHome: () => ({ check: () => undefined }) }\n')
  plugin.apply(ctx as never, plugin.Config({ projects: [project], tokenFile: tokenPath(), maskModule: maskPath(), guardModule: guardPath, approvalSeconds: 30 }))
  const askRoute = registered.find(route => route.path === '/ask')!
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(asking()))]), { method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3083', [AskKey.HEADER]: keyFor('s1') } })
  const answer = { status: 0, text: '' }
  const res = { writeHead: (status: number) => { answer.status = status }, end: (text: string) => { answer.text = text } }
  const before = Date.now()
  await askRoute.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  const after = Date.now()
  expect(answer.status).toBe(200)
  const until = Date.parse((JSON.parse(answer.text) as { pending_until: string }).pending_until)
  expect(until).toBeGreaterThanOrEqual(before + 30_000)
  expect(until).toBeLessThanOrEqual(after + 30_000)
})

it('gives a held approval only to the same key, session and project, and only until it expires', async () => {
  const other = join(root, 'other-project')
  mkdirSync(join(other, DecisionsFile.FOLDER), { recursive: true })
  let now = 1_000_000
  await serve([project, other], writer(), fixedJudge(), new PendingApprovals(30, () => now))
  expect((await ask()).body.pending_until).toBe(new Date(now + 30_000).toISOString())
  // Another command has another key; another session or project does not match the one that asked.
  for (const fields of [{ request_key: keyOf('s1', 'Bash', { command: 'pnpm build' }) }, { session_id: 's2' }, { project: other }]) {
    expect((await claim(fields)).body, JSON.stringify(fields)).toEqual({ claimed: false, request_id: 'hook-req-1', decision_id: null, project: fields.project ?? project })
  }
  // None of those used it up.
  now += 29_999
  expect((await claim()).body).toMatchObject({ claimed: true, decision_id: 'd-1' })
  // A new ask of the same call is held again, and is gone once its time is over.
  expect((await ask()).status).toBe(200)
  now += 30_000
  expect((await claim()).body).toMatchObject({ claimed: false, decision_id: null })
  now -= 1
  expect((await claim()).body).toMatchObject({ claimed: false, decision_id: null })
})

it('refuses a claim without the shared token, with a wrong one, or while the route has no token file, and a claim that is malformed or for an unlisted project', async () => {
  await serve([project], writer(), fixedJudge())
  await ask()
  expect([(await claim({}, { [SharedTokenFile.HEADER]: undefined })).status, (await claim({}, { [SharedTokenFile.HEADER]: OTHER_TOKEN })).status]).toEqual([401, 401])
  rmSync(tokenPath())
  expect((await claim()).status).toBe(503)
  writeToken()
  for (const field of ['request_id', 'request_key', 'session_id', 'project']) {
    expect([(await claim({ [field]: 7 })).status, (await claim({ [field]: '' })).status], field).toEqual([400, 400])
  }
  expect((await call('POST', ['not an object'], {}, '/claim')).status).toBe(400)
  expect((await claim({ project: join(root, 'unlisted') })).status).toBe(403)
  expect((await call('GET', undefined, {}, '/claim')).status).toBe(405)
  // None of the refused claims used the approval up.
  expect((await claim()).body).toMatchObject({ claimed: true })
})

it('admits an ask like an assess request but for the token, and refuses a malformed one with 400 before any judge is asked', async () => {
  const judge = fixedJudge()
  await serve([project], writer(), judge)
  expect((await ask({}, { [SharedTokenFile.HEADER]: undefined, origin: 'http://evil.example' })).status).toBe(403)
  expect((await ask({}, { [SharedTokenFile.HEADER]: undefined, host: 'evil.example' })).status).toBe(403)
  expect((await call('GET', undefined, {}, '/ask')).status).toBe(405)
  expect((await ask({ project: join(root, 'unlisted') })).status).toBe(403)
  for (const fields of [{ project: 7 }, { session_id: '' }, { tool_name: 7 }, { tool_input: undefined }, { description: '  ' }, { description: 7 }, { context: 7 }, { context: null }]) {
    expect((await ask(fields)).status, JSON.stringify(fields)).toBe(400)
  }
  expect((await call('POST', '{not json', { [SharedTokenFile.HEADER]: undefined }, '/ask')).status).toBe(400)
  expect(judge.seen).toEqual([])
  expect(existsSync(file())).toBe(false)
  // Without its token file the route cannot check any ask key, so it answers no ask, and asks no judge.
  rmSync(tokenPath())
  expect((await ask()).status).toBe(503)
  expect(judge.seen).toEqual([])
  writeToken()
  // Fields the route does not know never reach the judge: a worker cannot state its own temp facts.
  expect((await ask({ temp: null, extra: 'x' })).status).toBe(200)
  expect(Object.keys(judge.seen[0]!)).toEqual(['request_id', 'request_key', 'project', 'session_id', 'tool_name', 'tool_input', 'reason'])
})

it('answers an ask with 503 and asks no judge when the mask module is missing or is from a factory that cannot key or mask a request', async () => {
  const old = join(root, 'old-mask.mjs'), noKey = join(root, 'no-key.mjs'), broken = join(root, 'broken.mjs')
  writeFileSync(old, OLD_MASK)
  writeFileSync(noKey, 'export const DecisionMask = { forProject: () => ({ mask: line => line, maskRequest: fields => fields }) }\n')
  writeFileSync(broken, 'export const DecisionMask = { requestKey: () => \'k\', forProject: () => ({ mask: line => line, maskRequest: () => { throw new Error(\'secret text\') } }) }\n')
  for (const path of [undefined, join(root, 'missing.mjs'), old, noKey, broken]) {
    const judge = fixedJudge()
    await serve([project], new DecisionWriter(new FactoryMaskModule(path)), judge)
    const asked = await ask()
    expect([asked.status, judge.seen.length], String(path)).toEqual([503, 0])
    expect(asked.text, String(path)).not.toContain('secret text')
    await new Promise<void>(resolve => { server!.close(() => { resolve() }) })
  }
  expect(existsSync(file())).toBe(false)
})

it('refuses a tier that is not null or a whole 1, 2 or 3, or a tier rule that is not text, with 400, and writes nothing', async () => {
  const judge = fixedJudge()
  await serve([project], writer(), judge)
  for (const fields of [{ tier: 7 }, { tier: '1' }, { tier: 0 }, { tier: 1.5 }, { tier: true }, { tier: [1] }, { tier: 2, tier_rule: 3 }, { tier_rule: ['x'] }]) {
    const answer = await call('POST', sample(fields))
    expect([answer.status, answer.body], JSON.stringify(fields)).toEqual([400, { error: 'The request has a malformed tier' }])
  }
  expect(judge.seen).toEqual([])
  expect(existsSync(file())).toBe(false)
  for (const fields of [{ tier: 1, tier_rule: 'project-direction-file' }, { tier: null, tier_rule: null }, {}]) expect((await call('POST', sample(fields))).status).toBe(200)
  expect(judge.seen.map(request => [request.tier, request.tier_rule])).toEqual([[1, 'project-direction-file'], [null, null], [undefined, undefined]])
})

it('records the gate\'s tier on the stub\'s decision: its high grade keeps a gate tier 1 and raises any other', async () => {
  await serve([project], writer())
  const recorded = async (fields: Record<string, unknown>) => (await call('POST', sample(fields))).body as Record<string, unknown>
  expect(await recorded({ request_id: 'r1', tier: 1, tier_rule: 'project-direction-file' })).toMatchObject({ tier: 1, tier_set_by: 'gate' })
  expect(await recorded({ request_id: 'r2', tier: 3, tier_rule: 'read-only' })).toMatchObject({ tier: 1, tier_set_by: 'judge' })
  expect(await recorded({ request_id: 'r3' })).toMatchObject({ tier: 1, tier_set_by: 'judge' })
})

it('takes no tier from a worker\'s ask: the judged request carries none', async () => {
  const judge = fixedJudge()
  await serve([project], writer(), judge)
  expect((await ask({ tier: 3, tier_rule: 'read-only' })).status).toBe(200)
  expect('tier' in judge.seen[0]!).toBe(false)
  expect('tier_rule' in judge.seen[0]!).toBe(false)
})

it('refuses an assess request whose context is not text, and hands a text context to the judge', async () => {
  const judge = fixedJudge()
  await serve([project], writer(), judge)
  for (const context of [7, null, ['x']]) expect((await call('POST', sample({ context }))).status, JSON.stringify(context)).toBe(400)
  expect(judge.seen).toEqual([])
  expect((await call('POST', sample({ context: 'Background.' }))).status).toBe(200)
  expect(judge.seen[0]!.context).toBe('Background.')
})

it('refuses an ask with no ask key, a wrong one or another session\'s with 401, before any judge, and leaves held approvals as they are', async () => {
  const judge = fixedJudge()
  await serve([project], writer(), judge)
  // Session s2 asks with its own key and holds an approval.
  expect((await ask({ session_id: 's2' })).body.pending_until).not.toBeNull()
  expect(judge.seen).toHaveLength(1)
  const refused = [
    await ask({}, { [AskKey.HEADER]: undefined }),
    await ask({}, { [AskKey.HEADER]: '' }),
    await ask({}, { [AskKey.HEADER]: '0'.repeat(64) }),
    await ask({}, { [AskKey.HEADER]: keyFor('s1', OTHER_TOKEN) }),
    // Another session's key (s2's) does not let a caller ask in s1's name.
    await ask({}, { [AskKey.HEADER]: keyFor('s2') }),
    // The shared token itself is not an ask key.
    await ask({}, { [AskKey.HEADER]: TOKEN }),
  ]
  for (const [index, answer] of refused.entries()) {
    expect(answer.status, String(index)).toBe(401)
    expect(Object.keys(answer.body), String(index)).toEqual(['error'])
    expect(answer.text, String(index)).not.toContain(keyFor('s1'))
    expect(answer.headers[SharedTokenFile.HEADER], String(index)).toBeUndefined()
  }
  // No refused ask reached the judge or the decisions file, and s2's approval is still there for its own claim.
  expect(judge.seen).toHaveLength(1)
  expect(lines()).toHaveLength(1)
  const s2Key = keyOf('s2', 'Bash', asking().tool_input)
  expect((await claim({ session_id: 's2', request_key: s2Key })).body).toMatchObject({ claimed: true, decision_id: 'd-1' })
  // With the right key the ask is judged.
  expect((await ask()).status).toBe(200)
  expect(judge.seen).toHaveLength(2)
})

it('computes the ask key as the factory does: the pinned test vector', () => {
  // The same vector is pinned in the factory's lib/askKey test; both sides must agree on it.
  expect(AskKey.PREFIX).toBe('zees-ask-v1:')
  expect(AskKey.HEADER).toBe('x-zees-ask-key')
  expect(AskKey.compute(TOKEN, 'session-0001')).toBe('1db6e63a803f7acf619ed4b46312c11fe1a1fab443b3b52720411b6c422393f6')
  // The token is trimmed first, so a line break after it changes nothing.
  expect(AskKey.compute(`${TOKEN}\n`, 'session-0001')).toBe(AskKey.compute(TOKEN, 'session-0001'))
  expect(AskKey.compute(TOKEN, 'session-0002')).not.toBe(AskKey.compute(TOKEN, 'session-0001'))
})
