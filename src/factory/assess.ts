/**
 * The factory's `POST /assess` route: a factory hook posts one masked permission request, and the route answers with one
 * decision and appends that same decision as one line to `<project>/.factory/decisions.jsonl`.
 * The decision is masked with the factory's own mask before it is written and answered (`decisions.ts`); with no mask the route answers 503.
 * This version asks no model: `StubJudge` gives the same fixed, safe answer to every request. Each request still opens the judge Session of its worker
 * session (`judge.ts`), one for each `session_id` of a project, which is asked nothing yet; when that Session cannot be opened the route answers 503.
 * Only the factory is answered: a caller must be on this machine and send the shared token (`token.ts`), and the route sends
 * the token back with each decision, so the factory can tell this route's reply from another service's.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { AssessRefusal, DecisionWriter, type Decision } from './decisions.ts'
import type { JudgeOpener } from './judge.ts'
import { SharedTokenFile } from './token.ts'

export { AssessRefusal, DecisionsFile, type Decision, type DecisionLine, type DecisionRead } from './decisions.ts'

/**
 * What the factory posts: its masked request record. Only these three fields are read here; `project` is the raw absolute path, and `session_id` names the
 * worker session that asks, which gets a judge Session of its own.
 */
export interface AssessRequest { request_id: string; project: string; session_id: string; [field: string]: unknown }

/**
 * Stands in for the judge until a model is asked: every request gets the same decision, `ask_owner`.
 * That is the safe answer if anything acts on it early, because it hands the request back to the owner.
 */
export class StubJudge {
  static readonly REASON = 'Stub decision: no judge is connected yet, so the request goes to the owner.'
  /** The factory's decision shape refuses an empty `cites`, so the stub says in words that it rests on nothing. */
  static readonly CITES = 'No plan or ticket applied: the stub reads none.'
  /** The decision for one request, without `seconds`, which the route measures. */
  decide(request: AssessRequest): Omit<Decision, 'seconds'> {
    return { decision_id: randomUUID(), request_id: request.request_id, kind: 'permission', decision: 'ask_owner', choice: null, risk: 'high',
      reason: StubJudge.REASON, alternative: '', cites: StubJudge.CITES, reads: [], tokens: 0 }
  }
}

/** The route as DSH 0.2.3 takes it. `auth` is not in the route type of the older version this package builds against, which ignores it. */
interface AnonymousRoute {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  auth: 'anonymous'
}

/** Where the route gets the shared token from, on every request. `undefined` means there is no usable token. */
export interface TokenSource { read(): string | undefined }

/**
 * Serves `POST /assess` on DSH's web server, for the factory on this machine only.
 * It refuses a web server that is not bound to 127.0.0.1, a Host header that is not loopback, a request with an Origin header (a browser), a caller whose address is
 * not loopback, any method but POST, a caller that does not send the shared token, a body over 128 KiB or not JSON, and a project that its configuration does not list.
 * A decision that cannot be masked (no mask module, or one that fails) is refused with 503 and not written, and so is a request whose judge Session cannot be
 * opened (no guard module, or DSH fails to make the Session).
 * Everything up to and including the token is checked before the body is read. The token is written to no file, log line or error message: only the 200 reply
 * carries it, in the `x-factory-token` header.
 */
export class AssessRoute {
  static readonly PATH = '/assess'
  static readonly MAX_BODY_BYTES = 128 * 1024
  /** The addresses a caller on this machine connects from: IPv4, IPv6, and IPv4 as an IPv6 socket reports it. */
  static readonly LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  private readonly projects: ReadonlySet<string>
  constructor(projects: readonly string[], private readonly tokens: TokenSource = new SharedTokenFile(), private readonly judge: StubJudge = new StubJudge(),
    private readonly now: () => Date = () => new Date(), private readonly writer: DecisionWriter = new DecisionWriter(),
    /** Opens the judge Session of a request's worker session. Left out, no Session is opened: the route then only answers with the stub. */
    private readonly judges?: JudgeOpener) {
    const relative = projects.filter(project => !isAbsolute(project))
    if (relative.length) throw new Error(`dsh-superagent-factory projects must be absolute paths: ${relative.join(', ')}`)
    // Normalised, so an entry written with a trailing slash or `..` still matches the absolute path a caller sends.
    this.projects = new Set(projects.map(project => resolve(project)))
  }
  /** How many projects the route may write into. */
  get projectCount(): number { return this.projects.size }

