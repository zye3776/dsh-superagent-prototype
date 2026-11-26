/**
 * The factory's `POST /assess` route: a factory hook posts one masked permission request, and the route answers with one
 * decision and appends that same decision as one line to `<project>/.factory/decisions.jsonl`.
 * This first version asks no model: `StubJudge` gives the same fixed, safe answer to every request.
 * Only the factory is answered: a caller must be on this machine and send the shared token (`token.ts`), and the route sends
 * the token back with each decision, so the factory can tell this route's reply from another service's.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, lstatSync, openSync, writeSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { SharedTokenFile } from './token.ts'

/** What the factory posts: its masked request record. Only these two fields are read here; `project` is the raw absolute path. */
export interface AssessRequest { request_id: string; project: string; [field: string]: unknown }
/** One file the judge read, and whether it used it. */
export interface DecisionRead { path: string; used: boolean }
/** A decision in the shape the factory's `lib/decisionSchema` checks. */
export interface Decision {
  decision_id: string
  request_id: string
  kind: 'permission' | 'fork'
  decision: 'approve' | 'deny' | 'ask_owner'
  choice: string | null
  risk: 'low' | 'medium' | 'high'
  reason: string
  alternative: string
  cites: string
  reads: DecisionRead[]
  tokens: number
  seconds: number
}
/** A line of `decisions.jsonl`: the decision, the time it was written (ISO-8601, UTC) and the project's absolute path. */
export type DecisionLine = Decision & { ts: string; project: string }

/**
 * Represents a refusal of one `/assess` request, with the HTTP status to answer.
 * The route's steps throw it, and `AssessRoute.handle` turns it into a JSON error body; nothing is written in that case.
 */
export class AssessRefusal extends Error { constructor(readonly status: 400 | 401 | 403 | 405 | 409 | 413 | 503, message: string) { super(message) } }

/**
 * Stands in for the judge until a model is asked: every request gets the same decision, `ask_owner`.
 * That is the safe answer if anything acts on it early, because it hands the request back to the owner.
 */
export class StubJudge {
  static readonly REASON = 'Stub decision: no judge is connected yet, so the request goes to the owner.'
  /** The decision for one request, without `seconds`, which the route measures. */
  decide(request: AssessRequest): Omit<Decision, 'seconds'> {
    return { decision_id: randomUUID(), request_id: request.request_id, kind: 'permission', decision: 'ask_owner', choice: null, risk: 'high',
      reason: StubJudge.REASON, alternative: '', cites: '', reads: [], tokens: 0 }
  }
}

/**
 * Appends decision lines to one project's `.factory/decisions.jsonl`.
 * It never creates `.factory/`: only the factory's own record writer does, so a project without the folder is refused.
 * A symlink at the folder's or the file's place is refused too, so a line cannot land in another folder.
 */
export class DecisionsFile {
  static readonly FOLDER = '.factory'
  static readonly FILE = 'decisions.jsonl'
  constructor(readonly project: string) {}
  /** Appends the line after whatever the file already holds, and returns the exact text written, without its line break. */
  append(line: DecisionLine): string {
    const folder = join(this.project, DecisionsFile.FOLDER)
    let real = false
    // lstat does not follow a symlink, so a link to a folder does not count as the folder.
    try { real = lstatSync(folder).isDirectory() } catch { /* missing: refused below */ }
    if (!real) throw new AssessRefusal(409, `The project has no ${DecisionsFile.FOLDER} folder yet`)
    const text = JSON.stringify(line)
    let fd: number
    // Append-only, and NOFOLLOW makes the open fail when the file's place holds a symlink.
    try { fd = openSync(join(folder, DecisionsFile.FILE), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new AssessRefusal(409, `Refusing to write through a symlink at ${DecisionsFile.FILE}`)
      throw error
    }
    try { writeSync(fd, `${text}\n`, null, 'utf8') } finally { closeSync(fd) }
    return text
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
    private readonly now: () => Date = () => new Date()) {
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
      AssessRoute.send(res, 200, this.assess(AssessRoute.requestOf(await AssessRoute.readBody(req))), { [SharedTokenFile.HEADER]: token })
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

  /** Decides one request and appends the decision to its project's file. Returns the line as written. */
  assess(request: AssessRequest): string {
    if (!this.projects.has(request.project)) throw new AssessRefusal(403, 'The project is not listed in the factory configuration')
    const started = performance.now()
    const verdict = this.judge.decide(request)
    const seconds = Math.round(performance.now() - started) / 1000
    return new DecisionsFile(request.project).append({ ...verdict, seconds, ts: this.now().toISOString(), project: request.project })
  }

  private static requestOf(body: unknown): AssessRequest {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AssessRefusal(400, 'The request body is not a JSON object')
    const { request_id: id, project } = body as Record<string, unknown>
    if (typeof id !== 'string' || id === '') throw new AssessRefusal(400, 'The request has no request_id')
    if (typeof project !== 'string' || project === '') throw new AssessRefusal(400, 'The request has no project')
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
