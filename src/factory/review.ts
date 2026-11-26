/**
 * The owner's review page, served at `/review` on DSH's web server: it shows what the super agent did in each job and takes the owner's comments on a job
 * and on any step of it. Left, the listed (target) projects and the jobs of the picked one, newest first; in the middle, the job's comments together, then
 * its timeline, which also holds the requests the fixed checks answered on their own while the job ran, each comment echoed under its step; right, the
 * detail of the step picked in the timeline and, below it, the always-open comment field for that step or for the whole job.
 * The factory's `JobsReader` builds the jobs from each project's `.factory/` records and its `StepDetailReader` reads a step's detail through the step's
 * pointers (`records.ts`); this page groups and copies nothing itself. It writes only comment lines, each masked with the factory's own mask first.
 * Only the owner's browser on this machine is answered: every request must come over loopback, name a loopback Host and carry no foreign Origin, and
 * everything but the sign-in form needs the cookie the owner gets by typing the shared token (`token.ts`) into that form once.
 * The page loads nothing from anywhere else and brings no colours of its own: its style names DSH's design tokens only.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, isAbsolute, resolve } from 'node:path'
import {
  FactoryRecordsModule, RecordsRefusal, ReviewWriter, type AutomaticAnswer, type JobLogLine, type ProjectJobs, type RecordedJob, type RecordsSource, type ReviewLine, type StepAsked, type StepDetail,
  type StepOutcome, type StepWhy, type TimelineStep,
} from './records.ts'
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

/**
 * What one page shows: every listed project, the picked one, and in it the picked job, or the automatic answers that fell in no job (`outside`), or neither
 * when the project has no job yet. In a job, `step` is the picked step and `detail` what the factory's `StepDetailReader` read for it.
 */
export interface ReviewView { projects: readonly ProjectJobs[]; project: ProjectJobs; job?: RecordedJob; outside: boolean; step?: TimelineStep; detail?: StepDetail }

/**
 * The owner's comments on one job as the page shows them: one for the whole job and one per step, each the newest line for it in file order,
 * since a changed comment is written as a new line and the older lines stay in the file.
 */
export class JobComments {
  /** The newest comment line per step id; the whole job's is under `''`. */
  private readonly newest = new Map<string, ReviewLine>()
  constructor(job: RecordedJob) {
    for (const review of job.reviews) this.newest.set(review.step_id ?? '', review)
  }

  /** The comment on the whole job, or on the step with `stepId`; `undefined` when the owner wrote none. */
  of(stepId?: string): string | undefined { return this.newest.get(stepId ?? '')?.comment }
}

/**
 * Builds the HTML of the review page. Every piece of text from a record or a request is escaped before it goes into the page.
 * The comment is an always-open text area at the bottom of the detail panel, for the picked step or the whole job: there is no Save button. A small
 * script saves it when the owner leaves the field or pauses typing, and says "Saving…", then "Saved", in one line under the field; on a failure the
 * text stays and the line says so. An emptied field is not sent.
 * The style names only DSH's design tokens, so served outside DSH's own client the browser's defaults show.
 */
