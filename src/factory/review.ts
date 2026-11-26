/**
 * The owner's review page, served at `/review` on DSH's web server: it shows what the super agent did in one job and takes the owner's comment on it.
 * This is the first, bare version: one job's lines in time order and one always-open comment field. It reads `<project>/.factory/actions.jsonl` and
 * `reviews.jsonl` of every listed project and writes only comment lines, each masked with the factory's own mask first (`records.ts`).
 * Only the owner's browser on this machine is answered: every request must come over loopback, name a loopback Host and carry no foreign Origin, and
 * everything but the sign-in form needs the cookie the owner gets by typing the shared token (`token.ts`) into that form once.
 * The page loads nothing from anywhere else and brings no colours of its own: its style names DSH's design tokens only.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { FactoryRecordsModule, RecordsRefusal, ReviewWriter, type JobLogLine, type RecordsSource } from './records.ts'
import { SharedTokenFile } from './token.ts'

/** Where the page gets the shared token from, on every request. `undefined` means there is no usable token. */
export interface ReviewTokenSource { read(): string | undefined }

/**
 * Represents a refusal of one request to the review page, with the HTTP status to answer.
 * The route's steps throw it, and `ReviewRoute.handle` turns it into the answer; nothing is written in that case.
 */
export class ReviewRefusal extends Error { constructor(readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 503, message: string) { super(message) } }

/**
 * Decides who may use the review page.
 * `admit` runs on every request, the sign-in included, before anything is read: the Host header must name this web server on loopback, the caller's address
 * must be loopback, and an Origin header must be the page's own. A request that changes something (anything but GET) must carry that Origin, which a
 * browser adds to every such request; so another site's page cannot post here, and neither can a program that forgot who it is.
 * The owner proves the shared token once, in the sign-in form. The cookie they get back holds a keyed hash (HMAC-SHA256) of the token and never the token:
 * it is checked against the token file on every request, with no stored state, so it survives a DSH restart and stops working when the token file is replaced.
 * The token is written to no log line, page, URL or error message.
 */
export class ReviewAccess {
  static readonly COOKIE = 'factory_review'
  /** The addresses a caller on this machine connects from: IPv4, IPv6, and IPv4 as an IPv6 socket reports it. */
  static readonly LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  /** What the token signs to make the cookie's value. Changing it signs every browser out. */
  private static readonly SIGNED_TEXT = 'zees-factory review page cookie v1'
  constructor(private readonly tokens: ReviewTokenSource = new SharedTokenFile()) {}

  /** Refuses with 403 a request that does not come from a page of this web server on this machine. Reads no body and no file. */
  admit(req: IncomingMessage, port: number): void {
    const host = req.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new ReviewRefusal(403, 'Loopback request required')
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://${host}`) throw new ReviewRefusal(403, 'Requests from another site are refused')
    if (origin === undefined && req.method !== 'GET') throw new ReviewRefusal(403, 'A request that changes something must come from the review page itself')
    // The Host header is the caller's word; the address of the connection is not.
    if (!ReviewAccess.LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) throw new ReviewRefusal(403, 'Loopback request required')
  }

  /** Whether the request carries the cookie that proves the shared token as the token file holds it now. With no usable token file nobody is signed in. */
  signedIn(req: IncomingMessage): boolean {
    const token = this.tokens.read()
    if (token === undefined) return false
    const sent = ReviewAccess.cookieOf(req)
    return sent !== undefined && SharedTokenFile.same(sent, ReviewAccess.proofOf(token))
  }

  /**
   * Checks the token typed into the sign-in form and returns the `Set-Cookie` header that signs the browser in.
   * Throws 503 when this side has no usable token file, and 401 when the typed token is empty or wrong.
   */
  signIn(typed: string): string {
    const token = this.tokens.read()
    if (token === undefined) throw new ReviewRefusal(503, 'The review page has no usable token file, so nobody can sign in')
    if (typed === '' || !SharedTokenFile.same(typed, token)) throw new ReviewRefusal(401, 'The token is missing or wrong')
    // Strict: the browser sends the cookie only with requests that start on this page's own site. HttpOnly: no script can read it.
    return `${ReviewAccess.COOKIE}=${ReviewAccess.proofOf(token)}; Path=${ReviewRoute.PATH}; HttpOnly; SameSite=Strict`
  }

