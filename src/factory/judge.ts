/**
 * The judge sessions of the factory's `/assess` route: one long-lived DSH Session for each worker session of a project, which can read the project and change nothing.
 * A judge Session is created with the bundle's `dsh-superagent-judge` preset, set to DSH's `read-only` permission preset, limited to the tools `read`, `grep`, `glob` and
 * `bash`, and every tool call it makes is checked by the factory's own guard. This package does not copy that guard: it loads the factory's built file
 * `lib/dist/judgeGuard.js` from the absolute path in the plugin's `guardModule` setting. Without a working guard no judge Session is opened: the request is refused with 503.
 * DSH's `read-only` mode blocks file writes only; the guard adds the refusals for network, signals, other programs and secret files.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { freezeMessage, MessageId, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AssessRefusal } from './decisions.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-superagent-factory': { kind: 'dsh-superagent-factory' } & ContextFormed
  }
}

/** One tool call as the guard sees it: the tool's name and its arguments. */
export interface JudgeToolCall { name: string; arguments: unknown }
/** Checks one tool call of a judge: a text refuses the call and says why, `undefined` lets it run. `cwd` is the project's folder. */
export interface JudgeGuard { check(call: JudgeToolCall, cwd: string): string | undefined }
/** Gives the guard every judge Session is checked with. It rejects with `AssessRefusal(503)` when there is none. */
export interface GuardSource { guard(): Promise<JudgeGuard> }
/** Opens the judge Session of one worker session. The route knows only this much of `JudgeSessions`. */
export interface JudgeOpener { open(project: string, sessionId: string): Promise<unknown> }
/** What the factory's built guard file exports: `JudgeToolGuard.forHome()` gives the guard of this machine's owner. */
interface GuardModuleExports { JudgeToolGuard?: { forHome?: unknown } }

/**
 * The factory's judge guard, loaded from its built file `lib/dist/judgeGuard.js`.
 * The file is imported when the first judge Session is opened, not at start, so the plugin starts without it, and one guard is built and kept.
 * Any failure is a 503: no path given, a path that is not absolute, a file that does not load, a file without `JudgeToolGuard.forHome`, or a guard that cannot be built.
 * Only a missing file is tried again on the next request: Node keeps a file once it has loaded it or once it threw while loading. So a guard file that was fixed or
 * rebuilt takes effect only after DSH restarts. The refusal says which step failed and never repeats the error's own text.
 */
export class FactoryGuardModule implements GuardSource {
  private loaded?: JudgeGuard
  constructor(readonly path?: string) {}
  async guard(): Promise<JudgeGuard> {
    if (this.loaded) return this.loaded
    if (this.path === undefined || this.path === '') throw new AssessRefusal(503, 'No guardModule is configured, so no judge session is opened and no decision is written')
    if (!isAbsolute(this.path)) throw new AssessRefusal(503, 'The configured guardModule is not an absolute path, so no judge session is opened')
    let module: GuardModuleExports
    try { module = await import(pathToFileURL(this.path).href) as GuardModuleExports }
    catch { throw new AssessRefusal(503, 'The configured guardModule could not be loaded, so no judge session is opened') }
    const forHome = module.JudgeToolGuard?.forHome
    if (typeof forHome !== 'function') throw new AssessRefusal(503, 'The configured guardModule does not export JudgeToolGuard.forHome, so no judge session is opened')
    let guard: unknown
    try { guard = forHome.call(module.JudgeToolGuard) }
    catch { throw new AssessRefusal(503, 'The configured guardModule could not build a guard, so no judge session is opened') }
    if (guard === null || typeof guard !== 'object' || typeof (guard as JudgeGuard).check !== 'function') {
      throw new AssessRefusal(503, 'The configured guardModule gave no guard, so no judge session is opened')
    }
    this.loaded = guard as JudgeGuard
    return this.loaded
  }
}

/**
 * Remembers the files one judge read with the `read` tool, each with its modification time, change time, file number (inode) and size when it was read.
 * `changed()` lists the files that differ now or are gone, so the judge re-reads only those. It asks for a file's facts and never opens a file.
 */
export class ReadLedger {
  /** Each file's full path and its stamp; the stamp of a file that is not there is `undefined`. */
  private readonly stamps = new Map<string, string | undefined>()
  private static stampOf(path: string): string | undefined {
    try { const facts = statSync(path); return `${facts.mtimeMs}:${facts.ctimeMs}:${facts.ino}:${facts.size}` } catch { return undefined }
  }
  /** How many files are remembered. */
  get size(): number { return this.stamps.size }
  /** Remembers `path`, a full path, as it is now. */
  record(path: string): void { this.stamps.set(path, ReadLedger.stampOf(path)) }
  /** The remembered files that changed or vanished since they were last recorded or listed, in the order they were first read. Each is listed once for each change. */
  changed(): string[] {
    const found: string[] = []
    for (const [path, stamp] of this.stamps) {
      const now = ReadLedger.stampOf(path)
      if (now === stamp) continue
      found.push(path)
      this.stamps.set(path, now)
    }
    return found
  }
}

