/**
 * The factory's `POST /assess` route: a factory hook posts one masked permission request, and the route answers with one
 * decision and appends that same decision as one line to `<project>/.factory/decisions.jsonl`.
 * The decision is masked with the factory's own mask before it is written and answered (`decisions.ts`); with no mask the route answers 503.
 * The route asks its `Judge` for the decision. In the plugin that is `ModelJudge` (`verdict.ts`), which asks the judge Session of the request's worker session;
 * when that judge cannot be opened or gives no usable answer in time, the route answers 503 and writes nothing. `StubJudge` gives the same fixed, safe
 * answer to every request and asks no model: the factory's contract check uses it. This file loads no judge code itself, so Node can run it straight from source.
 * Each request may carry the checking tier the factory's gate gave it (`tier`, `tier_rule`); every decision records its final `tier` and `tier_set_by`
 * (`TierChoice` in `decisions.ts`), the stub's too.
 * Only the factory is answered: a caller must be on this machine and send the shared token (`token.ts`), and the route sends
 * the token back with each decision, so the factory can tell this route's reply from another service's.
 *
 * Two more routes sit beside it, for "ask first": a worker tells the judge what it is about to do, and why, before it does it.
 * `POST /ask` takes the worker's action (`session_id`, `tool_name`, `tool_input`), its `description` and an optional `context`. The route masks them with
 * the factory's mask, has the judge of that worker session decide, and writes the decision as `/assess` does. An `approve` is then held for a short
 * time (`approvals.ts`) under the factory's own `request_key` of that exact call. A worker holds no shared token, so `/ask` asks for none and sends
 * none back. Instead it sends its session's ask key (`AskKey` in `token.ts`), which only a holder of the token can make for that `session_id`: an ask
 * without the right key for the body's `session_id` is refused with 401 before any judge is asked, so no caller can put questions into another
 * session's judge thread. A decision that is not an approve leaves an approval held earlier for the same call as it is: only that session's own newer
 * approve replaces it.
 * A decision `/assess` writes for a request drops the approval held for that request's `request_key` (same session and project): the real call
 * has now been decided, so the same call sent again is judged again and not allowed on the older approval. An ask that was still with the judge
 * when `/assess` decided holds nothing when its approve comes back. Only `/assess` does this, never an ask, and never a refused request.
 * `POST /claim` is for the factory's hook (shared token, as `/assess`): when the same call reaches the hook, it posts the call's key and gets the held
 * approval's `decision_id`, once, with no model call. With nothing to claim the hook posts to `/assess` as before.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { PendingApprovals, type ApprovalClaim } from './approvals.ts'
import { AssessRefusal, DecisionWriter, TierChoice, type Decision, type DecisionLine, type Tier } from './decisions.ts'
import { AskKey, SharedTokenFile } from './token.ts'

export { AssessRefusal, DecisionsFile, TierChoice, type Decision, type DecisionLine, type DecisionRead, type Tier } from './decisions.ts'

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
 * that sends none, `null` when the hook could not work them out. `context` is background a worker gave with an ask: its own claim, never evidence.
 * `tier` is the checking tier the factory's gate sorted the request into by plain code (1 project direction, 2 third-party tools, 3 low risk), and
 * `tier_rule` the name of its rule: both `null` when the gate left the request unsorted, and left out by a caller that sends none. An `/ask` never
 * carries them: a worker cannot set its own tier.
 */
export interface AssessRequest {
  request_id: string; project: string; session_id: string; temp?: TempFacts | null; context?: string; tier?: Tier | null; tier_rule?: string | null
  [field: string]: unknown
}
/**
 * What a worker posts to `/ask` before it acts: the call it is about to make (`session_id`, `tool_name` and `tool_input`, exactly as its tool call
 * will carry them), `description` (what the action is and why) and, when it has some, `context` (background the judge would not see otherwise).
 */
export interface AskRequest { project: string; session_id: string; tool_name: string; tool_input: unknown; description: string; context?: string }
/** What the factory's hook posts to `/claim`: its own `request_id`, and what identifies the request an approval may be held for. */
export interface ClaimRequest extends ApprovalClaim { request_id: string }

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
      ...TierChoice.of(TierChoice.gateTierOf(request), 'high'), reason: StubJudge.REASON, alternative: '', cites: StubJudge.CITES, reads: [], tokens: 0 }
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
 * not loopback, any method but POST, a caller that does not send the shared token, a body over 128 KiB or not JSON, a `temp` that is not in the agreed shape,
 * and a project that its configuration does not list.
 * A decision that cannot be masked (no mask module, or one that fails) is refused with 503 and not written, and so is a request its judge refuses
 * (no judge Session, no usable answer, or no answer in time).
 * Everything up to and including the token is checked before the body is read. The token is written to no file, log line or error message: only the 200 reply
 * carries it, in the `x-factory-token` header.
 */
