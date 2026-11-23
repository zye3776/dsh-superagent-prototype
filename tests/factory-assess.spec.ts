/** The factory's `/assess` route, served by a real HTTP server on loopback, writing into a temporary project. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssessRoute, DecisionsFile, StubJudge } from '../src/factory/assess.ts'
import * as plugin from '../src/factory/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
interface Route { kind: string; path: string; auth?: string; handler: Handler }
interface Answer { status: number; text: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }

const NOW = '2026-11-23T08:09:10.123Z'
let root = '', project = '', server: Server | undefined, port = 0
const file = () => join(project, DecisionsFile.FOLDER, DecisionsFile.FILE)
const lines = () => readFileSync(file(), 'utf8').split('\n').filter(line => line !== '')
/** A masked request as the factory posts it; `project` is the raw path. */
const sample = (fields: Record<string, unknown> = {}) => ({ request_id: 'req-1', request_key: 'k1', session_id: 's1', tool_name: 'Bash',
  tool_input: { command: 'ls' }, reason: 'List files', project, ...fields })

/** Serves the route of a fake DSH web server over real HTTP, and returns the route as it was registered. */
async function serve(projects: string[] = [project]): Promise<Route> {
  let route: Route | undefined
  server = createServer((req, res) => { void route!.handler(req, res) })
  await new Promise<void>(resolve => { server!.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
  const ctx = { webServer: { host: '127.0.0.1', port, register: (registered: Route) => { route = registered; return () => {} } } }
  new AssessRoute(projects, new StubJudge(), () => new Date(NOW)).register(ctx as never)
  return route!
}
function call(method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const sent = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return new Promise((resolve, reject) => {
    // Without a length, Node sends the body in chunks, so the route cannot refuse it by its length up front.
    const length = sent && !('transfer-encoding' in headers) ? { 'content-length': String(sent.length) } : {}
    const req = request({ host: '127.0.0.1', port, path: '/assess', method, headers: { ...length, ...headers } }, res => {
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
})
afterEach(async () => {
  await new Promise<void>(resolve => { server ? server.close(() => { resolve() }) : resolve() })
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

it('registers one exact, anonymous route and refuses a web server that is not on loopback', async () => {
  const route = await serve()
  expect({ kind: route.kind, path: route.path, auth: route.auth }).toEqual({ kind: 'exact', path: '/assess', auth: 'anonymous' })
  const ctx = { webServer: { host: '192.168.1.5', port: 3083, register: () => () => {} } }
  expect(() => new AssessRoute([project]).register(ctx as never)).toThrow('loopback')
  expect(() => new AssessRoute(['relative/project'])).toThrow('absolute')
})

it('answers a valid request with the stub decision and appends the same line last', async () => {
  await serve()
  writeFileSync(file(), '{"earlier":true}\n')
  const answer = await call('POST', sample())
  expect(answer.status).toBe(200)
  expect(answer.body).toEqual({ decision_id: expect.stringMatching(/^[0-9a-f-]{36}$/), request_id: 'req-1', kind: 'permission', decision: 'ask_owner',
    choice: null, risk: 'high', reason: StubJudge.REASON, alternative: '', cites: '', reads: [], tokens: 0, seconds: expect.any(Number), ts: NOW, project })
  expect(answer.body.seconds).toBeGreaterThanOrEqual(0)
  expect(lines()).toEqual(['{"earlier":true}', answer.text])
  // A second request gets a decision of its own, after the first.
  const second = await call('POST', sample({ request_id: 'req-2' }), { host: `localhost:${port}` })
  expect(second.body.request_id).toBe('req-2')
  expect(second.body.decision_id).not.toBe(answer.body.decision_id)
  expect(lines()).toEqual(['{"earlier":true}', answer.text, second.text])
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

it('is a plugin that needs only the web server and mounts the route for the configured projects', () => {
  expect([plugin.name, plugin.inject]).toEqual(['dsh-superagent-factory', ['webServer']])
  expect(plugin.Config({ projects: [project] })).toEqual({ projects: [project] })
  expect(plugin.Config({})).toEqual({ projects: [] })
  expect(() => plugin.Config({ projects: ['relative'] })).toThrow()
  const registered: Route[] = []
  const dispose = vi.fn()
  const ctx = { webServer: { host: '127.0.0.1', port: 3083, register: (route: Route) => { registered.push(route); return dispose } },
    effect: (effect: () => () => void) => effect(), logger: { info: vi.fn() } }
  plugin.apply(ctx as never, plugin.Config({ projects: [project] }))
  expect(registered.map(route => route.path)).toEqual(['/assess'])
})

it('matches a listed project written with a trailing slash', async () => {
  await serve([`${project}/`])
  expect((await call('POST', sample())).status).toBe(200)
})