/**
 * One judge: the DSH Session that reads a project for one worker session of the factory.
 * `brief()` is the text that goes before a question: on first contact it tells the judge to read the code, the dev setup and the planning documents; after that
 * it lists only the files the judge read with the `read` tool that have changed since. `ask()` sends a message and returns the judge's answer.
 * The route does not call `ask` yet: this version opens the Session and asks it nothing, so it spends no model tokens.
 */
export class JudgeSession {
  /** The files this judge was allowed to read. */
  readonly ledger = new ReadLedger()
  private briefed = false
  /** Questions are asked one after the other, so one answer cannot be taken for another's. */
  private asking: Promise<unknown> = Promise.resolve()
  /**
   * @param id - the DSH Session id.
   * @param project - the project's absolute path, which is the Session's working folder.
   * @param sessionId - the factory's `session_id` of the worker session this judge belongs to.
   * @param agent - the Session's live agent; `JudgeSessions.open` replaces it when DSH resumed the Session with a new one.
   */
  constructor(readonly id: string, readonly project: string, readonly sessionId: string, public agent: Agent) {}

  /** The text to put before a question. The first call gives the orientation; each later call lists the files read with the `read` tool that have changed since, or says none has. */
  brief(): string {
    if (!this.briefed) {
      this.briefed = true
      // The orientation's own reads are still to come, so nothing counts as changed yet.
      this.ledger.changed()
      return [
        `You are the factory's judge for one worker session in the project ${this.project}. You can read the project and change nothing.`,
        'Before you answer for the first time, read enough to know the project: its code layout, its dev setup (README, package and build files, AGENTS.md or CLAUDE.md)',
        'and its planning documents (PRD, architecture, epics and tickets).',
        'You have the tools read, grep, glob and bash. bash runs read-only commands only, written as plain commands; secret files are refused.',
        'When a call is refused, the refusal says why and what to do instead.',
      ].join('\n')
    }
    const changed = this.ledger.changed()
    if (!changed.length) return 'No file you read with the read tool has changed since. Do not re-read the project.'
    return ['These files you read with the read tool have changed since. Re-read only these:', ...changed.map(path => `- ${path}`)].join('\n')
  }

  /**
   * Sends `text` to the judge as its next message and returns the text of its last answer once its turn has ended; empty when it gave none.
   * @param signal - gives up waiting when aborted; the judge's turn is not stopped.
   */
  ask(text: string, signal: AbortSignal): Promise<string> {
    const answer = this.asking.then(() => this.exchange(text, signal))
    // A question that failed or was given up may have left the judge's turn running: the next one waits for that turn to end, so it cannot take its answer.
    this.asking = answer.catch(() => this.agent.whenIdle().catch(() => {}))
    return answer
  }

  private async exchange(text: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const agent = this.agent
    const before = agent.session.snapshotEvents().length
    agent.followup(freezeMessage({ id: MessageId(`dsh-superagent-factory:${randomUUID()}`), role: 'user' as const, content: [{ type: 'text' as const, text }],
      source: { kind: 'dsh-superagent-factory' as const, form: 'relay' as const } }))
    const aborted = Promise.withResolvers<never>()
    const abort = () => { aborted.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try { await Promise.race([agent.whenIdle(), aborted.promise]) } finally { signal.removeEventListener('abort', abort) }
    const last = agent.session.snapshotEvents().slice(before).filter(event => event.type === 'assistant/message').at(-1)
    return last?.type === 'assistant/message' ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
  }
}

/**
 * Keeps one judge Session for each (project, `session_id`) pair, and opens it for every request.
 * The DSH Session id is worked out from the pair, so a Session that DSH kept from an earlier run is found again and not made twice. Two requests that arrive together
 * share one open, and a failed open is forgotten, so the next request tries again.
 * Every open, also of a known judge, sets DSH's `read-only` permission preset and the title, and puts the tool limit and the guard on the Session's agent once: DSH may
 * have resumed the Session with a new agent since the last request. Any failure is a 503 and nothing is written.
 */
export class JudgeSessions implements JudgeOpener {
  /** The agent preset a judge Session is created with (`dsh-superagent-judge-preset` in cordis.patch.yml). */
  static readonly PRESET = 'dsh-superagent-judge'
  /** DSH's permission preset that blocks every file write. */
  static readonly PERMISSIONS = 'read-only'
  /** The only tools a judge may use. */
  static readonly TOOLS: readonly string[] = ['read', 'grep', 'glob', 'bash']
  static readonly TITLE = 'Factory judge'
  /** The opens under way, by the id worked out from the pair. */
  private readonly opening = new Map<string, Promise<JudgeSession>>()
  /** The judges opened so far, by the same id. */
  private readonly judges = new Map<string, JudgeSession>()
  /** The agents that already carry the tool limit and the guard. */
  private readonly guarded = new WeakSet<Agent>()
  constructor(private readonly ctx: Pick<Context, 'sessionController' | 'workspaceRegistry' | 'permissionPresets'>, private readonly guards: GuardSource) {}