  /** The cookie's value for a token: a keyed hash of a fixed text, which says nothing about the token to anyone who does not hold it. */
  private static proofOf(token: string): string { return createHmac('sha256', token).update(ReviewAccess.SIGNED_TEXT, 'utf8').digest('hex') }
  /** The value of the page's cookie in the request, or `undefined`. */
  private static cookieOf(req: IncomingMessage): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const at = part.indexOf('=')
      if (at > 0 && part.slice(0, at).trim() === ReviewAccess.COOKIE) return part.slice(at + 1).trim()
    }
    return undefined
  }
}

/** One job as the page shows it: its lines in time order, and the owner's newest comment on it (empty when there is none). */
export interface ReviewedJob { job_id: string; project: string; started: string; lines: JobLogLine[]; comment: string }

/**
 * Builds the HTML of the review page. Every piece of text from a record or a request is escaped before it goes into the page.
 * The comment is an always-open text area: there is no Save button. A small script saves it when the owner leaves the field or pauses typing, and
 * says "Saving…", then "Saved", in one line under the field; on a failure the text stays and the line says so. An emptied field is not sent.
 * The style names only DSH's design tokens, so served outside DSH's own client the browser's defaults show.
 */
export class ReviewPage {
  /** How long the owner must stop typing before the comment is saved, in milliseconds. */
  static readonly PAUSE_MS = 1000
  static readonly NO_JOB = 'No job recorded yet.'
  static readonly SAVING = 'Saving…'
  static readonly SAVED = 'Saved'
  static readonly NOT_SAVED = 'Not saved. Your text is kept here; it is tried again when you type.'
  /** What each kind of job log line is called on the page. */
  private static readonly HEADINGS: Record<JobLogLine['kind'], string> = { job_start: 'Job started' }
  private static readonly STYLE = [
    'body { margin: 16px; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }',
    'h1 { font-size: 13px; }',
    'ol { list-style: none; padding: 0; }',
    'li { padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l3); }',
    'time { font-family: var(--ds-font-family-code); font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
    'label, nav, #comment-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
    'a { color: var(--dsw-alias-link); }',
    'textarea, input { box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1); }',
    'textarea { min-height: 120px; }',
  ].join('\n')
  /**
   * The script that runs in the owner's browser. It talks only to this page's own comment address.
   * When the page is left (the tab closes, or a link to another job is followed) with text that was not saved yet, it sends that text once more
   * in a way the browser finishes after the page is gone (`keepalive`), so a comment typed inside the pause is not lost.
   */
  private static script(): string {
    return `(() => {
  const field = document.getElementById('comment'), status = document.getElementById('comment-status')
  if (!field || !status) return
  let saved = field.value, timer, sending = false, again = false
  const send = (text, keepalive) => fetch(${JSON.stringify(ReviewRoute.COMMENT_PATH)}, { method: 'POST', credentials: 'same-origin', keepalive,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: field.dataset.job, comment: text }) })
  const save = async () => {
    clearTimeout(timer)
    const text = field.value
    if (text.trim() === '' || text === saved) return
    if (sending) { again = true; return }
    sending = true
    status.textContent = ${JSON.stringify(ReviewPage.SAVING)}
    try {
      const answer = await send(text, false)
      if (!answer.ok) throw new Error('not saved')
      saved = text
      status.textContent = ${JSON.stringify(ReviewPage.SAVED)}
    } catch { status.textContent = ${JSON.stringify(ReviewPage.NOT_SAVED)} }
    sending = false
    if (again) { again = false; void save() }
  }
  field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, ${ReviewPage.PAUSE_MS}) })
  field.addEventListener('blur', () => { void save() })
  window.addEventListener('pagehide', () => {
    clearTimeout(timer)
    const text = field.value
    if (text.trim() === '' || text === saved) return
    saved = text
    send(text, true).catch(() => {})
  })
})()`
  }

  /** `nonce` is the one-time word the answer's content security policy allows a style and a script to carry. */
  constructor(private readonly nonce: string) {}

