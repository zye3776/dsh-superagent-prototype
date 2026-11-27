/** The judge's `docs_lookup` tool against a recording `fetch`: what it sends, how it reads answers, and how it fails. The real bodies come from the factory's built guard file. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocsLookup, type DocumentationBodies, type DocumentationCall, type Fetcher } from '../src/factory/docs.ts'
import { FactoryGuardModule, JudgeSessions } from '../src/factory/judge.ts'
import { fakeDsh, type FakeAgent } from './fixtures/judge.ts'

/** One request the recording fetch saw. */
interface Sent { url: string; headers: Record<string, string>; body: unknown }
/** A `fetch` that records each request and answers from `answer`, in order. */
function recorder(answer: (body: { id?: number; method?: string }, index: number) => Response | Promise<Response>) {
  const sent: Sent[] = []
  const fetcher: Fetcher = async (url, init) => {
    const body = JSON.parse(init.body) as { id?: number; method?: string }
    sent.push({ url, headers: init.headers, body })
    return answer(body, sent.length - 1)
  }
  return { sent, fetcher }
}
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const sse = (value: unknown) => new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
/** An MCP service that answers initialize, the notification and each tools/call with `texts`, in order. */
const service = (texts: string[], reply: (value: unknown) => Response = json) => recorder(body => {
  if (body.method === 'initialize') return reply({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
  return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: texts.shift() ?? '' }] } })
})

/** Bodies that say which call they are, for the tests that need no factory. */
const BODIES: DocumentationBodies = {
  SERVICES: { deepwiki: { label: 'DeepWiki', url: 'https://deepwiki.test/mcp' }, context7: { label: 'Context7', url: 'https://context7.test/mcp' } },
  initializeBody: (id = 0) => ({ jsonrpc: '2.0', id, method: 'initialize' }),
  initializedBody: () => ({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  callBody: (id, tool, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }),
  firstCall: (service, name, question): DocumentationCall => service === 'deepwiki'
    ? { tool: 'ask_wiki_question', arguments: { repoName: name, question }, resolvesLibrary: false }
    : { tool: 'resolve-library-id', arguments: { libraryName: name, query: question }, resolvesLibrary: true },
  secondCall: (libraryId, question) => ({ tool: 'query-docs', arguments: { libraryId, query: question }, resolvesLibrary: false }),
  libraryIdOf: text => /library ID: (\/\S+)/.exec(text)?.[1] ?? null,
}

describe('DocsLookup', () => {
  it('connects, keeps the session id and protocol version, and returns the answer text', async () => {
    const { sent, fetcher } = recorder(body => body.method === 'initialize'
      ? json({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'abc' })
      : body.method === 'notifications/initialized' ? new Response(null, { status: 202 })
        : sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Cleanup runs before the next effect.' }] } }))
    const text = await new DocsLookup(BODIES, fetcher).run({ service: 'deepwiki', name: 'facebook/react', question: 'How does useEffect cleanup work?' })
    expect(text).toBe('Cleanup runs before the next effect.')
    expect(sent.map(item => (item.body as { method: string }).method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(sent.every(item => item.url === 'https://deepwiki.test/mcp')).toBe(true)
    expect(sent[0]!.headers['mcp-session-id']).toBeUndefined()
    expect(sent[2]!.headers).toMatchObject({ 'mcp-session-id': 'abc', 'mcp-protocol-version': '2025-06-18', accept: 'application/json, text/event-stream' })
  })

  it('asks Context7 for the library id first, then for the docs; says so when no id is found', async () => {
    const found = service(['- Context7-compatible library ID: /vercel/next.js', 'Routing docs.'])
    expect(await new DocsLookup(BODIES, found.fetcher).run({ service: 'context7', name: 'Next.js', question: 'How does routing work?' })).toBe('Routing docs.')
    expect(found.sent.slice(2).map(item => item.body)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resolve-library-id', arguments: { libraryName: 'Next.js', query: 'How does routing work?' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query-docs', arguments: { libraryId: '/vercel/next.js', query: 'How does routing work?' } } },
    ])
    const none = service(['No libraries found.'])
    expect(await new DocsLookup(BODIES, none.fetcher).run({ service: 'context7', name: 'Nope', question: 'How?' })).toMatch(/found no library id for Nope/)
    expect(none.sent).toHaveLength(3)
  })

  it('caps a long answer at 6000 characters', async () => {
    const { fetcher } = service(['x'.repeat(7000)])
    const text = await new DocsLookup(BODIES, fetcher).run({ service: 'deepwiki', name: 'a/b', question: 'How?' })
    expect(text.startsWith('x'.repeat(6000))).toBe(true)
    expect(text).toMatch(/\[cut at 6000 characters\]$/)
  })

  it('turns every failure into a text that says the lookup failed, without the error\'s own text', async () => {
    const failing: [string, Fetcher][] = [
      ['could not be reached', async () => { throw new Error('planted-detail') }],
      ['status 500', async () => new Response('planted-detail', { status: 500 })],
      ['answered with an error', recorder(body => body.method === 'initialize' ? json({ jsonrpc: '2.0', id: 0, result: {} })
        : body.method === 'notifications/initialized' ? new Response(null, { status: 202 })
          : json({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'planted-detail' } })).fetcher],
      ['could not answer', recorder(body => body.method === 'initialize' ? json({ jsonrpc: '2.0', id: 0, result: {} })
        : body.method === 'notifications/initialized' ? new Response(null, { status: 202 })
          : json({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'planted-detail' }] } })).fetcher],
      ['did not accept the connection', async () => json({ not: 'json-rpc' })],
    ]
    for (const [why, fetcher] of failing) {
      const text = await new DocsLookup(BODIES, fetcher).run({ service: 'deepwiki', name: 'a/b', question: 'How?' })
      expect(text, why).toMatch(/^The DeepWiki documentation lookup failed \(/)
      expect(text, why).toContain(why)
      expect(text, why).not.toContain('planted-detail')
    }
    const slow: Fetcher = (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(new Error('planted-detail')) }) })
    expect(await new DocsLookup(BODIES, slow, 20).run({ service: 'deepwiki', name: 'a/b', question: 'How?' })).toMatch(/took too long/)
    expect(await new DocsLookup(BODIES, slow).run({ service: 'other', name: 'a/b', question: 'How?' })).toMatch(/was not sent/)
  })
})