export class AssessRoute {
  static readonly PATH = '/assess'
  static readonly ASK_PATH = '/ask'
  static readonly CLAIM_PATH = '/claim'
  static readonly MAX_BODY_BYTES = 128 * 1024
  /** The addresses a caller on this machine connects from: IPv4, IPv6, and IPv4 as an IPv6 socket reports it. */
  static readonly LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  private readonly projects: ReadonlySet<string>
  constructor(projects: readonly string[], private readonly tokens: TokenSource = new SharedTokenFile(), private readonly judge: Judge = new StubJudge(),
    private readonly now: () => Date = () => new Date(), private readonly writer: DecisionWriter = new DecisionWriter(),
    private readonly approvals: PendingApprovals = new PendingApprovals(undefined, () => now().getTime())) {
    const relative = projects.filter(project => !isAbsolute(project))
    if (relative.length) throw new Error(`dsh-superagent-factory projects must be absolute paths: ${relative.join(', ')}`)
    // Normalised, so an entry written with a trailing slash or `..` still matches the absolute path a caller sends.
    this.projects = new Set(projects.map(project => resolve(project)))
  }
  /** How many projects the route may write into. */
  get projectCount(): number { return this.projects.size }

  /** Adds the three routes (`/assess`, `/ask`, `/claim`) to the web server and returns the function that removes them. */
  register(ctx: Context): () => void {
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('The factory /assess route requires a loopback Web server')
    const port = () => ctx.webServer.port
    // Anonymous to DSH, because its login accepts only a browser cookie, which a hook does not have. `/assess` and `/claim` check the shared token themselves.
    const routes: AnonymousRoute[] = [
      { kind: 'exact', path: AssessRoute.PATH, auth: 'anonymous', handler: (req, res) => this.handle(req, res, port()) },
      { kind: 'exact', path: AssessRoute.ASK_PATH, auth: 'anonymous', handler: (req, res) => this.handleAsk(req, res, port()) },
      { kind: 'exact', path: AssessRoute.CLAIM_PATH, auth: 'anonymous', handler: (req, res) => this.handleClaim(req, res, port()) },
    ]
    const removers = routes.map(route => ctx.webServer.register(route))
    return () => { for (const remove of removers) remove() }
  }

