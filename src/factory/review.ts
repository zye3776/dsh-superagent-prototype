/**
 * The owner's review page, served at `/review` on DSH's web server: it shows what the super agent did in each job and takes the owner's comments on a job
 * and on any step of it. Left, the listed (target) projects and the jobs of the picked one, newest first; in the middle, the job's comments together, then
 * its timeline, which also holds the requests the fixed checks answered on their own while the job ran, each comment echoed under its step; right, the
 * detail of the step picked in the timeline and, below it, the always-open comment field for that step or for the whole job.
 * A second tab, "Guideline", lists the versions of the super agent's decision guideline, newest first, and shows the text of the picked one; the factory's
 * `GuidelineReader` reads them from the factory repository.
 * The factory's `JobsReader` builds the jobs from each project's `.factory/` records and its `StepDetailReader` reads a step's detail through the step's
 * pointers (`records.ts`); this page groups and copies nothing itself. It writes only comment lines, each masked with the factory's own mask first.
 * A job's header has "Start review talk": it prepares the job's review talk folder outside every repository and opens it as a Claude Code session in
 * Orca (`talk.ts`). The talk's one tool posts a proposed guideline text back to `POST /review/proposal`, with the shared token; the page
 * shows the newest proposal per job as before → after on the Guideline tab (`diff.ts`), with "Accept as v<N>" and "Reject". Accept saves the next
 * version in the factory repository through a merge request the fork merges at once (`save.ts`); Reject, or no answer, saves nothing.
 * Only the owner's browser on this machine is answered: every request must come over loopback, name a loopback Host and carry no foreign Origin, and
 * DSH's own connection service must let it in: the page has no sign-in of its own and uses the one DSH's chat window uses (`ReviewSignIn`), so an
 * owner who opened DSH goes straight in from the "Review" link in DSH's sidebar. The one address a program posts to, the talk's proposal address,
 * takes the shared token (`token.ts`) instead, and no Origin, as `/assess` does.
 * The page loads nothing from anywhere else and brings no colours of its own: its style names DSH's design tokens only.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, isAbsolute, resolve } from 'node:path'
import {
  FactoryRecordsModule, RecordsRefusal, ReviewWriter, type AutomaticAnswer, type GuidelineRead, type GuidelineVersion, type JobLogLine, type ProjectJobs, type RecordedJob, type RecordsSource, type ReviewLine, type StepAsked, type StepDetail,
  type StepOutcome, type StepWhy, type TimelineStep, type TrendReport,
} from './records.ts'
import { TextDiff, type DiffLine } from './diff.ts'
import type { GuidelineSaved } from './save.ts'
import { GuidelineProposals, OrcaLauncher, ReviewTalks, TalkComments, TalkRefusal, TalkTexts, type GuidelineProposal, type TalkState } from './talk.ts'
import { SharedTokenFile } from './token.ts'

/** Where the page gets the shared token from, on every request. `undefined` means there is no usable token. */
export interface ReviewTokenSource { read(): string | undefined }

/**
 * Represents a refusal of one request to the review page, with the HTTP status to answer.
 * The route's steps throw it, and `ReviewRoute.handle` turns it into the answer; nothing is written in that case.
 */
export class ReviewRefusal extends Error { constructor(readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 503, message: string) { super(message) } }

/**
 * The page's own checks, which run before DSH's sign-in is asked.
 * `admit` runs on every browser request before anything is read: the Host header must name this web server on loopback, the caller's address must be
 * loopback, and an Origin header must be the page's own. A request that changes something (anything but GET) must carry that Origin, which a browser
 * adds to every such request; so another site's page cannot post here, and neither can a program that forgot who it is.
 * `admitTool` lets in the one program that posts here, the review talk's propose tool, with the shared token instead of a browser's sign-in.
 * The token is written to no log line, page, URL or error message.
 */
export class ReviewAccess {
  /** The addresses a caller on this machine connects from: IPv4, IPv6, and IPv4 as an IPv6 socket reports it. */
  static readonly LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
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

  /**
   * Admits a program on this machine that sends the shared token, as `/assess` does, and returns the token to send back: the review talk's propose tool.
   * The Host header and the caller's address must be loopback, there must be no Origin (a browser always sends one with a POST, so no web page gets in),
   * then this side's token file must be usable (503) and the caller's `x-factory-token` the same token (401). Reads no body. DSH's sign-in is not asked.
   */
  admitTool(req: IncomingMessage, port: number): string {
    const host = req.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new ReviewRefusal(403, 'Loopback request required')
    if (req.headers.origin !== undefined) throw new ReviewRefusal(403, 'Browser requests are refused at this address')
    if (!ReviewAccess.LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) throw new ReviewRefusal(403, 'Loopback request required')
    const token = this.tokens.read()
    if (token === undefined) throw new ReviewRefusal(503, 'The review page has no usable token file, so it answers nobody')
    const sent = req.headers[SharedTokenFile.HEADER]
    if (typeof sent !== 'string' || sent === '' || !SharedTokenFile.same(sent, token)) throw new ReviewRefusal(401, 'The shared token is missing or wrong')
    return token
  }
}

/** The one call of DSH's connection service the page makes: `admit` applies DSH's Host and Origin checks and checks DSH's sign-in cookie. */
export type ReviewConnection = Pick<HostConnectionHandle, 'admit'>

/**
 * The page's hold on DSH's own sign-in, the one DSH's chat window uses: the page has no sign-in step, token form or cookie of its own.
 * DSH's connection service (`ctx.connection`) checks each browser request: its Host and Origin rules, and its signed `HttpOnly`, `SameSite=Strict`
 * cookie, which DSH sets when the owner opens DSH and which the browser sends to every address of DSH's web server, `/review` included.
 * The plugin hands the service over while DSH has it (`use`); without it every browser request is refused with 503, and there is no fallback.
 */
export class ReviewSignIn {
  /** What a browser that is not signed in to DSH is told, and all it is told. */
  static readonly SIGNED_OUT = 'Open dsh first, then use its Review link.'
  /** What every browser request is told while DSH's connection service is not there. */
  static readonly NO_SERVICE = 'The review page uses dsh\'s own sign-in, and dsh\'s connection service is not running or cannot answer, so the page answers nobody.'
  private connection: ReviewConnection | undefined

  /** Starts asking `connection` and returns the function that stops it, for when DSH takes the service away. */
  use(connection: ReviewConnection): () => void {
    this.connection = connection
    return () => { if (this.connection === connection) this.connection = undefined }
  }

  /**
   * Refuses a browser request DSH does not let in: 401 when it is not signed in to DSH, 403 when DSH's Host or Origin rules refuse it, and 503 without
   * the service or when the service itself cannot answer (it throws, or answers a status it does not name). Reads no body.
   * A GET that DSH refuses as coming from another site (a link followed from elsewhere, which also carries no `SameSite=Strict` cookie) is shown the
   * signed-out line too, so an owner who opens the page from outside DSH is told to go through DSH.
   */
  check(req: IncomingMessage): void {
    const connection = this.connection
    if (connection === undefined) throw new ReviewRefusal(503, ReviewSignIn.NO_SERVICE)
    let admission: ReturnType<ReviewConnection['admit']>
    try { admission = connection.admit(req) } catch { throw new ReviewRefusal(503, ReviewSignIn.NO_SERVICE) }
    if ('peer' in admission) return
    // DSH 0.2.1 rejects with 401 or 403; a later DSH may also answer 503. Anything else is taken as "cannot answer".
    const status: number = admission.rejection
    if (status === 401 || (status === 403 && req.method === 'GET')) throw new ReviewRefusal(401, ReviewSignIn.SIGNED_OUT)
    if (status === 403) throw new ReviewRefusal(403, 'Requests from another site are refused')
    throw new ReviewRefusal(503, ReviewSignIn.NO_SERVICE)
  }
}