  /** The content security policy of an answer that carries this page: nothing loads but the one style and the one script with the nonce, and the page talks and posts only to its own web server. */
  policy(): string {
    return `default-src 'none'; style-src 'nonce-${this.nonce}'; script-src 'nonce-${this.nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
  }

  /** The sign-in form: one token field. `message` says why the last try was refused, when there was one. */
  signIn(message?: string): string {
    return this.document(`${message === undefined ? '' : `<p role="alert">${ReviewPage.escape(message)}</p>`}
<form method="post" action="${ReviewRoute.LOGIN_PATH}">
<label for="token">Token</label>
<input id="token" name="token" type="password" autocomplete="off" required autofocus>
<button type="submit">Sign in</button>
</form>`)
  }

  /** A page that says one thing, such as that no job is recorded yet. */
  notice(text: string): string { return this.document(`<p>${ReviewPage.escape(text)}</p>`) }

  /** One job: its lines in time order, the comment field, and plain links to the other jobs. */
  job(job: ReviewedJob, others: readonly ReviewedJob[]): string {
    const lines = job.lines.map(line => `<li><time datetime="${ReviewPage.escape(line.ts)}">${ReviewPage.escape(line.ts)}</time> <strong>${
      ReviewPage.escape(ReviewPage.HEADINGS[line.kind] ?? line.kind)}</strong><div>${ReviewPage.escape(line.summary)}</div></li>`).join('\n')
    const links = others.map(other => `<a href="${ReviewRoute.PATH}?job=${encodeURIComponent(other.job_id)}">${ReviewPage.escape(other.started)}</a>`).join(' ')
    return this.document(`<p>${ReviewPage.escape(job.project)}</p>
<ol>
${lines}
</ol>
<label for="comment">Your comment on this job</label>
<textarea id="comment" data-job="${ReviewPage.escape(job.job_id)}">${ReviewPage.escape(job.comment)}</textarea>
<p id="comment-status" role="status"></p>${links === '' ? '' : `\n<nav>Other jobs: ${links}</nav>`}
<script nonce="${this.nonce}">${ReviewPage.script()}</script>`)
  }

  private document(body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Review</title>
<style nonce="${this.nonce}">
${ReviewPage.STYLE}
</style>
</head>
<body>
<h1>Review</h1>
${body}
</body>
</html>
`
  }