export class ReviewPage {
  /** How long the owner must stop typing before the comment is saved, in milliseconds. */
  static readonly PAUSE_MS = 1000
  static readonly NO_JOB = 'No job yet. A job appears here once the super agent has run in this project.'
  static readonly NO_PROJECT = 'No target project is listed.'
  static readonly OUTSIDE = 'Outside a job'
  static readonly NO_STOP = 'ended without a stop'
  /** How an answer of the fixed checks is named: in words, never only by colour or dimming. */
  static readonly AUTOMATIC: Record<AutomaticAnswer['answer'], string> = { allow: 'automatic yes', refuse: 'automatic no' }
  static readonly CHECKED = 'answered by the fixed checks · not reviewed'
  static readonly SAVING = 'Saving…'
  static readonly SAVED = 'Saved'
  static readonly NOT_SAVED = 'Not saved. Your text is kept here; it is tried again when you type.'
  static readonly PICK_STEP = 'Pick a step in the timeline to see its detail.'
  static readonly STEP_COMMENT = 'Your comment on this step'
  static readonly JOB_COMMENT = 'Your comment on this job'
  static readonly COMMENTS = 'Comments'
  static readonly WHOLE_JOB = 'On the whole job'
  /** The rows that stand for the whole job: picking one shows the whole job's comment, and no comment is kept on them alone. */
  static readonly WHOLE_JOB_KINDS: ReadonlySet<JobLogLine['kind']> = new Set(['job_start', 'job_stop'])
  /** What a part of a step reads when no record holds it: the label stays, never a blank or a guess. */
  static readonly NOT_RECORDED = 'Not recorded'
  /** The step detail's five parts, in the order the panel shows them. */
  static readonly PARTS = { asked: 'What was asked', why: 'Why', looked_at: 'What it looked at', next: 'What happened next', cost: 'Cost' } as const
  /** What happened after a request, in words. */
  static readonly OUTCOMES: Record<StepOutcome['outcome'], string> = {
    ran_ok: 'Ran and succeeded', ran_failed: 'Ran and failed', refused: 'Refused', owner_no: 'The owner said no',
    unknown: 'Cannot be told yet: the worker\'s transcript holds no result for it',
  }
  /** The super agent's answer, in words. */
  static readonly DECISIONS: Record<Extract<StepWhy, { by: 'super_agent' }>['decision'], string> = { approve: 'Approved', deny: 'Denied', ask_owner: 'Handed to the owner' }
  /** What each kind of job log line is called on the page. */
  private static readonly HEADINGS: Record<JobLogLine['kind'], string> = {
    job_start: 'Job started', job_stop: 'Job stopped', permission_answer: 'Permission answered', fork_answer: 'Fork answered',
    message_in: 'Message received', message_out: 'Message sent', session_start: 'Session started', session_steer: 'Session steered',
  }
  private static readonly STYLE = [
    'body { margin: 16px; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }',
    'h1 { font-size: 13px; }',
    'h2 { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); margin: 16px 0 8px; }',
    '.crumb { font-size: 12px; color: var(--dsw-alias-label-secondary); padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l3); }',
    '.cols { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 24px; align-items: start; }',
    '.cols.with-detail { grid-template-columns: 260px minmax(0, 1fr) 360px; }',
    '.detail { position: sticky; top: 16px; }',
    '@media (max-width: 1100px) { .cols, .cols.with-detail { grid-template-columns: 1fr; } }',
    '.left a { display: block; padding: 6px 8px; border-radius: 8px; color: inherit; text-decoration: none; }',
    '.left a.on { background: var(--dsw-alias-bg-layer-2); }',
    '.left span { display: block; }',
    '.l2, .meta, .who { font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
    '.pill { font-size: 11px; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-secondary); }',
    'ol, ul.comments { list-style: none; padding: 0; }',
    '.mine { margin-top: 6px; padding: 4px 8px; border-left: 3px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); font-size: 12px; }',
    '.detail .comment { margin-top: 16px; }',
    'li { padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l3); }',
    'li.auto { color: var(--dsw-alias-label-tertiary); }',
    'li a.step { display: block; color: inherit; text-decoration: none; }',
    'li.on { background: var(--dsw-alias-bg-layer-2); }',
    '.lbl { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 12px; }',
    '.val.none { color: var(--dsw-alias-label-tertiary); }',
    '.detail p { margin: 4px 0; }',
    'time, code { font-family: var(--ds-font-family-code); font-size: 11px; }',
    'time { color: var(--dsw-alias-label-tertiary); }',
    'code { overflow-wrap: anywhere; }',
    'label, #comment-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
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
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: field.dataset.project, job_id: field.dataset.job, step_id: field.dataset.step, comment: text }) })
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

  /**
   * The page of one view: a line naming where the owner is, the left panel (projects, then the picked project's jobs and, when it has any, its answers
   * outside a job), the middle panel: the job's comments and its timeline, the answers outside a job, or the text saying there is no job yet; and, for a
   * job, the right panel with the picked step's detail and the comment field. An automatic answer has no comment field; neither has the list outside a job.
   */
  view(view: ReviewView): string {
    const { project, job } = view
    const name = ReviewPage.escape(ReviewPage.nameOf(project.project))
    let crumb = `<span title="${ReviewPage.escape(project.project)}">${name}</span>`
    let middle: string
    let panel = ''
    if (view.outside) {
      crumb += ` › ${ReviewPage.OUTSIDE}`
      middle = `<h2>${ReviewPage.OUTSIDE} · ${ReviewPage.count(project.outside.length, 'automatic answer')}</h2>
<ol>
${project.outside.map(answer => ReviewPage.automaticRow(answer)).join('\n')}
</ol>`
    } else if (job === undefined) {
      middle = `<p>${ReviewPage.escape(ReviewPage.NO_JOB)}</p>`
    } else {
      crumb += ` › Job ${job.number} · ${ReviewPage.escape(ReviewPage.span(job))}${job.guideline_version === undefined ? '' : ` · <span class="pill">guideline ${ReviewPage.escape(job.guideline_version)}</span>`}`
      const comments = new JobComments(job)
      middle = `${ReviewPage.commentList(job, comments)}<h2>Timeline · ${ReviewPage.count(job.steps.length, 'step')}</h2>
<ol>
${job.steps.map(step => ReviewPage.row(step, job, view.step, comments)).join('\n')}
</ol>`
      panel = `<aside class="detail" aria-label="Step detail">
${view.step === undefined || view.detail === undefined ? `<h2>Step detail</h2>
<p>${ReviewPage.escape(ReviewPage.PICK_STEP)}</p>` : ReviewPage.detail(view.step, view.detail)}
${this.commentField(job, view.step, comments)}
</aside>`
    }
    return this.document(`<div class="crumb">${crumb}</div>
<div class="cols${panel === '' ? '' : ' with-detail'}">
<nav class="left" aria-label="Projects and jobs">
${ReviewPage.left(view)}
</nav>
<main>
${middle}
</main>
${panel}
</div>`)
  }

  /**
   * The always-open comment field at the bottom of the detail panel: the picked step's comment, or the whole job's when no step, the job's start or its
   * stop is picked. An answer of the fixed checks takes no comment, so it has no field.
   */
  private commentField(job: RecordedJob, picked: TimelineStep | undefined, comments: JobComments): string {
    if (picked?.automatic === true) return ''
    const stepId = picked === undefined || ReviewPage.WHOLE_JOB_KINDS.has(picked.line.kind) ? undefined : picked.line.step_id
    return `<div class="comment">
<label for="comment">${stepId === undefined ? ReviewPage.JOB_COMMENT : ReviewPage.STEP_COMMENT}</label>
<textarea id="comment" data-project="${ReviewPage.escape(job.project)}" data-job="${ReviewPage.escape(job.job_id)}"${
  stepId === undefined ? '' : ` data-step="${ReviewPage.escape(stepId)}"`}>${ReviewPage.escape(comments.of(stepId) ?? '')}</textarea>
<p id="comment-status" role="status"></p>
</div>
<script nonce="${this.nonce}">${ReviewPage.script()}</script>`
  }

  /**
   * The job's comments together, above its timeline: the whole job's first, then each step's in timeline order, each once with its newest text and a link
   * that picks its step. Nothing when the owner has not commented on the job yet.
   */
  private static commentList(job: RecordedJob, comments: JobComments): string {
    const entries: string[] = []
    const whole = comments.of()
    if (whole !== undefined) entries.push(ReviewPage.commentEntry(ReviewRoute.address(job.project, job.job_id), `<strong>${ReviewPage.WHOLE_JOB}</strong>`, whole))
    for (const step of job.steps) {
      if (step.automatic) continue
      const text = comments.of(step.line.step_id)
      if (text === undefined) continue
      entries.push(ReviewPage.commentEntry(ReviewRoute.address(job.project, job.job_id, false, step.line.step_id),
        `${ReviewPage.time(step.ts)} <strong>${ReviewPage.escape(ReviewPage.HEADINGS[step.line.kind] ?? step.line.kind)}</strong>`, text))
    }
    if (entries.length === 0) return ''
    return `<h2>${ReviewPage.COMMENTS} · ${entries.length}</h2>
<ul class="comments">
${entries.join('\n')}
</ul>
`
  }

  private static commentEntry(href: string, heading: string, text: string): string {
    return `<li><a class="step" href="${ReviewPage.escape(href)}">${heading}${ReviewPage.echo(text)}</a></li>`
  }

  /** The owner's comment as a read-only line under what it is about. */
  private static echo(text: string): string { return `<div class="mine">You: ${ReviewPage.escape(text)}</div>` }

  /** The left panel: every listed project, then the picked project's jobs, newest first, then its answers outside a job when there are any. */
  private static left(view: ReviewView): string {
    const { project } = view
    const projects = view.projects.map(each => {
      const on = each.project === project.project
      return `<a class="proj${on ? ' on' : ''}"${on ? ' aria-current="page"' : ''} href="${ReviewPage.escape(ReviewRoute.address(each.project))}" title="${
        ReviewPage.escape(each.project)}">${ReviewPage.escape(ReviewPage.nameOf(each.project))}</a>`
    })
    const jobs = project.jobs.map(job => {
      const on = !view.outside && view.job?.job_id === job.job_id
      const comments = new Set(job.reviews.map(review => review.step_id ?? '')).size
      return `<a class="job${on ? ' on' : ''}"${on ? ' aria-current="page"' : ''} href="${ReviewPage.escape(ReviewRoute.address(project.project, job.job_id))}"><span>Job ${
        job.number}${job.guideline_version === undefined ? '' : ` <span class="pill">${ReviewPage.escape(job.guideline_version)}</span>`}</span><span class="l2">${
        ReviewPage.escape(ReviewPage.span(job))}</span><span class="l2">${ReviewPage.count(job.steps.length, 'step')} · ${comments === 0 ? 'no comments yet' : ReviewPage.count(comments, 'comment')}</span></a>`
    })
    if (project.outside.length > 0) {
      jobs.push(`<a class="job outside${view.outside ? ' on' : ''}"${view.outside ? ' aria-current="page"' : ''} href="${
        ReviewPage.escape(ReviewRoute.address(project.project, undefined, true))}"><span>${ReviewPage.OUTSIDE}</span><span class="l2">${
        ReviewPage.count(project.outside.length, 'automatic answer')}</span></a>`)
    }
    return `<h2>Projects</h2>
${projects.join('\n')}
<h2>Jobs in ${ReviewPage.escape(ReviewPage.nameOf(project.project))}</h2>
${jobs.join('\n')}`
  }

  /** A step's id in the page's address: a job log line's `step_id`, or an automatic answer's `request_id`. */
  static stepIdOf(step: TimelineStep): string { return step.automatic ? step.answer.request_id : step.line.step_id }

  /** One row of a job's timeline: a link that picks the step, marked when it is the picked one. */
  private static row(step: TimelineStep, job: RecordedJob, picked: TimelineStep | undefined, comments: JobComments): string {
    const id = ReviewPage.stepIdOf(step)
    const on = picked !== undefined && ReviewPage.stepIdOf(picked) === id
    const link = { href: ReviewRoute.address(job.project, job.job_id, false, id), on }
    if (step.automatic) return ReviewPage.automaticRow(step.answer, link)
    const line = step.line
    const who = line.from === undefined || line.to === undefined ? '' : ` <span class="who">· ${ReviewPage.escape(line.from)} ──▶ ${ReviewPage.escape(line.to)}</span>`
    const pill = line.guideline_version === undefined ? '' : ` <span class="pill">guideline ${ReviewPage.escape(line.guideline_version)}</span>`
    const cost = [line.tokens === undefined ? '' : `${line.tokens.toLocaleString('en-US')} tokens`, line.ms === undefined ? '' : `${(line.ms / 1000).toFixed(1)} s`].filter(part => part !== '')
    // The step's own comment shows under it; the whole job's under the row that stops the job.
    const comment = line.kind === 'job_stop' ? comments.of() : comments.of(line.step_id)
    return ReviewPage.item([], '', link, `${ReviewPage.time(line.ts)} <strong>${ReviewPage.escape(ReviewPage.HEADINGS[line.kind] ?? line.kind)}</strong>${who}${pill}<div>${
      ReviewPage.escape(line.summary)}</div>${cost.length === 0 ? '' : `<div class="meta">${cost.join(' · ')}</div>`}${comment === undefined ? '' : ReviewPage.echo(comment)}`)
  }

  /** A timeline row: its content inside a link that picks the step when `link` is given, else as it is; the picked row is marked `on`. */
  private static item(classes: readonly string[], attributes: string, link: { href: string; on: boolean } | undefined, content: string): string {
    const names = link?.on === true ? [...classes, 'on'] : classes
    const open = `<li${names.length === 0 ? '' : ` class="${names.join(' ')}"`}${attributes}>`
    if (link === undefined) return `${open}${content}</li>`
    return `${open}<a class="step" href="${ReviewPage.escape(link.href)}"${link.on ? ' aria-current="true"' : ''}>${content}</a></li>`
  }

  /** A request the fixed checks answered: dimmed, named "automatic yes" or "automatic no", with what was asked in full and no comment field. */
  private static automaticRow(answer: AutomaticAnswer, link?: { href: string; on: boolean }): string {
    return ReviewPage.item(['auto'], ` data-automatic="${answer.answer}"`, link, `${ReviewPage.time(answer.ts)} <strong>${ReviewPage.escape(answer.tool_name)}</strong> <span class="pill">${
      ReviewPage.AUTOMATIC[answer.answer]}</span><div>Asked: <code>${ReviewPage.escape(ReviewPage.inputText(answer.tool_input))}</code></div>${
      answer.reason === '' ? '' : `<div class="meta">Reason given: ${ReviewPage.escape(answer.reason)}</div>`}<div class="meta">${
      ReviewPage.escape(answer.session_id)} · ${ReviewPage.CHECKED}</div>`)
  }

  /** A tool's input as the owner reads it: a command as it is, anything else as JSON. */
  private static inputText(input: unknown): string {
    const command = input !== null && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string' ? (input as { command: string }).command : undefined
    return command ?? JSON.stringify(input) ?? String(input)
  }

  /**
   * The step detail panel: what was asked, why, what it looked at, what happened next, and the cost, each under its label and shown in full.
   * A part no record holds keeps its label and reads "Not recorded".
   */
  private static detail(step: TimelineStep, detail: StepDetail): string {
    const heading = step.automatic ? ReviewPage.AUTOMATIC[step.answer.answer] : ReviewPage.HEADINGS[step.line.kind] ?? step.line.kind
    const part = (label: string, value: string | undefined) =>
      `<div class="lbl">${label}</div>${value === undefined ? `<div class="val none">${ReviewPage.NOT_RECORDED}</div>` : `<div class="val">${value}</div>`}`
    const { asked, why, looked_at: read, next, cost } = detail
    return `<h2>Step detail · ${ReviewPage.time(step.ts)} · ${ReviewPage.escape(heading)}</h2>
${part(ReviewPage.PARTS.asked, asked === null ? undefined : ReviewPage.askedHtml(asked))}
${part(ReviewPage.PARTS.why, why === null ? undefined : ReviewPage.whyHtml(why))}
${part(ReviewPage.PARTS.looked_at, read === null ? undefined : read.length === 0 ? '<p>Nothing was read.</p>'
    : read.map(each => `<p><code>${ReviewPage.escape(each.path)}</code> · ${each.used ? 'used' : 'not used'}</p>`).join(''))}
${part(ReviewPage.PARTS.next, next === null ? undefined : `<p>${ReviewPage.escape(ReviewPage.OUTCOMES[next.outcome] ?? next.outcome)}</p>${
    next.detail === '' ? '' : `<p><code>${ReviewPage.escape(next.detail)}</code></p>`}`)}
${part(ReviewPage.PARTS.cost, cost === null ? undefined : `${cost.tokens.toLocaleString('en-US')} tokens · ${cost.seconds.toFixed(1)} s`)}`
  }

  private static askedHtml(asked: StepAsked): string {
    if (asked.kind === 'message') {
      return `<p class="who">${ReviewPage.escape(asked.from)} ──▶ ${ReviewPage.escape(asked.to)}</p><p>${ReviewPage.escape(asked.text)}</p>`
    }
    if (asked.kind === 'step') return `<p>${ReviewPage.escape(asked.text)}</p>`
    return `<p>Tool: ${ReviewPage.escape(asked.tool_name)} · <code>${ReviewPage.escape(ReviewPage.inputText(asked.tool_input))}</code></p><p>${
      asked.reason === '' ? 'The worker gave no reason.' : `Reason given by the worker: ${ReviewPage.escape(asked.reason)}`}</p><p class="meta">Session ${
      ReviewPage.escape(asked.session_id)}</p>`
  }

  private static whyHtml(why: StepWhy): string {
    if (why.by === 'fixed_checks') return `<p>${ReviewPage.AUTOMATIC[why.answer]} · ${ReviewPage.CHECKED}</p>`
    return `<p><strong>${ReviewPage.DECISIONS[why.decision] ?? ReviewPage.escape(why.decision)}</strong> · risk ${ReviewPage.escape(why.risk)}</p><p>${ReviewPage.escape(why.reason)}</p>${
      why.choice === null ? '' : `<p>Chosen: ${ReviewPage.escape(why.choice)}</p>`}${why.alternative === '' ? '' : `<p>Instead: ${ReviewPage.escape(why.alternative)}</p>`}${
      why.cites === '' ? '' : `<p class="meta">Rests on: ${ReviewPage.escape(why.cites)}</p>`}`
  }

  /** The project's folder name, which is what the owner calls it; the full path is in the link's title. */
  private static nameOf(project: string): string { return basename(project) || project }

  /** When a job ran: day, start and end times, and how long it took, or that it ended without a stop. */
  private static span(job: RecordedJob): string {
    const day = new Date(job.started).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    const times = `${day}, ${ReviewPage.clock(job.started)}–${ReviewPage.clock(job.last)}`
    if (job.stopped === null) return `${times} · ${ReviewPage.NO_STOP}`
    const minutes = Math.round((Date.parse(job.stopped) - Date.parse(job.started)) / 60_000)
    const hours = Math.floor(minutes / 60)
    return `${times} · ${hours === 0 ? `${minutes} min` : `${hours} h ${String(minutes % 60).padStart(2, '0')} min`}`
  }

  /** The time of day of a record, on this machine's clock, inside a `<time>` that keeps the exact moment. */
  private static time(ts: string): string { return `<time datetime="${ReviewPage.escape(ts)}">${ReviewPage.clock(ts)}</time>` }
  private static clock(ts: string): string { return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) }
  private static count(n: number, what: string): string { return `${n} ${what}${n === 1 ? '' : 's'}` }

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
 * `GET /review` shows the first listed project and its newest job; `?project=<path>` picks a project, `&job=<id>` one of its jobs (a `job` alone is looked
 * for in every project), `&step=<id>` one step of that job, whose detail fills the right panel, and `&outside=1` its answers outside a job. A project,
 * job or step that is not there is 404. Without the cookie it answers 401 with the sign-in form and no record content.
 * `POST /review/login` takes the token from the form, and answers 303 to `/review` with the cookie set, 401 for a wrong or empty token, 503 with no token file.
 * `POST /review/comment` takes `{ project, job_id, step_id?, comment }` as JSON and appends the masked comment to that job's project `reviews.jsonl`, on one
 * step when `step_id` is given, else on the whole job; a changed comment is one more line. It answers 400 for an empty comment, a body that is not that
 * object, an automatic answer's step or the job's start or stop row as `step_id`, 404 for a job no listed project holds or a step not in that job, 413 for a
 * body over 64 KiB, and 401 without the cookie. It is the page's only address that writes, and it writes nothing but a comment line.
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

  /** The page's address for a project, one of its jobs or one step of it (`ReviewPage.stepIdOf`), or its answers outside a job. */
  static address(project: string, jobId?: string, outside = false, stepId?: string): string {
    const query = new URLSearchParams({ project })
    if (jobId !== undefined) query.set('job', jobId)
    if (stepId !== undefined) query.set('step', stepId)
    if (outside) query.set('outside', '1')
    return `${ReviewRoute.PATH}?${query}`
  }

  /** `GET /review` for a signed-in owner. */
  private async show(req: IncomingMessage, res: ServerResponse, page: ReviewPage): Promise<void> {
    const projects = await this.read()
    const query = new URL(req.url ?? ReviewRoute.PATH, 'http://127.0.0.1').searchParams
    const wantedProject = query.get('project'), wantedJob = query.get('job'), wantedStep = query.get('step'), outside = query.get('outside') === '1'
    if (projects.length === 0) { ReviewRoute.sendPage(res, 200, page.notice(ReviewPage.NO_PROJECT), page); return }
    let project: ProjectJobs | undefined
    if (wantedProject !== null) project = projects.find(each => each.project === wantedProject)
    else if (wantedJob !== null) project = projects.find(each => each.jobs.some(job => job.job_id === wantedJob))
    else project = projects[0]
    if (project === undefined) throw new ReviewRefusal(404, wantedProject !== null ? 'That project is not listed' : 'No listed project holds that job')
    const job = outside ? undefined : wantedJob === null ? project.jobs[0] : project.jobs.find(each => each.job_id === wantedJob)
    if (!outside && wantedJob !== null && job === undefined) throw new ReviewRefusal(404, 'No listed project holds that job')
    if (wantedStep === null) { ReviewRoute.sendPage(res, 200, page.view({ projects, project, job, outside }), page); return }
    const step = job?.steps.find(each => ReviewPage.stepIdOf(each) === wantedStep)
    if (job === undefined || step === undefined) throw new ReviewRefusal(404, 'That step is not in this job')
    const detail = (await this.records.stepReader()).read(project.project, step)
    ReviewRoute.sendPage(res, 200, page.view({ projects, project, job, outside, step, detail }), page)
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
    const { project, job_id, step_id, comment } = body as { project?: unknown; job_id?: unknown; step_id?: unknown; comment?: unknown }
    if (project !== undefined && (typeof project !== 'string' || project === '')) throw new ReviewRefusal(400, 'project must be non-empty text')
    if (typeof job_id !== 'string' || job_id === '') throw new ReviewRefusal(400, 'job_id must be non-empty text')
    if (step_id !== undefined && (typeof step_id !== 'string' || step_id === '')) throw new ReviewRefusal(400, 'step_id must be non-empty text')
    if (typeof comment !== 'string' || comment.trim() === '') throw new ReviewRefusal(400, 'comment must be non-empty text')
    // Two projects may hold the same `job_id` (each is its own job), so the page names the project it shows and the job is looked for there only.
    const projects = (await this.read()).filter(each => project === undefined || each.project === project)
    const job = projects.flatMap(each => each.jobs).find(known => known.job_id === job_id)
    if (job === undefined) throw new ReviewRefusal(404, 'No listed project holds that job')
    if (step_id !== undefined) {
      const step = job.steps.find(each => ReviewPage.stepIdOf(each) === step_id)
      if (step === undefined) throw new ReviewRefusal(404, 'That step is not in this job')
      if (step.automatic) throw new ReviewRefusal(400, 'An automatic answer takes no comment')
      if (ReviewPage.WHOLE_JOB_KINDS.has(step.line.kind)) throw new ReviewRefusal(400, 'Comment on the whole job without a step')
    }
    await this.writer.write({ ts: this.now().toISOString(), project: job.project, job_id, ...(step_id === undefined ? {} : { step_id }), comment })
    ReviewRoute.sendJson(res, 200, { saved: true })
  }

  /** Every listed project's jobs, as the factory's `JobsReader` builds them from the records. */
  private async read(): Promise<ProjectJobs[]> {
    return (await this.records.jobsReader()).read(this.projects)
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