  /** The DSH Session id of one pair: the same on every run, and it says nothing of the project's path. */
  static idOf(project: string, sessionId: string): string {
    return `factory-judge-${createHash('sha256').update(`${project}\n${sessionId}`).digest('hex').slice(0, 16)}`
  }
  /** How many judges were opened so far. */
  get count(): number { return this.judges.size }

  /** The judge of `sessionId` in `project`, made on first use. It rejects with `AssessRefusal(503)` when the guard or the Session cannot be had. */
  open(project: string, sessionId: string): Promise<JudgeSession> {
    const key = JudgeSessions.idOf(project, sessionId)
    const underWay = this.opening.get(key)
    if (underWay) return underWay
    const opened = this.attach(key, project, sessionId).finally(() => { if (this.opening.get(key) === opened) this.opening.delete(key) })
    this.opening.set(key, opened)
    return opened
  }

  private async attach(key: string, project: string, sessionId: string): Promise<JudgeSession> {
    // First, so that without a guard no Session is made at all.
    const guard = await this.guards.guard()
    const known = this.judges.get(key)
    try {
      const ctx = this.ctx
      // DSH may give a Session another id than the one asked for; the judge keeps the one DSH uses.
      let id = known?.id ?? key
      let result = await ctx.sessionController.resolveAgent(id as SessionId)
      if ('error' in result && result.error.code === 'session/not-found') {
        const workspace = await ctx.workspaceRegistry.create(project)
        const created = await ctx.sessionController.create({ sessionId: key as SessionId, workspaceId: workspace.id, agentPreset: JudgeSessions.PRESET })
        id = created?.sessionId ?? key
        result = await ctx.sessionController.resolveAgent(id as SessionId)
      }
      if ('error' in result) throw result.error
      const agent = result.agent
      const judge = known?.id === id ? known : new JudgeSession(id, project, sessionId, agent)
      judge.agent = agent
      ctx.permissionPresets.set(agent.session, JudgeSessions.PERMISSIONS)
      if (!this.guarded.has(agent)) {
        agent.ctx.tools.restrict({ allow: [...JudgeSessions.TOOLS] })
        // The judge is looked up when a call is checked: after a failed open, a later open may have made another judge for this agent.
        agent.ctx.tools.guard(execution => JudgeSessions.refusal(guard, this.judges.get(key) ?? judge, execution))
        this.guarded.add(agent)
      }
      await ctx.sessionController.rename({ sessionId: id as SessionId, title: JudgeSessions.TITLE })
      this.judges.set(key, judge)
      return judge
    } catch (error) {
      // A judge that was already known stays, with its ledger: the failure may pass.
      if (!known) this.judges.delete(key)
      if (error instanceof AssessRefusal) throw error
      // The error's own text is not repeated: it could quote a path.
      throw new AssessRefusal(503, 'The judge session could not be opened, so no decision is written')
    }
  }

  /** The guard's answer for one tool call of `judge`, with the project as the folder. An allowed `read` is noted in the judge's ledger. A guard that throws refuses the call. */
  private static refusal(guard: JudgeGuard, judge: JudgeSession, execution: { name: string; arguments: unknown }): string | undefined {
    let refusal: string | undefined
    try { refusal = guard.check({ name: execution.name, arguments: execution.arguments }, judge.project) }
    catch { return 'Refused: the judge guard failed on this call, so it does not run. Send a plain read, grep, glob or read-only bash call.' }
    if (refusal !== undefined && typeof refusal !== 'string') return 'Refused: the judge guard gave no usable answer for this call, so it does not run.'
    if (refusal === undefined && execution.name === 'read') {
      const path = (execution.arguments as { file_path?: unknown } | null)?.file_path
      if (typeof path === 'string') judge.ledger.record(JudgeSessions.absolute(path, judge.project))
    }
    return refusal
  }

  private static absolute(path: string, project: string): string {
    if (path === '~') return homedir()
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(project, path)
  }
}