  /** The text made safe to put between tags or inside a quoted attribute. */
  static escape(text: string): string {
    return text.replace(/[&<>"']/g, mark => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[mark] ?? mark)
  }
}

/** The route as DSH 0.2.3 takes it. `auth` is not in the route type of the older version this package builds against, which ignores it. */
interface AnonymousRoute {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  auth: 'anonymous'
}
/** Which of the page's three addresses a request is for. */
type ReviewTarget = 'page' | 'login' | 'comment'

/**
 * Serves the review page on DSH's web server, for the owner's browser on this machine only:
 * `GET /review` shows the newest job, or the job named by `?job=<id>`; without the cookie it answers 401 with the sign-in form and no record content.
 * `POST /review/login` takes the token from the form, and answers 303 to `/review` with the cookie set, 401 for a wrong or empty token, 503 with no token file.
 * `POST /review/comment` takes `{ job_id, comment }` as JSON and appends the masked comment to that job's project `reviews.jsonl`; it answers 400 for an
 * empty comment or a body that is not that object, 404 for a job no listed project holds, 413 for a body over 64 KiB, and 401 without the cookie.
 * `ReviewAccess.admit` runs first on every request (403), then the method is checked (405), then the cookie; a body is read only after all three.
 * It refuses a web server that is not bound to 127.0.0.1. The token is never logged and never put in a page.
 */
export class ReviewRoute {
  static readonly PATH = '/review'
  static readonly LOGIN_PATH = '/review/login'
  static readonly COMMENT_PATH = '/review/comment'
  static readonly MAX_BODY_BYTES = 64 * 1024
  private readonly projects: readonly string[]
  private readonly access: ReviewAccess
  private readonly writer: ReviewWriter
  constructor(projects: readonly string[], tokens: ReviewTokenSource = new SharedTokenFile(), private readonly records: RecordsSource = new FactoryRecordsModule(),
    private readonly now: () => Date = () => new Date()) {
    const relative = projects.filter(project => !isAbsolute(project))
    if (relative.length) throw new Error(`dsh-superagent-factory projects must be absolute paths: ${relative.join(', ')}`)
    this.projects = [...new Set(projects.map(project => resolve(project)))]
    this.access = new ReviewAccess(tokens)
    this.writer = new ReviewWriter(records)
  }

  /** Adds the page's three addresses to the web server and returns the function that removes them. */
  register(ctx: Context): () => void {
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('The factory /review page requires a loopback Web server')
    const targets: [string, ReviewTarget][] = [[ReviewRoute.PATH, 'page'], [ReviewRoute.LOGIN_PATH, 'login'], [ReviewRoute.COMMENT_PATH, 'comment']]
    // Anonymous to DSH: the page has its own sign-in, with the token the factory and this side already share.
    const disposers = targets.map(([path, target]) => {
      const route: AnonymousRoute = { kind: 'exact', path, auth: 'anonymous', handler: (req, res) => this.handle(req, res, ctx.webServer.port, target) }
      return ctx.webServer.register(route)
    })
    return () => { for (const dispose of disposers) dispose() }
  }

  /** Answers one HTTP request. A refusal becomes its status, as a page for the two addresses a person sees and as `{ error }` for the comment address. */
  async handle(req: IncomingMessage, res: ServerResponse, port: number, target: ReviewTarget): Promise<void> {
    const page = new ReviewPage(randomBytes(16).toString('base64'))
    const state = { bodyRead: false }
    try {
      this.access.admit(req, port)
      const method = target === 'page' ? 'GET' : 'POST'
      if (req.method !== method) throw Object.assign(new ReviewRefusal(405, `Only ${method} is allowed`), { allow: method })
      if (target === 'login') await this.login(req, res, state)
      else if (!this.access.signedIn(req)) throw new ReviewRefusal(401, 'Sign in with the shared token first')
      else if (target === 'comment') await this.comment(req, res, state)
      else await this.show(req, res, page)
    } catch (error) {
      // A caller refused before its body was read may still be sending it: the upload is read and thrown away, so the caller receives the answer and not a broken connection.
      if (!state.bodyRead) req.resume()
      // An answer that was already begun cannot be replaced by another one: the connection is cut, so the browser sees a failure and not half a page.
      if (res.headersSent) { res.destroy(); return }
      const refusal = error instanceof ReviewRefusal ? error : error instanceof RecordsRefusal ? new ReviewRefusal(error.status, error.message) : undefined
      // Any other error's own text is left out: it could quote a record or a path.
      const status = refusal?.status ?? 500, message = refusal?.message ?? 'The review page failed'
      const headers: Record<string, string> = status === 405 ? { allow: (error as { allow?: string }).allow ?? 'GET' } : {}
      if (target === 'comment') ReviewRoute.sendJson(res, status, { error: message }, headers)
      // Without the cookie the page is the sign-in form, and nothing else: no record content.
      else if (status === 401 || (target === 'login' && status === 503)) ReviewRoute.sendPage(res, status, page.signIn(target === 'login' ? message : undefined), page, headers)
      else ReviewRoute.sendPage(res, status, page.notice(message), page, headers)
    }
  }

  /** `GET /review` for a signed-in owner. */
  private async show(req: IncomingMessage, res: ServerResponse, page: ReviewPage): Promise<void> {
    const jobs = await this.jobs()
    const wanted = new URL(req.url ?? ReviewRoute.PATH, 'http://127.0.0.1').searchParams.get('job')
    if (jobs.length === 0 && wanted === null) { ReviewRoute.sendPage(res, 200, page.notice(ReviewPage.NO_JOB), page); return }
    const job = wanted === null ? jobs[0] : jobs.find(known => known.job_id === wanted)
    if (job === undefined) throw new ReviewRefusal(404, 'No listed project holds that job')
    ReviewRoute.sendPage(res, 200, page.job(job, jobs.filter(other => other !== job)), page)
  }

  /** `POST /review/login`: the token comes in the form's body, never in the address. */
  private async login(req: IncomingMessage, res: ServerResponse, state: { bodyRead: boolean }): Promise<void> {
    state.bodyRead = true
    // Trimmed: a token pasted from a terminal often brings a line break along, and no token holds a space.
    const typed = (new URLSearchParams(await ReviewRoute.readBody(req)).get('token') ?? '').trim()
    const cookie = this.access.signIn(typed)
    res.writeHead(303, { location: ReviewRoute.PATH, 'set-cookie': cookie, 'cache-control': 'no-store' })
    res.end()
  }

  /** `POST /review/comment` for a signed-in owner. */
  private async comment(req: IncomingMessage, res: ServerResponse, state: { bodyRead: boolean }): Promise<void> {
    state.bodyRead = true
    let body: unknown
    try { body = JSON.parse(await ReviewRoute.readBody(req)) } catch (error) {
      if (error instanceof ReviewRefusal) throw error
      throw new ReviewRefusal(400, 'The request body is not JSON')
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ReviewRefusal(400, 'The request body must be an object')
    const { job_id, comment } = body as { job_id?: unknown; comment?: unknown }
    if (typeof job_id !== 'string' || job_id === '') throw new ReviewRefusal(400, 'job_id must be non-empty text')
    if (typeof comment !== 'string' || comment.trim() === '') throw new ReviewRefusal(400, 'comment must be non-empty text')
    const job = (await this.jobs()).find(known => known.job_id === job_id)
    if (job === undefined) throw new ReviewRefusal(404, 'No listed project holds that job')
    await this.writer.write({ ts: this.now().toISOString(), project: job.project, job_id, comment })
    ReviewRoute.sendJson(res, 200, { saved: true })
  }

  /**
   * Every job the listed projects hold, the newest first. A job is the lines of one project's job log that share a `job_id`, in `ts` order; it started
   * at its first line's time. Its comment is the last comment line in that project's file for that `job_id`.
   */
  private async jobs(): Promise<ReviewedJob[]> {
    const reader = await this.records.reader()
    const jobs: ReviewedJob[] = []
    for (const project of this.projects) {
      const read = reader.read(project)
      const byId = new Map<string, JobLogLine[]>()
      for (const line of read.actions) byId.set(line.job_id, [...(byId.get(line.job_id) ?? []), line])
      for (const [job_id, lines] of byId) {
        // The sort keeps file order for lines of the same time. ISO-8601 times in UTC sort as text.
        lines.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)
        // The last line in the file is the one that counts, whatever its time says: a clock that was set back must not bring an older comment back.
        const newest = read.reviews.findLast(review => review.job_id === job_id)
        jobs.push({ job_id, project, started: lines[0]!.ts, lines, comment: newest?.comment ?? '' })
      }
    }
    return jobs.sort((a, b) => a.started < b.started ? 1 : a.started > b.started ? -1 : 0)
  }

  /**
   * Reads the body as text. Over the limit, it stops keeping bytes and refuses at once, while the rest of the upload is
   * still read and thrown away, so the caller receives the 413 answer and not a broken connection.
   */
  private static readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const tooLarge = () => new ReviewRefusal(413, `Request exceeds ${ReviewRoute.MAX_BODY_BYTES} bytes`)
      if (Number(req.headers['content-length']) > ReviewRoute.MAX_BODY_BYTES) { req.resume(); reject(tooLarge()); return }
      let size = 0, chunks: Buffer[] | undefined = []
      req.on('data', (chunk: Buffer | string) => {
        if (!chunks) return
        const bytes = Buffer.from(chunk); size += bytes.length
        if (size > ReviewRoute.MAX_BODY_BYTES) { chunks = undefined; reject(tooLarge()) } else chunks.push(bytes)
      })
      req.on('error', reject)
      req.on('end', () => { if (chunks) resolve(Buffer.concat(chunks).toString('utf8')) })
    })
  }
  /**
   * Sends a page. Its content security policy lets it load nothing but its own one style and one script, and talk to nothing but this web server.
   * The referrer policy is `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` with a form post, so `admit` would refuse
   * the page's own sign-in. `same-origin` still sends no referrer to any other site.
   */
  private static sendPage(res: ServerResponse, status: number, html: string, page: ReviewPage, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY', 'content-security-policy': page.policy(), ...headers })
    res.end(html)
  }
  private static sendJson(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
    res.end(JSON.stringify(body))
  }
}