  /**
   * Answers one `/assess` request: 200 with the decision line and the shared token in its header, or the status of the refusal with `{ error }`.
   * Once the decision is written, whatever it is, the approval held for the request's `request_key` is dropped (`PendingApprovals.settle`): this is
   * the decision on the real call. A refused request wrote no decision and drops nothing, and so does a body without a text `request_key`.
   * It is done here and not in `assess()`, which `/ask` runs too: an ask never cancels an approval.
   */
  handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    return this.answer(req, res, port, true, async body => {
      const request = AssessRoute.requestOf(body)
      const line = await this.assess(request)
      const key = request.request_key
      if (typeof key === 'string' && key !== '') this.approvals.settle({ request_key: key, session_id: request.session_id, project: request.project })
      return line
    })
  }

  /**
   * Answers one `/ask` request: 200 with `{ decision, pending_until }`, or the status of the refusal with `{ error }`.
   * The caller is a worker, which has no shared token: none is asked for and none is sent back. It must send the ask key of the body's
   * `session_id` instead, checked once the body is read (the key depends on it) and before any judge is asked.
   */
  handleAsk(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    return this.answer(req, res, port, false, async body => {
      const ask = AssessRoute.askOf(body)
      this.checkAskKey(req, ask.session_id)
      return this.ask(ask)
    })
  }

  /**
   * Refuses an ask that does not carry the ask key of `session`: 503 while this side has no usable token file (it cannot compute any key),
   * 401 when the key is missing or wrong, including the key of another session. The key is compared in constant time and never echoed.
   */
  private checkAskKey(req: IncomingMessage, session: string): void {
    const token = this.tokens.read()
    if (token === undefined) throw new AssessRefusal(503, 'The route has no usable token file, so it answers nobody')
    const sent = req.headers[AskKey.HEADER]
    if (typeof sent !== 'string' || sent === '' || !SharedTokenFile.same(sent, AskKey.compute(token, session))) {
      throw new AssessRefusal(401, 'The ask key is missing or wrong for this session')
    }
  }

  /** Answers one `/claim` request: 200 with the claim reply and the shared token in its header, or the status of the refusal with `{ error }`. */
  handleClaim(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    return this.answer(req, res, port, true, async body => this.claim(AssessRoute.claimOf(body)))
  }

  /** Admits the caller, reads the body and sends what `reply` makes of it. With `withToken`, the caller must send the shared token and gets it back. */
  private async answer(req: IncomingMessage, res: ServerResponse, port: number, withToken: boolean, reply: (body: unknown) => Promise<string>): Promise<void> {
    let bodyRead = false
    try {
      const token = this.admit(req, port, withToken)
      bodyRead = true
      AssessRoute.send(res, 200, await reply(await AssessRoute.readBody(req)), token === undefined ? {} : { [SharedTokenFile.HEADER]: token })
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
   * Without `withToken` (`/ask`) the last two steps are left out, the token file is not read here, and nothing is returned: `/ask` reads the
   * token file after the body, to check the ask key of the body's `session_id`.
   */
  private admit(req: IncomingMessage, port: number, withToken: boolean): string | undefined {
    const host = req.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new AssessRefusal(403, 'Loopback request required')
    // A browser adds Origin to every cross-site POST; the factory's client never sends one, so a web page cannot forge a decision.
    if (req.headers.origin !== undefined) throw new AssessRefusal(403, 'Browser requests are refused')
    // The Host header is the caller's word; the address of the connection is not.
    if (!AssessRoute.LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) throw new AssessRefusal(403, 'Loopback request required')
    if (req.method !== 'POST') throw new AssessRefusal(405, 'Only POST is allowed')
    if (!withToken) return undefined
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
   */
  async assess(request: AssessRequest): Promise<string> {
    if (!this.projects.has(request.project)) throw new AssessRefusal(403, 'The project is not listed in the factory configuration')
    const started = performance.now()
    const verdict = await this.judge.decide(request)
    const seconds = Math.round(performance.now() - started) / 1000
    return this.writer.write({ ...verdict, seconds, ts: this.now().toISOString(), project: request.project })
  }

  /**
   * Judges an action a worker asks about before it runs it, and holds an `approve` for the hook to claim. Returns the reply text:
   * `{ decision, pending_until }`, where `decision` is the decision line as written and `pending_until` the moment the held approval expires
   * (ISO-8601, UTC), or `null` when the judge did not approve: then nothing new is held, and an approve held earlier for the same call stays
   * claimable until it expires (a weak ask cannot cancel it; a newer approve of the same call replaces it).
   * `pending_until` is also `null` for an approve when `/assess` decided the same call while this ask was with the judge: the real call is
   * already over, so nothing is held for it. The ask notes where the settlements stood before the judge is asked (`mark`) to tell.
   * The key is computed first, on the raw values, with the factory's own key function: the hook computes the same key for the real call. Then the
   * fields are masked with the factory's mask, as the hook masks a request, so the judge sees no secret and not who the owner is. Without the key
   * function or the mask the ask is refused with 503 before any judge is asked. The judged request has the shape of an `/assess` request, with a new
   * `request_id`, the worker's `description` as `reason`, and `context` when given. It carries no `temp`: a worker cannot state those facts itself,
   * and the hook claims no approval for a request the temp-folder rule is about.
   */
  async ask(ask: AskRequest): Promise<string> {
    if (!this.projects.has(ask.project)) throw new AssessRefusal(403, 'The project is not listed in the factory configuration')
    const key = await this.writer.requestKey(ask.session_id, ask.tool_name, ask.tool_input)
    const masked = await this.writer.maskRequest(ask.project, { session_id: ask.session_id, tool_name: ask.tool_name, tool_input: ask.tool_input,
      reason: ask.description, ...(ask.context === undefined ? {} : { context: ask.context }) })
    const { session_id: session, context } = masked
    // The masked session id names the judge Session, as it does for `/assess`, where the hook's masked record brings it.
    if (typeof session !== 'string' || session === '') throw new AssessRefusal(503, 'The request could not be masked, so it is not judged')
    if (ask.context !== undefined && typeof context !== 'string') throw new AssessRefusal(503, 'The request could not be masked, so it is not judged')
    const since = this.approvals.mark()
    const line = await this.assess({ request_id: randomUUID(), request_key: key, project: ask.project, session_id: session, tool_name: masked.tool_name,
      tool_input: masked.tool_input, reason: masked.reason, ...(typeof context === 'string' ? { context } : {}) })
    const decision = JSON.parse(line) as DecisionLine
    const until = decision.decision === 'approve'
      ? this.approvals.hold({ request_key: key, session_id: session, project: ask.project, decision_id: decision.decision_id }, since)?.toISOString() ?? null
      : null
    // The line is put in as written, so the reply holds exactly what the decisions file holds.
    return `{"decision":${line},"pending_until":${JSON.stringify(until)}}`
  }

  /**
   * Hands out the approval held for exactly this request, once, and returns the reply text: `{ claimed: true, request_id, decision_id, project }`,
   * or the same with `claimed: false` and `decision_id: null` when none is held for it (never approved, another request, session or project,
   * expired, or claimed before). No judge is asked and nothing is written: the decision line was written when the worker asked.
   */
  claim(claim: ClaimRequest): string {
    if (!this.projects.has(claim.project)) throw new AssessRefusal(403, 'The project is not listed in the factory configuration')
    const id = this.approvals.claim(claim) ?? null
    return JSON.stringify({ claimed: id !== null, request_id: claim.request_id, decision_id: id, project: claim.project })
  }

  /**
   * Checks a parsed `/ask` body and returns only its known fields. Refuses with 400 a body that is not an object, one without `project`, `session_id`,
   * `tool_name`, `tool_input` or `description`, and one whose `context` is present but not text.
   */
  static askOf(body: unknown): AskRequest {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AssessRefusal(400, 'The request body is not a JSON object')
    const { project, session_id: session, tool_name: tool, tool_input: input, description, context } = body as Record<string, unknown>
    if (typeof project !== 'string' || project === '') throw new AssessRefusal(400, 'The request has no project')
    if (typeof session !== 'string' || session === '') throw new AssessRefusal(400, 'The request has no session_id')
    if (typeof tool !== 'string' || tool === '') throw new AssessRefusal(400, 'The request has no tool_name')
    if (input === undefined) throw new AssessRefusal(400, 'The request has no tool_input')
    if (typeof description !== 'string' || description.trim() === '') throw new AssessRefusal(400, 'The request has no description')
    if ('context' in body && typeof context !== 'string') throw new AssessRefusal(400, 'The request has a malformed context')
    return { project, session_id: session, tool_name: tool, tool_input: input, description, ...(typeof context === 'string' ? { context } : {}) }
  }

  /** Checks a parsed `/claim` body and returns only its known fields. Refuses with 400 a body that is not an object or lacks one of the four texts. */
  static claimOf(body: unknown): ClaimRequest {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AssessRefusal(400, 'The request body is not a JSON object')
    const { request_id: id, request_key: key, session_id: session, project } = body as Record<string, unknown>
    if (typeof id !== 'string' || id === '') throw new AssessRefusal(400, 'The request has no request_id')
    if (typeof key !== 'string' || key === '') throw new AssessRefusal(400, 'The request has no request_key')
    if (typeof session !== 'string' || session === '') throw new AssessRefusal(400, 'The request has no session_id')
    if (typeof project !== 'string' || project === '') throw new AssessRefusal(400, 'The request has no project')
    return { request_id: id, request_key: key, session_id: session, project }
  }

  /**
   * Checks a parsed body and returns it as the request, unchanged. Refuses with 400 a body that is not an object, one without `request_id`, `project` or
   * `session_id`, one whose `temp` is present but neither `null` nor the agreed facts, one whose `context` is present but not text, and one whose `tier` is
   * present but neither `null` nor the whole number 1, 2 or 3, or whose `tier_rule` is present but neither `null` nor text. Public, so the factory's contract check can run the same check.
   */
  static requestOf(body: unknown): AssessRequest {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AssessRefusal(400, 'The request body is not a JSON object')
    const { request_id: id, project, session_id: session } = body as Record<string, unknown>
    if (typeof id !== 'string' || id === '') throw new AssessRefusal(400, 'The request has no request_id')
    if (typeof project !== 'string' || project === '') throw new AssessRefusal(400, 'The request has no project')
    if (typeof session !== 'string' || session === '') throw new AssessRefusal(400, 'The request has no session_id')
    if ('temp' in body && !TempFactsShape.holds((body as Record<string, unknown>).temp)) throw new AssessRefusal(400, 'The request has a malformed temp')
    if ('context' in body && typeof (body as Record<string, unknown>).context !== 'string') throw new AssessRefusal(400, 'The request has a malformed context')
    const { tier, tier_rule: rule } = body as Record<string, unknown>
    if (!TierChoice.holds(tier) || (rule !== undefined && rule !== null && typeof rule !== 'string')) throw new AssessRefusal(400, 'The request has a malformed tier')
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
