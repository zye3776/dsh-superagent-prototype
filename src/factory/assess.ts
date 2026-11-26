/**
 * The factory's `POST /assess` route: a factory hook posts one masked permission request, and the route answers with one
 * decision and appends that same decision as one line to `<project>/.factory/decisions.jsonl`.
 * The decision is masked with the factory's own mask before it is written and answered (`decisions.ts`); with no mask the route answers 503.
 * The route asks its `Judge` for the decision. In the plugin that is `ModelJudge` (`verdict.ts`), which asks the judge Session of the request's worker session;
 * when that judge cannot be opened or gives no usable answer in time, the route answers 503 and writes nothing. `StubJudge` gives the same fixed, safe
 * answer to every request and asks no model: the factory's contract check uses it. This file loads no judge code itself, so Node can run it straight from source.
 * Only the factory is answered: a caller must be on this machine and send the shared token (`token.ts`), and the route sends
 * the token back with each decision, so the factory can tell this route's reply from another service's.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { AssessRefusal, DecisionWriter, type Decision } from './decisions.ts'
import type { JobAnswer } from './job.ts'
import { SharedTokenFile } from './token.ts'

export { AssessRefusal, DecisionsFile, type Decision, type DecisionLine, type DecisionRead } from './decisions.ts'

/** One path of a shared temp folder (such as `/tmp`) that a request names, with what the factory's hook found out about it. */
export interface TempPathFact {
  /** The path as a full path, as far as it is known. */
  path: string
  /** True when the path is the worker session's own temp folder or lies inside it. */
  in_session_dir: boolean
  /** True when the worker session's record shows that this session made the file or folder. */
  created_by_session: boolean
  /** True when the path lies in the one shared temp folder the factory allows by name. */
  in_exception: boolean
}
/**
 * The temp-folder facts of one request, worked out by the factory's hook (`lib/tempFacts` there) and sent as the request's `temp`.
 * `session_dir` is the worker session's own temp folder, `null` when it has none; `variable_delete` says that the request deletes through a variable.
 */
export interface TempFacts { session_dir: string | null; paths: TempPathFact[]; variable_delete: boolean }

/** Checks that a request's `temp` has the agreed shape, so the judge is never handed facts of another shape. */
export class TempFactsShape {
  private static readonly FIELDS: readonly string[] = ['session_dir', 'paths', 'variable_delete']
  private static readonly PATH_FIELDS: readonly string[] = ['path', 'in_session_dir', 'created_by_session', 'in_exception']
  /** Whether `value` is `null` (the hook could not work the facts out) or the facts with exactly their fields: text where text belongs, true or false where a flag belongs. */
  static holds(value: unknown): value is TempFacts | null {
    if (value === null) return true
    if (!TempFactsShape.hasExactly(value, TempFactsShape.FIELDS)) return false
    if (value.session_dir !== null && typeof value.session_dir !== 'string') return false
    if (typeof value.variable_delete !== 'boolean' || !Array.isArray(value.paths)) return false
    return value.paths.every((fact: unknown) => TempFactsShape.hasExactly(fact, TempFactsShape.PATH_FIELDS) && typeof fact.path === 'string'
      && typeof fact.in_session_dir === 'boolean' && typeof fact.created_by_session === 'boolean' && typeof fact.in_exception === 'boolean')
  }
  /** Whether `value` is a plain object with these fields and no other. */
  private static hasExactly(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const present = Object.keys(value)
    return present.length === fields.length && fields.every(field => present.includes(field))
  }
}

/**
 * What the factory posts: its masked request record. Only these fields are read here; `project` is the raw absolute path, and `session_id` names the
 * worker session that asks, which gets a judge Session of its own. `temp` holds the request's temp-folder facts for the judge: left out by a caller
 * that sends none, `null` when the hook could not work them out.
 */
export interface AssessRequest { request_id: string; project: string; session_id: string; temp?: TempFacts | null; [field: string]: unknown }

/** A decision without `seconds`, which the route measures. */
export type Verdict = Omit<Decision, 'seconds'>
/** Decides one request. It may reject with `AssessRefusal`; the route then answers that status and writes nothing. */
export interface Judge { decide(request: AssessRequest): Verdict | Promise<Verdict> }