/** The factory's folder, when the environment says where it is. */
const FACTORY = process.env.ZEES_FACTORY_DIR?.trim() ?? ''
const REAL_GUARD = FACTORY === '' ? '' : join(FACTORY, 'lib', 'dist', 'judgeGuard.js')
const realTitle = FACTORY === '' ? 'docs_lookup with the factory\'s real built guard (SKIPPED: set ZEES_FACTORY_DIR to the factory\'s folder to run it)' : 'docs_lookup with the factory\'s real built guard'

describe.skipIf(FACTORY === '')(realTitle, () => {
  let root = '', project = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-docs-'))
    project = join(root, 'shopfront')
    mkdirSync(join(project, 'src'), { recursive: true })
    writeFileSync(join(project, 'src', 'a.ts'), 'x\n')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('sends exactly the bodies DocumentationQuery built from the name and question, and nothing for a refused lookup', async () => {
    expect(existsSync(REAL_GUARD), `${REAL_GUARD} is missing: run the factory's build`).toBe(true)
    const real = (await import(pathToFileURL(REAL_GUARD).href) as { DocumentationQuery: DocumentationBodies }).DocumentationQuery
    const deepwiki = service(['DeepWiki answer.'], sse), context7 = service(['- Context7-compatible library ID: /vercel/next.js', 'Context7 answer.'], sse)
    const fetcher: Fetcher = (url, init) => (url.includes('deepwiki') ? deepwiki : context7).fetcher(url, init)
    const results: string[] = [], refusals: (string | undefined)[] = []
    const lookups = [
      { service: 'deepwiki', name: 'facebook/react', question: 'How does useEffect cleanup work?' },
      { service: 'context7', name: 'Next.js', question: 'How does routing work in Next.js?' },
      { service: 'deepwiki', name: 'facebook/react', question: 'What does src/a.ts export?' },
      { service: 'deepwiki', name: 'facebook/react', question: 'Does shopfront use it?' },
      { service: 'deepwiki', name: 'facebook/react', question: 'Is `rm -rf` safe?' },
      { service: 'deepwiki', name: 'facebook/react', question: 'How?', project },
    ]
    let tools!: FakeAgent
    const dsh = fakeDsh(async (_text, run) => {
      for (const args of lookups) {
        // As DSH does: the guards first, and the tool runs only when none refused.
        const refusal = run({ name: 'docs_lookup', arguments: args })
        refusals.push(refusal)
        if (refusal === undefined) results.push((await tools.registered[0]!.execute(args, {})).text)
      }
      return 'ok'
    })
    const judge = await new JudgeSessions(dsh.ctx, new FactoryGuardModule(REAL_GUARD), { fetcher }).open(project, 's1')
    tools = dsh.agents.get(judge.id)!
    await judge.ask('q', new AbortController().signal)
    expect(refusals.slice(0, 2)).toEqual([undefined, undefined])
    for (const refusal of refusals.slice(2)) expect(refusal).toMatch(/^Refused: this documentation lookup cannot be sent/)
    expect(results).toEqual(['DeepWiki answer.', 'Context7 answer.'])
    // Every body is one DocumentationQuery built; nothing else was sent, and the refused lookups sent nothing.
    const call = (service: 'deepwiki' | 'context7', name: string, question: string) => real.firstCall(service, name, question)
    const first = call('deepwiki', 'facebook/react', 'How does useEffect cleanup work?')
    expect(deepwiki.sent.map(item => item.body)).toEqual([real.initializeBody(0), real.initializedBody(), real.callBody(1, first.tool, first.arguments)])
    const resolve = call('context7', 'Next.js', 'How does routing work in Next.js?')
    const docs = real.secondCall('/vercel/next.js', 'How does routing work in Next.js?')
    expect(context7.sent.map(item => item.body)).toEqual([real.initializeBody(0), real.initializedBody(), real.callBody(1, resolve.tool, resolve.arguments),
      real.callBody(2, docs.tool, docs.arguments)])
    expect(deepwiki.sent.map(item => item.url)).toEqual(Array(3).fill('https://mcp.deepwiki.com/mcp'))
    expect(context7.sent.map(item => item.url)).toEqual(Array(4).fill('https://mcp.context7.com/mcp'))
    // No body carries the project, its folder name or the judge's session.
    for (const item of [...deepwiki.sent, ...context7.sent]) {
      const text = JSON.stringify(item)
      for (const word of [project, 'shopfront', judge.id, 's1']) expect(text).not.toContain(word)
    }
  })
})
