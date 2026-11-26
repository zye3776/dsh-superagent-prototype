/**
 * The judge's `docs_lookup` tool: asks one public documentation service a general question about a tool or library, and gives the judge the answer's text.
 * Every request body comes from the factory's `DocumentationQuery` (in `lib/dist/judgeGuard.js`), built from the name and the question alone, so this file adds
 * nothing to what leaves the machine: no project, path, request, session id or reads. The judge guard checks each call before it runs (`DocumentationQuery.refusal`),
 * so a refused lookup sends nothing. The services speak MCP over streamable HTTP: one POST per JSON-RPC message, answered with JSON or with `text/event-stream`
 * `data:` lines. A lookup never throws: a network failure, a status that is not 2xx or a JSON-RPC error becomes a tool result that says the lookup failed, without
 * repeating the error's own text.
 */

/** The services `DocumentationQuery` knows. */
export type DocumentationService = 'deepwiki' | 'context7'
/** One MCP tool call `DocumentationQuery` built. */
export interface DocumentationCall { tool: string; arguments: Record<string, string>; resolvesLibrary: boolean }
/** The part of the factory's `DocumentationQuery` class this file uses: the services and the request bodies. */
export interface DocumentationBodies {
  readonly SERVICES: Readonly<Record<DocumentationService, { label: string; url: string }>>
  initializeBody(id?: number): Record<string, unknown>
  initializedBody(): Record<string, unknown>
  callBody(id: number, tool: string, args: Record<string, string>): Record<string, unknown>
  firstCall(service: DocumentationService, name: string, question: string): DocumentationCall
  secondCall(libraryId: string, question: string): DocumentationCall
  libraryIdOf(replyText: string): string | null
}
/** The arguments of one `docs_lookup` call, as the guard allowed them. */
export interface DocsLookupArgs { service: DocumentationService; name: string; question: string }
/** The `fetch` this file uses; tests hand in one that records each request. */
export type Fetcher = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>

/** Thrown inside a lookup for one failed step; `run` turns it into the tool's text. */
class LookupFailure extends Error {}

/** Runs one `docs_lookup` call: connects to the service, sends the call `DocumentationQuery` built (two for a Context7 library name) and returns the answer's text. */
export class DocsLookup {
  static readonly TOOL = 'docs_lookup'
  /** The longest answer text the judge is given, in characters. */
  static readonly MAX_TEXT = 6000
  /** How long one whole lookup may take: it starts within the first 10 seconds of a question, so it ends well inside the factory hook's 30-second wait. */
  static readonly TIMEOUT_MS = 10_000
  static readonly DESCRIPTION = 'Look up the public documentation of a tool or library. Send only its name and one general question (at most 300 characters, one line):'
    + ' no code, path, file name, project name, id or anything from the request. service "deepwiki" takes a GitHub owner/repo such as facebook/react;'
    + ' service "context7" takes a library name such as Next.js or a Context7 id such as /vercel/next.js.'
  /** The tool's parameters, as JSON Schema. */
  static readonly PARAMETERS = {
    type: 'object',
    properties: {
      service: { type: 'string', enum: ['deepwiki', 'context7'], description: 'deepwiki (a GitHub repository) or context7 (a library).' },
      name: { type: 'string', description: 'The tool or library: owner/repo for deepwiki, a library name or /org/project id for context7.' },
      question: { type: 'string', description: 'One general question about the tool or library, at most 300 characters, on one line.' },
    },
    required: ['service', 'name', 'question'],
    additionalProperties: false,
  } as const

  constructor(private readonly bodies: DocumentationBodies, private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = DocsLookup.TIMEOUT_MS) {}

  /** The arguments as a lookup, or `undefined` when they are not one; the guard already refused anything else. */
  static argsOf(args: unknown): DocsLookupArgs | undefined {
    if (typeof args !== 'object' || args === null) return undefined
    const { service, name, question } = args as Record<string, unknown>
    if ((service !== 'deepwiki' && service !== 'context7') || typeof name !== 'string' || typeof question !== 'string') return undefined
    return { service, name, question }
  }