/**
 * Stands in for the judge where no model is asked: every request gets the same decision, `ask_owner`.
 * That is the safe answer if anything acts on it, because it hands the request back to the owner.
 */
export class StubJudge implements Judge {
  static readonly REASON = 'Stub decision: no judge is connected yet, so the request goes to the owner.'
  /** The factory's decision shape refuses an empty `cites`, so the stub says in words that it rests on nothing. */
  static readonly CITES = 'No plan or ticket applied: the stub reads none.'
  /** The decision for one request, without `seconds`, which the route measures. */
  decide(request: AssessRequest): Verdict {
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
/** Where the route tells each decision it wrote, for the job log: the plugin's `FactoryJob`. It never rejects. */
export interface AnswerLog { answered(answer: JobAnswer): Promise<void> }

/**
 * Serves `POST /assess` on DSH's web server, for the factory on this machine only.
 * It refuses a web server that is not bound to 127.0.0.1, a Host header that is not loopback, a request with an Origin header (a browser), a caller whose address is
 * not loopback, any method but POST, a caller that does not send the shared token, a body over 128 KiB or not JSON, a `temp` that is not in the agreed shape,
 * and a project that its configuration does not list.
 * A decision that cannot be masked (no mask module, or one that fails) is refused with 503 and not written, and so is a request its judge refuses
 * (no judge Session, no usable answer, or no answer in time).
 * Everything up to and including the token is checked before the body is read. The token is written to no file, log line or error message: only the 200 reply
 * carries it, in the `x-factory-token` header.
 */
export class AssessRoute {
  static readonly PATH = '/assess'
  static readonly MAX_BODY_BYTES = 128 * 1024
  /** The addresses a caller on this machine connects from: IPv4, IPv6, and IPv4 as an IPv6 socket reports it. */
  static readonly LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  private readonly projects: ReadonlySet<string>
  constructor(projects: readonly string[], private readonly tokens: TokenSource = new SharedTokenFile(), private readonly judge: Judge = new StubJudge(),
    private readonly now: () => Date = () => new Date(), private readonly writer: DecisionWriter = new DecisionWriter(), private readonly log?: AnswerLog) {
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
   * `seconds` is the whole time the judge took: opening its Session, waiting behind earlier questions of the same worker session, the question and, when there
   * was one, the repair question. The caller is not watched: a decision that comes after the caller gave up is still written.
   * Once the decision is written, the job log gets a `permission_answer` line that points at it; a line that cannot be written changes nothing here.
   */
  async assess(request: AssessRequest): Promise<string> {
    if (!this.projects.has(request.project)) throw new AssessRefusal(403, 'The project is not listed in the factory configuration')
    const started = performance.now()
    const verdict = await this.judge.decide(request)
    const seconds = Math.round(performance.now() - started) / 1000
    const written = await this.writer.write({ ...verdict, seconds, ts: this.now().toISOString(), project: request.project })
    await this.log?.answered({ project: request.project, requestId: request.request_id, decisionId: verdict.decision_id, decision: verdict.decision,
      tokens: verdict.tokens, seconds })
    return written
  }

  /**
   * Checks a parsed body and returns it as the request, unchanged. Refuses with 400 a body that is not an object, one without `request_id`, `project` or
   * `session_id`, and one whose `temp` is present but neither `null` nor the agreed facts. Public, so the factory's contract check can run the same check.
   */
  static requestOf(body: unknown): AssessRequest {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AssessRefusal(400, 'The request body is not a JSON object')
    const { request_id: id, project, session_id: session } = body as Record<string, unknown>
    if (typeof id !== 'string' || id === '') throw new AssessRefusal(400, 'The request has no request_id')
    if (typeof project !== 'string' || project === '') throw new AssessRefusal(400, 'The request has no project')
    if (typeof session !== 'string' || session === '') throw new AssessRefusal(400, 'The request has no session_id')
    if ('temp' in body && !TempFactsShape.holds((body as Record<string, unknown>).temp)) throw new AssessRefusal(400, 'The request has a malformed temp')
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