/**
 * What one page shows: every listed project, the picked one, and in it the picked job, or the automatic answers that fell in no job (`outside`), or neither
 * when the project has no job yet. In a job, `step` is the picked step and `detail` what the factory's `StepDetailReader` read for it.
 */
export interface ReviewView {
  projects: readonly ProjectJobs[]; project: ProjectJobs; job?: RecordedJob; outside: boolean; step?: TimelineStep; detail?: StepDetail
  /** The job's review talk, when it was started. */
  talk?: TalkState
  /** The guideline changes waiting for the owner's answer, newest first. */
  waiting?: readonly GuidelineProposal[]
}

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
  static readonly TAB_JOBS = 'Jobs'
  static readonly TAB_GUIDELINE = 'Guideline'
  static readonly NO_GUIDELINE = 'No guideline yet. The first review talk writes version 1.'
  static readonly NO_GUIDELINE_FOLDER = 'The guideline folder was not found, so the super agent is running without a guideline.'
  static readonly START_TALK = 'Start review talk'
  static readonly TALK_OPENED = 'Review talk opened in Orca. Trust the folder there and approve the zees-factory-propose server if asked.'
  static readonly FRESH_TALK = 'Start a fresh talk instead'
  static readonly CANNOT_PREPARE = 'The review talk could not be prepared: '
  /** The event the comment field's script sends on the page once a comment is saved. */
  static readonly COMMENT_SAVED = 'review-comment-saved'
  static readonly PROPOSAL_WAITING = 'A guideline change is waiting for your answer'
  static readonly NOTHING_SAVED = 'Nothing is saved until you accept.'
  static readonly REJECT = 'Reject'
  static readonly SAVING_VERSION = 'Saving: a merge request into the factory\'s main branch is opened and merged…'
  static readonly NOT_ANSWERED = 'Not answered: the review page did not answer'
  static readonly OPEN_MR = 'Open the merge request'
  static readonly NO_REPORT_YET = 'No trend report yet'
  static readonly NONE_WRITTEN = 'None was written.'
  static trendHead(version: number): string { return `Trend report for v${version}` }
  static writeTrend(version: number): string { return `Write trend report for v${version}` }
  static noTrend(version: number): string { return `No trend report yet for v${version}.` }
  static writingTrend(version: number): string { return `Writing the trend report for v${version}…` }
  static replaceTrend(day: string): string { return `Replace the report written on ${day}?` }
  static readonly REPLACE_UNDATED = 'Replace the report written before?'
  static savingWithReport(version: number): string { return `Saving: the trend report for v${version} is written first, then a merge request into the factory's main branch is opened and merged…` }
  /** How often the page asks whether a proposal is waiting, in milliseconds; it also asks when its window gets focus. */
  static readonly POLL_MS = 5000
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
  /** What each kind of job log line is called on the page, and in the review talk's files. */
  static readonly HEADINGS: Record<JobLogLine['kind'], string> = {
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
    '.tabs { display: flex; gap: 4px; margin-bottom: 8px; }',
    '.tabs a { padding: 4px 10px; border-radius: 8px; color: inherit; text-decoration: none; }',
    '.tabs a.on { background: var(--dsw-alias-bg-layer-2); }',
    'pre.guideline-text, pre.report-text { text-wrap-mode: wrap; overflow-wrap: anywhere; overflow-x: auto; font-family: var(--ds-font-family-code); font-size: 12px; }',
    '.head { display: flex; gap: 12px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--dsw-alias-border-l3); }',
    '.head .crumb { border-bottom: 0; }',
    'button.primary { padding: 4px 12px; border: 0; border-radius: 8px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-brand-primary); cursor: pointer; }',
    'button.primary:disabled { opacity: 0.45; cursor: not-allowed; }',
    'button.plain { padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font: inherit; font-size: 12px; color: inherit; background: transparent; cursor: pointer; }',
    'button.plain:disabled { opacity: 0.45; cursor: not-allowed; }',
    '.answer { display: flex; gap: 8px; align-items: center; }',
    '.head .talk { display: flex; gap: 8px; align-items: center; }',
    '.head .hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); }',
    '.notice { margin: 8px 0; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font-size: 12px; }',
    '.notice.refused { border-color: var(--dsw-alias-state-error-primary); }',
    '.notice .small { font-size: 11px; }',
    '.left a.proposal { border-left: 3px solid var(--dsw-alias-brand-primary); }',
    '.halves { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }',
    '.halves h3 { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }',
    'pre.diff { margin: 0; text-wrap-mode: wrap; overflow-wrap: anywhere; font-family: var(--ds-font-family-code); font-size: 12px; }',
    '.diff .line { display: block; min-height: 1.45em; text-decoration: none; }',
    '.diff del.line { text-decoration: line-through; background: color-mix(in oklab, var(--dsw-alias-state-error-primary) 14%, transparent); }',
    '.diff ins.line { background: color-mix(in oklab, var(--dsw-alias-state-success-primary) 14%, transparent); }',
  ].join('\n')
  /**
   * The page's one script: the comment field's saving, the review talk's button, and the question whether a proposal is waiting. Each part does nothing
   * on a page without its element. The parts are joined with a semicolon, or each would be read as a call of the one before it.
   */
  private static script(): string { return [ReviewPage.commentScript(), ReviewPage.talkScript(), ReviewPage.pollScript(), ReviewPage.answerScript(), ReviewPage.trendScript()].join(';\n') }

  /**
   * The comment field's part of the script. It talks only to this page's own comment address.
   * When the page is left (the tab closes, or a link to another job is followed) with text that was not saved yet, it sends that text once more
   * in a way the browser finishes after the page is gone (`keepalive`), so a comment typed inside the pause is not lost.
   */
  private static commentScript(): string {
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
      // Tells the review talk's button that the job now has a comment, so it can be pressed.
      document.dispatchEvent(new CustomEvent(${JSON.stringify(ReviewPage.COMMENT_SAVED)}))
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

  /**
   * The review talk button's part of the script. A click posts the job to the talk address; the answer says what to show. When a talk was opened in
   * Orca it shows the notice that says so: the page does not navigate away. When the talk was started before, it shows the notice that names it, with "Start a fresh talk instead", which posts again with
   * `fresh`. A refusal, or any other answer that is not OK, shows its reason (the answer's `error`, else the HTTP status) in the notice, marked as a
   * refusal. Every text is set as text, never as markup. The button is disabled while a start runs, and a click then, on it or on the fresh link, is
   * ignored. A job with no comment yet gets the button disabled, with the hint beside it; the first comment saved on the page enables it and removes the
   * hint, and a start that ends never re-enables a button that has to stay disabled.
   */
  private static talkScript(): string {
    return `(() => {
  const button = document.getElementById('start-talk'), notice = document.getElementById('talk-notice')
  if (!button || !notice) return
  // The button is pressable only when the job has a comment and no start runs.
  let ready = !button.disabled, busy = false
  const sync = () => { button.disabled = busy || !ready }
  document.addEventListener(${JSON.stringify(ReviewPage.COMMENT_SAVED)}, () => {
    ready = true; sync()
    const hint = document.getElementById('talk-hint'); if (hint) hint.remove()
  })
  const show = (text, fresh, refused) => {
    notice.replaceChildren()
    notice.classList.toggle('refused', refused === true)
    const words = document.createElement('span'); words.textContent = text; notice.append(words)
    if (fresh) {
      const link = document.createElement('a'); link.href = '#'; link.id = 'fresh-talk'; link.className = 'small'; link.textContent = fresh
      link.addEventListener('click', event => { event.preventDefault(); void start(true) })
      notice.append(' ', link)
    }
    notice.hidden = false
  }
  // One start at a time: a second click while one runs is ignored, so two requests never prepare the same folder at once.
  const start = async fresh => {
    if (busy) return
    busy = true; sync()
    try { await send(fresh) } finally { busy = false; sync() }
  }
  const send = async fresh => {
    let answer, body = {}
    try {
      answer = await fetch(${JSON.stringify(ReviewRoute.TALK_PATH)}, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: button.dataset.project, job_id: button.dataset.job, fresh }) })
      body = await answer.json().catch(() => ({}))
    } catch { show(${JSON.stringify(`${ReviewPage.CANNOT_PREPARE}the review page did not answer`)}, undefined, true); return }
    if (!answer.ok) {
      const reason = typeof body.error === 'string' && body.error !== '' ? body.error : ${JSON.stringify(`${ReviewPage.CANNOT_PREPARE}the review page answered HTTP `)} + answer.status
      show(reason, undefined, true); return
    }
    if (body.opened === true) show(body.notice)
    else show(body.notice, body.fresh)
  }
  button.addEventListener('click', () => { void start(false) })
  const fresh = document.getElementById('fresh-talk')
  if (fresh) fresh.addEventListener('click', event => { event.preventDefault(); void start(true) })
})()`
  }

  /**
   * The proposal notice's part of the script: every ${ReviewPage.POLL_MS / 1000} seconds, and whenever the window gets focus, it asks the page's own
   * proposal address what waits, and shows the notice with a link to the newest proposal, or hides it when none waits. It never switches the tab.
   */
  private static pollScript(): string {
    return `(() => {
  const notice = document.getElementById('proposal-notice'), link = document.getElementById('proposal-link')
  if (!notice || !link) return
  let asking = false
  const ask = async () => {
    if (asking) return
    asking = true
    try {
      const answer = await fetch(${JSON.stringify(ReviewRoute.PROPOSAL_PATH)}, { credentials: 'same-origin' })
      if (answer.ok) {
        const { waiting } = await answer.json()
        const newest = Array.isArray(waiting) ? waiting[0] : undefined
        if (newest && typeof newest.href === 'string') { link.href = newest.href; notice.hidden = false } else notice.hidden = true
      }
    } catch {}
    asking = false
  }
  setInterval(() => { void ask() }, ${ReviewPage.POLL_MS})
  window.addEventListener('focus', () => { void ask() })
})()`
  }

  /**
   * The proposal view's part of the script: "Accept as v<N>" and "Reject" post the owner's answer, for the proposal the page shows (its time), to the
   * page's answer address. An answer taken goes to the address the answer names: the new version, or the current one after a reject. A refusal shows
   * its reason above the proposal, and the merge request's link when one was opened; the proposal stays. Both buttons are disabled while an answer runs.
   */
  private static answerScript(): string {
    return `(() => {
  const accept = document.getElementById('accept-proposal'), reject = document.getElementById('reject-proposal'), notice = document.getElementById('answer-notice')
  if (!accept || !reject || !notice) return
  let busy = false
  const show = (text, mr, refused) => {
    notice.replaceChildren()
    notice.classList.toggle('refused', refused === true)
    const words = document.createElement('span'); words.textContent = text; notice.append(words)
    if (typeof mr === 'string' && mr.startsWith('https://')) {
      const link = document.createElement('a'); link.href = mr; link.rel = 'noreferrer'; link.target = '_blank'; link.textContent = ${JSON.stringify(ReviewPage.OPEN_MR)}
      notice.append(' ', link)
    }
    notice.hidden = false
  }
  const send = async answer => {
    if (busy) return
    busy = true; accept.disabled = true; reject.disabled = true
    if (answer === 'accept') show(accept.dataset.saving || ${JSON.stringify(ReviewPage.SAVING_VERSION)})
    try {
      const reply = await fetch(${JSON.stringify(ReviewRoute.ANSWER_PATH)}, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: accept.dataset.project, job_id: accept.dataset.job, ts: accept.dataset.ts, answer, base: accept.dataset.base ? Number(accept.dataset.base) : null }) })
      const body = await reply.json().catch(() => ({}))
      if (reply.ok && typeof body.href === 'string') { window.location.assign(body.href); return }
      show(typeof body.error === 'string' && body.error !== '' ? body.error : 'Not answered: the review page answered HTTP ' + reply.status, body.mr, true)
    } catch { show(${JSON.stringify(ReviewPage.NOT_ANSWERED)}, undefined, true) }
    busy = false; accept.disabled = false; reject.disabled = false
  }
  accept.addEventListener('click', () => { void send('accept') })
  reject.addEventListener('click', () => { void send('reject') })
})()`
  }

  /**
   * The trend report panel's part of the script: "Write trend report for v<N>" posts the version to the page's trends address, after the owner
   * confirms when a report is there already (it is replaced). While it runs the panel says so and the rest of the page stays usable. A report saved
   * goes to the address the answer names; a refusal shows its reason, and the merge request's link when one was opened.
   */
  private static trendScript(): string {
    return `(() => {
  const button = document.getElementById('write-trend'), notice = document.getElementById('trend-notice')
  if (!button || !notice) return
  let busy = false
  const show = (text, mr, refused) => {
    notice.replaceChildren()
    notice.classList.toggle('refused', refused === true)
    const words = document.createElement('span'); words.textContent = text; notice.append(words)
    if (typeof mr === 'string' && mr.startsWith('https://')) {
      const link = document.createElement('a'); link.href = mr; link.rel = 'noreferrer'; link.target = '_blank'; link.textContent = ${JSON.stringify(ReviewPage.OPEN_MR)}
      notice.append(' ', link)
    }
    notice.hidden = false
  }
  button.addEventListener('click', async () => {
    if (busy) return
    if (button.dataset.replace && !window.confirm(button.dataset.replace)) return
    busy = true; button.disabled = true
    show(button.dataset.writing)
    try {
      const reply = await fetch(${JSON.stringify(ReviewRoute.TRENDS_PATH)}, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: Number(button.dataset.version) }) })
      const body = await reply.json().catch(() => ({}))
      if (reply.ok && typeof body.href === 'string') { window.location.assign(body.href); return }
      show(typeof body.error === 'string' && body.error !== '' ? body.error : 'Not saved: the review page answered HTTP ' + reply.status, body.mr, true)
    } catch { show(${JSON.stringify(ReviewPage.NOT_ANSWERED)}, undefined, true) }
    busy = false; button.disabled = false
  })
})()`
  }

  /** `nonce` is the one-time word the answer's content security policy allows a style and a script to carry. */
  constructor(private readonly nonce: string) {}

  /** The content security policy of an answer that carries this page: nothing loads but the one style and the one script with the nonce, and the page talks and posts only to its own web server. */
  policy(): string {
    return `default-src 'none'; style-src 'nonce-${this.nonce}'; script-src 'nonce-${this.nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
  }

  /** The page of a browser not signed in to DSH: the one line `ReviewSignIn.SIGNED_OUT`, and nothing else, not even the title line. */
  signedOut(): string { return this.document(`<p>${ReviewPage.escape(ReviewSignIn.SIGNED_OUT)}</p>`, false, false) }

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
    let talk = ''
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
      talk = ReviewPage.talkHead(job, view.talk)
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
    const head = talk === '' ? `<div class="crumb">${crumb}</div>` : `<div class="head"><div class="crumb">${crumb}</div>${talk}`
    return this.document(`${ReviewPage.tabs('jobs', view.waiting ?? [])}
${head}
<div class="cols${panel === '' ? '' : ' with-detail'}">
<nav class="left" aria-label="Projects and jobs">
${ReviewPage.left(view)}
</nav>
<main>
${middle}
</main>
${panel}
</div>`, true)
  }

  /**
   * The rest of a job's header: the "Start review talk" button, then the header's end and, under it, the review talk notice. The notice is empty and
   * hidden until a click fills it, unless the job's talk was started before: then it names the talk, with the link that starts a fresh one.
   */
  private static talkHead(job: RecordedJob, talk: TalkState | undefined): string {
    // The same rule the talk's start applies: a job with no comment has no talk, so its button starts disabled with the reason beside it.
    const commented = new TalkComments(job).entries.length > 0
    const hint = commented ? '' : `<span id="talk-hint" class="hint">${ReviewPage.escape(TalkComments.NONE)}</span>`
    const button = `<span class="talk">${hint}<button type="button" id="start-talk" class="primary" data-project="${ReviewPage.escape(job.project)}" data-job="${
      ReviewPage.escape(job.job_id)}"${commented ? '' : ' disabled'}>${ReviewPage.START_TALK}</button></span></div>`
    if (talk === undefined) return `${button}\n<div id="talk-notice" class="notice" role="status" hidden></div>`
    return `${button}\n<div id="talk-notice" class="notice" role="status"><span>${ReviewPage.escape(ReviewPage.talkStarted(talk))}</span> <a href="#" id="fresh-talk" class="small">${ReviewPage.FRESH_TALK}</a></div>`
  }

  /** The review talk notice for a talk that was started before: its date, and its name to find its tab by in Orca. */
  static talkStarted(talk: TalkState): string {
    const day = new Date(talk.started).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    return `A review talk for this job was started on ${day}. Continue it in Orca: '${talk.title}'.`
  }

  /**
   * The Guideline tab: left, the proposals that wait for the owner's answer, newest first, above the versions, newest first, each with its date and the
   * job whose review led to it; in the middle, the picked version's text, shown as written. With no version it says there is no guideline yet, and when
   * the factory repository was not found it says so with the reader's reason.
   * With a proposal `open`, the middle shows it before → after instead: the current version on the left, the proposal on the right, both whole, removed
   * lines marked as deletions and added lines as insertions (`TextDiff`), under "Accept as v<N>", "Reject" and the line "Nothing is saved until you accept."
   * Without a proposal open, the right panel shows the picked version's trend report, and for the current version the button that writes it
   * ("Write trend report for v<N>"); an older version without one says that none was written.
   */
  guideline(read: GuidelineRead, picked: GuidelineVersion | undefined, waiting: readonly GuidelineProposal[] = [], open?: GuidelineProposal): string {
    let crumb = ReviewPage.TAB_GUIDELINE
    let left = ''
    let middle: string
    let right = ''
    if (open !== undefined) {
      crumb += ` › Proposal from ${ReviewPage.escape(TalkTexts.nameOf(open.project))} job ${open.number}`
      left = read.versions.map(each => ReviewPage.versionRow(each, read, undefined)).join('\n')
      middle = ReviewPage.proposalView(read, open)
    } else if (read.folder === null) {
      middle = `<p>${ReviewPage.escape(ReviewPage.NO_GUIDELINE_FOLDER)}</p>${read.reason === null ? '' : `\n<p class="meta">${ReviewPage.escape(read.reason)}</p>`}`
    } else if (picked === undefined) {
      middle = `<p>${ReviewPage.escape(ReviewPage.NO_GUIDELINE)}</p>`
    } else {
      crumb += ` › v${picked.version}`
      left = read.versions.map(each => ReviewPage.versionRow(each, read, picked)).join('\n')
      middle = `<h2>Guideline v${picked.version}${picked.version === read.current?.version ? ' · current' : ''}</h2>
<p class="meta">${ReviewPage.escape(ReviewPage.sourceOf(picked))}</p>
<pre class="guideline-text">${ReviewPage.escape(picked.text)}</pre>`
      right = ReviewPage.reportPanel(read, picked)
    }
    const proposals = waiting.map(each => {
      const on = open !== undefined && each.project === open.project && each.job_id === open.job_id
      return `<a class="proposal${on ? ' on' : ''}"${on ? ' aria-current="page"' : ''} href="${ReviewPage.escape(ReviewRoute.proposalAddress(each.project, each.job_id))}">\
<span>Proposal · ${ReviewPage.escape(TalkTexts.nameOf(each.project))} job ${each.number}</span><span class="l2">${ReviewPage.escape(ReviewPage.when(each.ts))}</span></a>`
    })
    return this.document(`${ReviewPage.tabs('guideline', waiting)}
<div class="crumb">${crumb}</div>
<div class="cols${right === '' ? '' : ' with-detail'}">
<nav class="left" aria-label="Guideline versions">
${proposals.length === 0 ? '' : `${proposals.join('\n')}\n`}${left}
</nav>
<main>
${middle}
</main>${right === '' ? '' : `\n<aside class="detail report" aria-label="Trend report">\n${right}\n</aside>`}
</div>`, true)
  }

  /** The trend report panel of `picked`: its report in full, or that there is none; for the current version, the button that writes it. */
  private static reportPanel(read: GuidelineRead, picked: GuidelineVersion): string {
    const report = ReviewPage.reportOf(read, picked.version)
    const current = picked.version === read.current?.version
    const button = current
      ? `<p class="answer"><button type="button" id="write-trend" class="primary" data-version="${picked.version}" \
data-writing="${ReviewPage.escape(ReviewPage.writingTrend(picked.version))}"${report === undefined ? '' : ` data-replace="${ReviewPage.escape(report.date === null ? ReviewPage.REPLACE_UNDATED : ReviewPage.replaceTrend(ReviewPage.day(report.date)))}"`}>\
${ReviewPage.escape(ReviewPage.writeTrend(picked.version))}</button></p>`
      : ''
    const pill = report === undefined ? '' : ` <span class="pill">${ReviewPage.escape(ReviewPage.writtenWhen(report))}</span>`
    // The panel's header holds its title, when the report was written, and the button (EXPERIENCE: "the header has 'Write trend report for v<N>'").
    const head = `<div class="head"><h2>${ReviewPage.escape(ReviewPage.trendHead(picked.version))}</h2>${pill}${button}</div>${current ? '\n<div id="trend-notice" class="notice" role="status" hidden></div>' : ''}`
    if (report === undefined) return `${head}\n<p class="meta">${ReviewPage.escape(current ? ReviewPage.noTrend(picked.version) : ReviewPage.NONE_WRITTEN)}</p>`
    return `${head}\n<pre class="report-text">${ReviewPage.escape(report.text.trim())}</pre>`
  }

  /** The report of version `version` in `read`, if there is one. */
  private static reportOf(read: GuidelineRead, version: number): TrendReport | undefined {
    return (read.reports ?? []).find(each => each.version === version)
  }

  /** When and why a report was written, as its pill says it: "written 24 Nov, when v3 replaced it", or "written 24 Nov, on request". */
  private static writtenWhen(report: TrendReport): string {
    const day = ReviewPage.day(report.date)
    if (report.written === 'accepted') return `written ${day}, when v${report.version + 1} replaced it`
    if (report.written === 'asked') return `written ${day}, on request`
    return `written ${day}`
  }

  /** A `YYYY-MM-DD` day as "24 Nov"; anything else as it is, and no day as "on a day not recorded". */
  private static day(date: string | null): string {
    if (date === null) return 'on a day not recorded'
    const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (found === null) return date
    return new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  /** One version in the Guideline tab's list, marked when it is the picked one, with whether it has a trend report. */
  private static versionRow(each: GuidelineVersion, read: GuidelineRead, picked: GuidelineVersion | undefined): string {
    return `<a class="version${each.version === picked?.version ? ' on' : ''}" href="${ReviewPage.escape(ReviewRoute.guidelineAddress(each.version))}">\
<span>v${each.version}${each.version === read.current?.version ? ' · current' : ''}</span><span class="l2">${ReviewPage.escape(ReviewPage.sourceOf(each))}</span>\
<span class="l2">${ReviewPage.escape(ReviewPage.reportLine(ReviewPage.reportOf(read, each.version)))}</span></a>`
  }

  /** A version row's line about its trend report: "Trend report · 5 jobs", or "No trend report yet". */
  private static reportLine(report: TrendReport | undefined): string {
    if (report === undefined) return ReviewPage.NO_REPORT_YET
    return report.jobs === null ? 'Trend report' : `Trend report · ${ReviewPage.count(report.jobs, 'job')}`
  }

  /**
   * A proposal before → after: the current version as the page reads it now on the left, the proposed text on the right, each whole and line by line.
   * A removed line is a `<del>`, an added line an `<ins>`, so the change is marked for assistive technology too, not only by its tint.
   */
  private static proposalView(read: GuidelineRead, open: GuidelineProposal): string {
    const current = read.current
    const { before, after } = new TextDiff(current?.text ?? '', open.text).sides()
    const lines = (side: readonly DiffLine[]) => side.map(line => {
      const tag = line.mark === 'removed' ? 'del' : line.mark === 'added' ? 'ins' : 'span'
      return `<${tag} class="line">${ReviewPage.escape(line.text)}</${tag}>`
    }).join('')
    const next = (current?.version ?? 0) + 1
    // With a version before it, Accept first has that version's trend report written, which can take minutes: the saving notice says so.
    const saving = current === null ? ReviewPage.SAVING_VERSION : ReviewPage.savingWithReport(current.version)
    const data = `data-project="${ReviewPage.escape(open.project)}" data-job="${ReviewPage.escape(open.job_id)}" data-ts="${ReviewPage.escape(open.ts)}" data-base="${current?.version ?? ''}" data-saving="${ReviewPage.escape(saving)}"`
    return `<h2>Proposed change · from the review talk on ${ReviewPage.escape(TalkTexts.nameOf(open.project))} job ${open.number}</h2>
<p class="meta">Proposed ${ReviewPage.escape(ReviewPage.when(open.ts))}</p>
<div id="answer-notice" class="notice" role="status" hidden></div>
<p class="answer"><button type="button" id="accept-proposal" class="primary" ${data}>${ReviewPage.accept(next)}</button> \
<button type="button" id="reject-proposal" class="plain">${ReviewPage.REJECT}</button> <span>${ReviewPage.NOTHING_SAVED}</span></p>
<div class="halves">
<section aria-label="Current version"><h3>${current === null ? ReviewPage.escape(ReviewPage.NO_GUIDELINE) : `Guideline v${current.version} · current`}</h3><pre class="diff">${lines(before)}</pre></section>
<section aria-label="Proposed version"><h3>Proposed v${next}</h3><pre class="diff">${lines(after)}</pre></section>
</div>`
  }

  /** The Accept button's label. The number is the one the page reads now; the save numbers the version from the remote's main at the time. */
  static accept(version: number): string { return `Accept as v${version}` }

  /** The day and time of a moment, on this machine's clock. */
  private static when(ts: string): string {
    return `${new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${ReviewPage.clock(ts)}`
  }

  /**
   * The two tabs, the picked one marked, and under them the proposal notice: shown with a link to the newest waiting proposal when one waits, else
   * there and hidden, so the page's script can show it when one comes.
   */
  private static tabs(on: 'jobs' | 'guideline', waiting: readonly GuidelineProposal[]): string {
    const tab = (which: 'jobs' | 'guideline', href: string, label: string) =>
      `<a class="tab${which === on ? ' on' : ''}" href="${ReviewPage.escape(href)}"${which === on ? ' aria-current="page"' : ''}>${label}</a>`
    const newest = waiting[0]
    const href = newest === undefined ? ReviewRoute.guidelineAddress() : ReviewRoute.proposalAddress(newest.project, newest.job_id)
    return `<nav class="tabs" aria-label="Tabs">${tab('jobs', ReviewRoute.PATH, ReviewPage.TAB_JOBS)}${tab('guideline', ReviewRoute.guidelineAddress(), ReviewPage.TAB_GUIDELINE)}</nav>
<div id="proposal-notice" class="notice" role="status"${newest === undefined ? ' hidden' : ''}><a id="proposal-link" href="${ReviewPage.escape(href)}">${ReviewPage.PROPOSAL_WAITING}</a></div>`
  }

  /** A version's date and the job whose review led to it, as far as its front matter says them. */
  private static sourceOf(version: GuidelineVersion): string {
    const parts = [version.date ?? 'no date']
    if (version.from_job !== null) parts.push(`from the review of job ${version.from_job}`)
    return parts.join(' · ')
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
</div>`
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

  /** The whole document. `withScript` adds the page's one script, which a plain notice does not need; `heading` the page's title line. */
  private document(body: string, withScript = false, heading = true): string {
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
${heading ? '<h1>Review</h1>\n' : ''}${body}
${withScript ? `<script nonce="${this.nonce}">${ReviewPage.script()}</script>\n` : ''}</body>
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
/** Which of the page's six addresses a request is for. */
type ReviewTarget = 'page' | 'comment' | 'talk' | 'proposal' | 'answer' | 'trends'

/** What the page's Accept runs: saves a proposal as the next guideline version (`GuidelineSaver`), one save at a time. */
/**
 * Saves the owner's answers on the Guideline tab: an accepted proposal (`accept`), and the current version's trend report asked for with the button
 * (`report`). `GuidelineSaver` (`save.ts`) is the real one.
 */
export interface GuidelineAnswerer {
  readonly busy: boolean
  accept(proposal: GuidelineProposal, base: number | null): Promise<GuidelineSaved>
  report(version: number): Promise<GuidelineSaved>
}

/**
 * Serves the review page on DSH's web server, for the owner's browser on this machine only:
 * `GET /review` shows the first listed project and its newest job; `?project=<path>` picks a project, `&job=<id>` one of its jobs (a `job` alone is looked
 * for in every project), `&step=<id>` one step of that job, whose detail fills the right panel, and `&outside=1` its answers outside a job. A project,
 * job or step that is not there is 404. A browser DSH has not signed in gets 401 and the one line `ReviewSignIn.SIGNED_OUT`, and no record content.
 * `POST /review/comment` takes `{ project, job_id, step_id?, comment }` as JSON and appends the masked comment to that job's project `reviews.jsonl`, on one
 * step when `step_id` is given, else on the whole job; a changed comment is one more line. It answers 400 for an empty comment, a body that is not that
 * object, an automatic answer's step or the job's start or stop row as `step_id`, 404 for a job no listed project holds or a step not in that job, 413 for a
 * body over 64 KiB, and 401 without DSH's sign-in. It is the page's only address that writes a record, and it writes nothing but a comment line.
 * `POST /review/talk` takes `{ project, job_id, fresh? }` from the page's button and prepares the job's review talk folder (`ReviewTalks`, outside every
 * repository and every project) and opens it in Orca: 200 with the notice, or, for a job whose talk was started before, 200 with the notice that
 * names it and opens nothing, unless `fresh` is true. 409 for a job with no comment, 503 when Orca was not found, when the talk cannot be prepared or
 * when an Orca step fails, naming the step; 404 for an unknown job.
 * `POST /review/proposal` is the review talk's tool posting `{ job_id, text }`: like `/assess` it takes no sign-in and no Origin but the shared token in
 * `x-factory-token`, and its 200 answer sends the token back. The text is kept in memory as the newest proposal of that job, which must be a listed job
 * whose talk was started: 400 for a bad body or a text equal to the current version, 404 for an unknown job, 409 for a job with no talk, 413 over 64 KiB.
 * `GET /review/proposal` tells the page, signed in to DSH, what waits, newest first, so its notice appears without a reload.
 * `POST /review/answer` takes the owner's answer to a waiting proposal, `{ project, job_id, ts, answer: 'accept' | 'reject', base }`, where `ts` is the time
 * of the proposal the page showed and `base` the version it was shown against (`null`: none), which Accept refuses to save over a newer one. Reject drops it and saves nothing. Accept saves it as the next guideline version through `saver` and then drops it;
 * when the save fails the proposal stays and the answer is 503 with `{ error, mr? }`, the error naming the step that failed. 400 for a bad body, 404 for
 * a proposal not waiting, 409 when a newer proposal replaced the one shown or a save is running, 503 without a saver: nothing is saved by default.
 * With a version before it, the saver writes that version's trend report and saves it in the same commit; when the report cannot be written, nothing is saved.
 * `POST /review/trends` takes `{ version }` from the trend report panel's button: the current version's trend report is written by a one-off model thread and
 * saved through `saver` by the same branch and merge request route, replacing one written before. 400 for a bad body, 409 when the version is not the
 * current one or a save is running, 503 without a saver or when the report or a save step fails, with `{ error, mr? }`.
 * `ReviewAccess.admit` runs first on every request (403), then DSH's sign-in (`ReviewSignIn`: 401, 403, or 503 without DSH's connection service),
 * then the method is checked (405); a body is read only after all three. The one exception is `POST /review/proposal`, where `ReviewAccess.admitTool`
 * takes the place of all three.
 * It refuses a web server that is not bound to 127.0.0.1. The token is never logged and never put in a page.
 */
export class ReviewRoute {
  static readonly PATH = '/review'
  static readonly COMMENT_PATH = '/review/comment'
  static readonly TALK_PATH = '/review/talk'
  static readonly PROPOSAL_PATH = '/review/proposal'
  static readonly ANSWER_PATH = '/review/answer'
  static readonly TRENDS_PATH = '/review/trends'
  static readonly MAX_BODY_BYTES = 64 * 1024
  private readonly projects: readonly string[]
  private readonly access: ReviewAccess
  /** DSH's own sign-in, which lets the owner's browser in; the plugin hands it DSH's connection service (`ReviewSignIn.use`). */
  readonly signIn = new ReviewSignIn()
  private readonly writer: ReviewWriter
  private readonly talks: ReviewTalks
  /** The proposals waiting for the owner's answer: in memory only, so a DSH restart forgets them, and nothing of them is saved. */
  readonly proposals = new GuidelineProposals()
  /**
   * `talks` prepares the review talks; by default under `TalkFolder.ROOT`, with the token file of `tokens` (when it is a `SharedTokenFile`) and the
   * propose server next to the records module's built file, and with no `orca` program, so the default refuses every start; the plugin passes its own.
   * `saver` saves an accepted proposal; without one, Accept is refused and nothing is saved, so no default ever runs git.
   */
  constructor(projects: readonly string[], tokens: ReviewTokenSource = new SharedTokenFile(), private readonly records: RecordsSource = new FactoryRecordsModule(),
    private readonly now: () => Date = () => new Date(), talks?: ReviewTalks, private readonly saver?: GuidelineAnswerer) {
    const relative = projects.filter(project => !isAbsolute(project))
    if (relative.length) throw new Error(`dsh-superagent-factory projects must be absolute paths: ${relative.join(', ')}`)
    this.projects = [...new Set(projects.map(project => resolve(project)))]
    this.access = new ReviewAccess(tokens)
    this.writer = new ReviewWriter(records)
    this.talks = talks ?? new ReviewTalks({ records, tokenFile: tokens instanceof SharedTokenFile ? tokens.path : SharedTokenFile.DEFAULT_PATH, words: ReviewPage, now,
      orca: new OrcaLauncher({ program: undefined }) })
  }

  /** Adds the page's six addresses to the web server and returns the function that removes them. */
  register(ctx: Context): () => void {
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('The factory /review page requires a loopback Web server')
    const targets: [string, ReviewTarget][] = [[ReviewRoute.PATH, 'page'], [ReviewRoute.COMMENT_PATH, 'comment'],
      [ReviewRoute.TALK_PATH, 'talk'], [ReviewRoute.PROPOSAL_PATH, 'proposal'], [ReviewRoute.ANSWER_PATH, 'answer'], [ReviewRoute.TRENDS_PATH, 'trends']]
    // Anonymous to DSH's web server, so the page answers a browser that is not signed in with its own line; DSH's sign-in is asked in `handle`.
    const disposers = targets.map(([path, target]) => {
      const route: AnonymousRoute = { kind: 'exact', path, auth: 'anonymous', handler: (req, res) => this.handle(req, res, ctx.webServer.port, target) }
      return ctx.webServer.register(route)
    })
    return () => { for (const dispose of disposers) dispose() }
  }

  /**
   * Answers one HTTP request. A refusal becomes its status, as a page for the address a person sees and as `{ error }` for the ones a script or a
   * program posts to.
   */
  async handle(req: IncomingMessage, res: ServerResponse, port: number, target: ReviewTarget): Promise<void> {
    const page = new ReviewPage(randomBytes(16).toString('base64'))
    const state = { bodyRead: false }
    try {
      // The talk's tool: a program with the shared token, not the owner's browser.
      if (target === 'proposal' && req.method === 'POST') { await this.propose(req, res, port, state); return }
      this.access.admit(req, port)
      this.signIn.check(req)
      const method = target === 'page' || target === 'proposal' ? 'GET' : 'POST'
      const allow = target === 'proposal' ? 'GET, POST' : method
      if (req.method !== method) throw Object.assign(new ReviewRefusal(405, `Only ${allow} is allowed`), { allow })
      if (target === 'comment') await this.comment(req, res, state)
      else if (target === 'talk') await this.talk(req, res, port, state)
      else if (target === 'answer') await this.answer(req, res, state)
      else if (target === 'trends') await this.trends(req, res, state)
      else if (target === 'proposal') ReviewRoute.sendJson(res, 200, { waiting: this.waiting() })
      else await this.show(req, res, page)
    } catch (error) {
      // A caller refused before its body was read may still be sending it: the upload is read and thrown away, so the caller receives the answer and not a broken connection.
      if (!state.bodyRead) req.resume()
      // An answer that was already begun cannot be replaced by another one: the connection is cut, so the browser sees a failure and not half a page.
      if (res.headersSent) { res.destroy(); return }
      const refusal = error instanceof ReviewRefusal ? error : error instanceof RecordsRefusal || error instanceof TalkRefusal ? new ReviewRefusal(error.status, error.message) : undefined
      // Any other error's own text is left out: it could quote a record or a path.
      const status = refusal?.status ?? 500, message = refusal?.message ?? 'The review page failed'
      const headers: Record<string, string> = status === 405 ? { allow: (error as { allow?: string }).allow ?? 'GET' } : {}
      if (target === 'comment' || target === 'talk' || target === 'proposal' || target === 'answer' || target === 'trends') ReviewRoute.sendJson(res, status, { error: message }, headers)
      // Not signed in to DSH, the page is the one line `ReviewSignIn.SIGNED_OUT`, and nothing else: no record content, no token form.
      else if (status === 401) ReviewRoute.sendPage(res, status, page.signedOut(), page, headers)
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

  /** The Guideline tab's address that opens the proposal waiting for one job. */
  static proposalAddress(project: string, jobId: string): string {
    return `${ReviewRoute.PATH}?${new URLSearchParams({ tab: 'guideline', proposal: '1', project, job: jobId })}`
  }

  /** The Guideline tab's address, on the version numbered `version` when one is given. */
  static guidelineAddress(version?: number): string {
    const query = new URLSearchParams({ tab: 'guideline' })
    if (version !== undefined) query.set('version', String(version))
    return `${ReviewRoute.PATH}?${query}`
  }

  /** `GET /review` for a signed-in owner. */
  private async show(req: IncomingMessage, res: ServerResponse, page: ReviewPage): Promise<void> {
    const query = new URL(req.url ?? ReviewRoute.PATH, 'http://127.0.0.1').searchParams
    if (query.get('tab') === 'guideline') { this.showGuideline(res, page, query, await this.records.guidelineReader()); return }
    const projects = await this.read()
    const wantedProject = query.get('project'), wantedJob = query.get('job'), wantedStep = query.get('step'), outside = query.get('outside') === '1'
    if (projects.length === 0) { ReviewRoute.sendPage(res, 200, page.notice(ReviewPage.NO_PROJECT), page); return }
    let project: ProjectJobs | undefined
    if (wantedProject !== null) project = projects.find(each => each.project === wantedProject)
    else if (wantedJob !== null) project = projects.find(each => each.jobs.some(job => job.job_id === wantedJob))
    else project = projects[0]
    if (project === undefined) throw new ReviewRefusal(404, wantedProject !== null ? 'That project is not listed' : 'No listed project holds that job')
    const job = outside ? undefined : wantedJob === null ? project.jobs[0] : project.jobs.find(each => each.job_id === wantedJob)
    if (!outside && wantedJob !== null && job === undefined) throw new ReviewRefusal(404, 'No listed project holds that job')
    const talk = job === undefined ? undefined : this.talks.stateOf(job)
    const shown = { projects, project, job, outside, waiting: this.proposals.newest(), ...(talk === undefined ? {} : { talk }) }
    if (wantedStep === null) { ReviewRoute.sendPage(res, 200, page.view(shown), page); return }
    const step = job?.steps.find(each => ReviewPage.stepIdOf(each) === wantedStep)
    if (job === undefined || step === undefined) throw new ReviewRefusal(404, 'That step is not in this job')
    const detail = (await this.records.stepReader()).read(project.project, step)
    ReviewRoute.sendPage(res, 200, page.view({ ...shown, step, detail }), page)
  }

  /** The Guideline tab: on a waiting proposal when `proposal=1` names one by `project` and `job`, else on the version asked for, else on the current one. */
  private showGuideline(res: ServerResponse, page: ReviewPage, query: URLSearchParams, reader: { read(): GuidelineRead }): void {
    const read = reader.read()
    const waiting = this.proposals.newest()
    if (query.get('proposal') === '1') {
      const open = this.proposals.of(query.get('project') ?? '', query.get('job') ?? '')
      if (open === undefined) throw new ReviewRefusal(404, 'That proposal is not waiting')
      ReviewRoute.sendPage(res, 200, page.guideline(read, undefined, waiting, open), page)
      return
    }
    const wanted = query.get('version')
    const picked = wanted === null ? read.current ?? undefined : read.versions.find(each => String(each.version) === wanted)
    if (wanted !== null && picked === undefined) throw new ReviewRefusal(404, 'That guideline version does not exist')
    ReviewRoute.sendPage(res, 200, page.guideline(read, picked, waiting), page)
  }

  /** What `GET /review/proposal` answers: each waiting proposal's job and time, and the address that opens it, newest first. No text. */
  private waiting(): { project: string; job_id: string; number: number; ts: string; href: string }[] {
    return this.proposals.newest().map(each => ({ project: each.project, job_id: each.job_id, number: each.number, ts: each.ts,
      href: ReviewRoute.proposalAddress(each.project, each.job_id) }))
  }

  /** `POST /review/talk` for a signed-in owner: prepares the job's review talk, or names the one started before. */
  private async talk(req: IncomingMessage, res: ServerResponse, port: number, state: { bodyRead: boolean }): Promise<void> {
    state.bodyRead = true
    const { project, job_id, fresh } = await ReviewRoute.objectOf(req) as { project?: unknown; job_id?: unknown; fresh?: unknown }
    if (project !== undefined && (typeof project !== 'string' || project === '')) throw new ReviewRefusal(400, 'project must be non-empty text')
    if (typeof job_id !== 'string' || job_id === '') throw new ReviewRefusal(400, 'job_id must be non-empty text')
    if (fresh !== undefined && typeof fresh !== 'boolean') throw new ReviewRefusal(400, 'fresh must be true or false')
    const job = (await this.read()).filter(each => project === undefined || each.project === project).flatMap(each => each.jobs).find(known => known.job_id === job_id)
    if (job === undefined) throw new ReviewRefusal(404, 'No listed project holds that job')
    // The address the talk's tool posts to: this web server, on loopback.
    const started = await this.talks.start(job, `http://127.0.0.1:${port}${ReviewRoute.PROPOSAL_PATH}`, fresh === true)
    if (started.opened) ReviewRoute.sendJson(res, 200, { opened: true, notice: ReviewPage.TALK_OPENED })
    else ReviewRoute.sendJson(res, 200, { opened: false, notice: ReviewPage.talkStarted(started.state), fresh: ReviewPage.FRESH_TALK })
  }

  /**
   * `POST /review/proposal` from the review talk's tool, with the shared token: keeps `{ job_id, text }` as the newest proposal of that job and sends the
   * token back. The job must be a listed job whose talk was started, so a stray caller with the token cannot put text on the page for any job.
   */
  private async propose(req: IncomingMessage, res: ServerResponse, port: number, state: { bodyRead: boolean }): Promise<void> {
    const token = this.access.admitTool(req, port)
    state.bodyRead = true
    const { job_id, text } = await ReviewRoute.objectOf(req) as { job_id?: unknown; text?: unknown }
    if (typeof job_id !== 'string' || job_id === '') throw new ReviewRefusal(400, 'job_id must be non-empty text')
    if (typeof text !== 'string' || text.trim() === '') throw new ReviewRefusal(400, 'text must be the whole new guideline text')
    const jobs = (await this.read()).flatMap(each => each.jobs).filter(known => known.job_id === job_id)
    if (jobs.length === 0) throw new ReviewRefusal(404, 'No listed project holds that job')
    const talked = jobs.filter(known => this.talks.stateOf(known) !== undefined)
    if (talked.length === 0) throw new ReviewRefusal(409, 'No review talk was started for that job')
    if (talked.length > 1) throw new ReviewRefusal(409, 'Review talks for that job id were started in more than one project')
    const job = talked[0]!
    const current = (await this.records.guidelineReader()).read().current
    // Compared as the before → after view compares: line endings made the same, so a proposal that differs only in them is not a change.
    const same = (value: string) => value.replace(/\r\n?/g, '\n').trim()
    if (current !== null && same(current.text) === same(text)) throw new ReviewRefusal(400, 'The proposal is the same as the current version')
    this.proposals.put({ project: job.project, job_id, number: job.number, text, ts: this.now().toISOString() })
    ReviewRoute.sendJson(res, 200, { kept: true, message: `The proposal for ${TalkTexts.nameOf(job.project)} job ${job.number} is on the review page. Nothing is saved until the owner accepts it.` },
      { [SharedTokenFile.HEADER]: token })
  }

  /** `POST /review/answer` for a signed-in owner: Accept or Reject of the proposal the page showed. */
  private async answer(req: IncomingMessage, res: ServerResponse, state: { bodyRead: boolean }): Promise<void> {
    state.bodyRead = true
    const { project, job_id, ts, answer, base } = await ReviewRoute.objectOf(req) as { project?: unknown; job_id?: unknown; ts?: unknown; answer?: unknown; base?: unknown }
    if (typeof project !== 'string' || project === '') throw new ReviewRefusal(400, 'project must be non-empty text')
    if (typeof job_id !== 'string' || job_id === '') throw new ReviewRefusal(400, 'job_id must be non-empty text')
    if (typeof ts !== 'string' || ts === '') throw new ReviewRefusal(400, 'ts must be the time of the proposal shown')
    if (answer !== 'accept' && answer !== 'reject') throw new ReviewRefusal(400, 'answer must be accept or reject')
    if (answer === 'accept' && base !== null && !(typeof base === 'number' && Number.isInteger(base) && base > 0)) throw new ReviewRefusal(400, 'base must be the version the proposal was shown against, or null')
    const open = this.proposals.of(project, job_id)
    if (open === undefined) throw new ReviewRefusal(404, 'That proposal is not waiting')
    if (open.ts !== ts) throw new ReviewRefusal(409, 'A newer proposal for this job replaced the one shown, so nothing was answered. Reload the page to see it.')
    if (answer === 'reject') {
      this.proposals.remove(project, job_id, ts)
      ReviewRoute.sendJson(res, 200, { answered: 'rejected', href: ReviewRoute.guidelineAddress() })
      return
    }
    if (this.saver === undefined) throw new ReviewRefusal(503, 'Not saved: saving a guideline version is not set up here')
    if (this.saver.busy) throw new ReviewRefusal(409, 'Not saved: a guideline version is being saved; try again when it is done')
    const saved = await this.saver.accept(open, base as number | null)
    if (!saved.saved) { ReviewRoute.sendJson(res, 503, { error: saved.reason, ...(saved.mr === undefined ? {} : { mr: saved.mr }) }); return }
    this.proposals.remove(project, job_id, ts)
    ReviewRoute.sendJson(res, 200, { answered: 'accepted', version: saved.version, href: ReviewRoute.guidelineAddress(saved.version), ...(saved.mr === undefined ? {} : { mr: saved.mr }) })
  }

  /** `POST /review/trends` for a signed-in owner: writes the current version's trend report and saves it, replacing one written before. */
  private async trends(req: IncomingMessage, res: ServerResponse, state: { bodyRead: boolean }): Promise<void> {
    state.bodyRead = true
    const { version } = await ReviewRoute.objectOf(req) as { version?: unknown }
    if (!(typeof version === 'number' && Number.isInteger(version) && version > 0)) throw new ReviewRefusal(400, 'version must be the number of the current guideline version')
    const current = (await this.records.guidelineReader()).read().current
    if (current?.version !== version) throw new ReviewRefusal(409, 'Not saved: only the current version\'s trend report can be written. Reload the page.')
    if (this.saver === undefined) throw new ReviewRefusal(503, 'Not saved: writing a trend report is not set up here')
    if (this.saver.busy) throw new ReviewRefusal(409, 'Not saved: a guideline version or a trend report is being saved; try again when it is done')
    const saved = await this.saver.report(version)
    if (!saved.saved) { ReviewRoute.sendJson(res, 503, { error: saved.reason, ...(saved.mr === undefined ? {} : { mr: saved.mr }) }); return }
    ReviewRoute.sendJson(res, 200, { written: version, href: ReviewRoute.guidelineAddress(version), ...(saved.mr === undefined ? {} : { mr: saved.mr }) })
  }

  /** The request body as a JSON object: 400 when it is not JSON or not an object, 413 over the limit. */
  private static async objectOf(req: IncomingMessage): Promise<Record<string, unknown>> {
    let body: unknown
    try { body = JSON.parse(await ReviewRoute.readBody(req)) } catch (error) {
      if (error instanceof ReviewRefusal) throw error
      throw new ReviewRefusal(400, 'The request body is not JSON')
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ReviewRefusal(400, 'The request body must be an object')
    return body as Record<string, unknown>
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