  /** The answer's text for one lookup, at most `MAX_TEXT` characters, or a text that says the lookup failed. Never throws. */
  async run(args: unknown, signal?: AbortSignal): Promise<string> {
    const lookup = DocsLookup.argsOf(args)
    if (lookup === undefined) return 'The documentation lookup was not sent: it needs service, name and question.'
    const label = this.bodies.SERVICES[lookup.service].label
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const within = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      return DocsLookup.capped(await this.ask(lookup, within))
    } catch (error) {
      const step = error instanceof LookupFailure ? error.message : 'the request did not complete'
      return `The ${label} documentation lookup failed (${step}). Decide without it.`
    }
  }

  private async ask({ service, name, question }: DocsLookupArgs, signal: AbortSignal): Promise<string> {
    const url = this.bodies.SERVICES[service].url
    const connection = await this.open(url, signal)
    const first = this.bodies.firstCall(service, name, question)
    const firstText = await this.call(url, connection, 1, first, signal)
    if (!first.resolvesLibrary) return firstText
    const libraryId = this.bodies.libraryIdOf(firstText)
    if (libraryId === null) return `Context7 found no library id for ${name}. Decide without it, or ask DeepWiki with the library's GitHub owner/repo.`
    return this.call(url, connection, 2, this.bodies.secondCall(libraryId, question), signal)
  }

  /** Sends `initialize` and `notifications/initialized`; returns the headers later requests carry (the session id, when the service gave one). */
  private async open(url: string, signal: AbortSignal): Promise<Record<string, string>> {
    const reply = await this.post(url, {}, this.bodies.initializeBody(0), signal, 'the service did not accept the connection')
    const result = DocsLookup.messageOf(await reply.text(), reply.headers.get('content-type'), 0, 'the service did not accept the connection')
    const headers: Record<string, string> = {}
    const session = reply.headers.get('mcp-session-id')
    if (session !== null && session !== '') headers['mcp-session-id'] = session
    const version = (result as { protocolVersion?: unknown }).protocolVersion
    if (typeof version === 'string' && /^[\w.-]{1,32}$/.test(version)) headers['mcp-protocol-version'] = version
    const done = await this.post(url, headers, this.bodies.initializedBody(), signal, 'the service did not accept the connection')
    // The notification has no answer to read; the body is drained so the connection is freed.
    await done.text().catch(() => '')
    return headers
  }

  /** One `tools/call`; returns the text blocks of its result. */
  private async call(url: string, headers: Record<string, string>, id: number, call: DocumentationCall, signal: AbortSignal): Promise<string> {
    const reply = await this.post(url, headers, this.bodies.callBody(id, call.tool, call.arguments), signal, 'the service gave no answer')
    const result = DocsLookup.messageOf(await reply.text(), reply.headers.get('content-type'), id, 'the service gave no answer') as { content?: unknown; isError?: unknown }
    if (result.isError === true) throw new LookupFailure('the service could not answer this question')
    const blocks = Array.isArray(result.content) ? result.content : []
    const text = blocks.filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
      .map(block => block.text).join('\n').trim()
    if (text === '') throw new LookupFailure('the answer held no text')
    return text
  }

  private async post(url: string, headers: Record<string, string>, body: Record<string, unknown>, signal: AbortSignal, failure: string): Promise<Response> {
    let reply: Response
    try {
      reply = await this.fetcher(url, { method: 'POST', signal, body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } })
    } catch {
      throw new LookupFailure(signal.aborted ? 'it took too long' : 'the service could not be reached')
    }
    if (!reply.ok) {
      await reply.text().catch(() => '')
      throw new LookupFailure(`${failure}: status ${reply.status}`)
    }
    return reply
  }

  /** The `result` of the JSON-RPC answer with `id`, read from a JSON body or from `text/event-stream` `data:` lines. */
  private static messageOf(text: string, contentType: string | null, id: number, failure: string): Record<string, unknown> {
    const candidates = contentType?.includes('text/event-stream') === true
      ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
      : [text]
    for (const candidate of candidates) {
      let message: unknown
      try { message = JSON.parse(candidate) } catch { continue }
      if (typeof message !== 'object' || message === null || (message as { id?: unknown }).id !== id) continue
      const { result, error } = message as { result?: unknown; error?: unknown }
      if (error !== undefined) throw new LookupFailure('the service answered with an error')
      if (typeof result === 'object' && result !== null) return result as Record<string, unknown>
    }
    throw new LookupFailure(failure)
  }

  private static capped(text: string): string {
    return text.length <= DocsLookup.MAX_TEXT ? text : `${text.slice(0, DocsLookup.MAX_TEXT)}\n[cut at ${DocsLookup.MAX_TEXT} characters]`
  }
}