  /** Adds the route to the web server and returns the function that removes it. */
  register(ctx: Context): () => void {
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('The factory /assess route requires a loopback Web server')
    // Anonymous to DSH, because its login accepts only a browser cookie, which a hook does not have. The route checks the shared token itself.
    const route: AnonymousRoute = { kind: 'exact', path: AssessRoute.PATH, auth: 'anonymous', handler: (req, res) => this.handle(req, res, ctx.webServer.port) }
    return ctx.webServer.register(route)
  }

  /** Answers one HTTP request: 200 with the decision line and the shared token in its header, or the status of the refusal with `{ error }`. */
  async handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    let bodyRead = false
    try {
      const token = this.admit(req, port)
      bodyRead = true
      AssessRoute.send(res, 200, await this.assess(AssessRoute.requestOf(await AssessRoute.readBody(req))), { [SharedTokenFile.HEADER]: token })
    } catch (error) {
      // A caller refused before its body was read may still be sending it: the upload is read and thrown away, so the caller receives the answer and not a broken connection.
      if (!bodyRead) req.resume()
      if (error instanceof AssessRefusal) AssessRoute.send(res, error.status, JSON.stringify({ error: error.message }), error.status === 405 ? { allow: 'POST' } : {})
      else AssessRoute.send(res, 500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }

  /**
   * Checks who is calling, before any of the body is read, and returns the shared token to send back.
   * The order is fixed: where the request claims to go and come from, where it really comes from, the method, this side's own token file, then the caller's token.
   */
  private admit(req: IncomingMessage, port: number): string {
    const host = req.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new AssessRefusal(403, 'Loopback request required')
    // A browser adds Origin to every cross-site POST; the factory's client never sends one, so a web page cannot forge a decision.
    if (req.headers.origin !== undefined) throw new AssessRefusal(403, 'Browser requests are refused')
    // The Host header is the caller's word; the address of the connection is not.
    if (!AssessRoute.LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) throw new AssessRefusal(403, 'Loopback request required')
    if (req.method !== 'POST') throw new AssessRefusal(405, 'Only POST is allowed')
    const token = this.tokens.read()
    if (token === undefined) throw new AssessRefusal(503, 'The route has no usable token file, so it answers nobody')
    const sent = req.headers[SharedTokenFile.HEADER]
    if (typeof sent !== 'string' || sent === '' || !SharedTokenFile.same(sent, token)) throw new AssessRefusal(401, 'The shared token is missing or wrong')
    return token
  }

  /**
   * Decides one request, and has the decision masked and appended to its project's file. Returns the line as written, which is the masked one.
   * The judge Session of the request's worker session is opened first and asked nothing: the stub still decides.
   */
  async assess(request: AssessRequest): Promise<string> {
    if (!this.projects.has(request.project)) throw new AssessRefusal(403, 'The project is not listed in the factory configuration')
    await this.judges?.open(request.project, request.session_id)
    const started = performance.now()
    const verdict = this.judge.decide(request)
    const seconds = Math.round(performance.now() - started) / 1000
    return this.writer.write({ ...verdict, seconds, ts: this.now().toISOString(), project: request.project })
  }

  private static requestOf(body: unknown): AssessRequest {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AssessRefusal(400, 'The request body is not a JSON object')
    const { request_id: id, project, session_id: session } = body as Record<string, unknown>
    if (typeof id !== 'string' || id === '') throw new AssessRefusal(400, 'The request has no request_id')
    if (typeof project !== 'string' || project === '') throw new AssessRefusal(400, 'The request has no project')
    if (typeof session !== 'string' || session === '') throw new AssessRefusal(400, 'The request has no session_id')
    return body as AssessRequest
  }

  /**
   * Reads the body as JSON. Over the limit, it stops keeping bytes and refuses at once, while the rest of the upload is
   * still read and thrown away, so the caller receives the 413 answer and not a broken connection.
   */
  private static readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const tooLarge = () => new AssessRefusal(413, `Request exceeds ${AssessRoute.MAX_BODY_BYTES} bytes`)
      if (Number(req.headers['content-length']) > AssessRoute.MAX_BODY_BYTES) { req.resume(); reject(tooLarge()); return }
      let size = 0, chunks: Buffer[] | undefined = []
      req.on('data', (chunk: Buffer | string) => {
        if (!chunks) return
        const bytes = Buffer.from(chunk); size += bytes.length
        if (size > AssessRoute.MAX_BODY_BYTES) { chunks = undefined; reject(tooLarge()) } else chunks.push(bytes)
      })
      req.on('error', reject)
      req.on('end', () => {
        if (!chunks) return
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) } catch { reject(new AssessRefusal(400, 'The request body is not JSON')) }
      })
    })
  }

  private static send(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
    res.end(text)
  }
}
