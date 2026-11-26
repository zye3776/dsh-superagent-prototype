/**
 * The owner's decision guideline in the starting instructions of every model thread the plugin runs: the main session, its subagents and each
 * judge thread. When DSH creates an agent, `GuidelineSection` reads the guideline's current version and adds it to that agent's system prompt as one
 * DSH section. DSH waits for `agent/created` listeners before an agent's first request, so the section is in place before the model is first asked.
 * A session keeps the version it was first given for the rest of the run, also when DSH gives it a new agent; a session created after a newer
 * version was accepted gets the newer one. The guideline only guides: the never-decide list and the fixed checks run in the factory before any
 * model is asked, and never read it.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { RecordsRefusal, type GuidelineVersion, type RecordsSource } from './records.ts'

/** The part of a DSH agent the section needs: its session's id and its own system prompt. */
export interface GuidelineAgent { readonly id: string; readonly ctx: { readonly systemPrompt: { section(section: PromptSection): () => void } } }

/**
 * Adds the current decision guideline to each agent's system prompt, and remembers which version each session runs under.
 * It never throws and never rejects: without a version (none yet, the factory repository not found, no job log file) an agent gets no section,
 * and the reason is told to `warn` once.
 */
export class GuidelineSection {
  /** The DSH section's name. */
  static readonly NAME = 'factory-guideline'
  /** Where the section sits: after DSH's plan and team policies (500, 600), before the tool sections (800 and up). */
  static readonly ORDER = 650
  private readonly records: Pick<RecordsSource, 'guidelineReader'>
  private readonly warn: (message: string) => void
  /** The version each session was first given, by session id. */
  private readonly pinned = new Map<string, Promise<GuidelineVersion | null>>()
  /** The agents that already carry the section: DSH refuses a second section of the same name. */
  private readonly attached = new WeakSet<GuidelineAgent>()
  private readonly warned = new Set<string>()
  constructor(records: Pick<RecordsSource, 'guidelineReader'>, warn: (message: string) => void) {
    this.records = records
    this.warn = warn
  }

  /** Gives every agent DSH creates from now on its section. */
  install(ctx: Pick<Context, 'on'>): void {
    ctx.on('agent/created', async ({ agent }) => { await this.attach(agent); return undefined })
  }
  /** Adds the section to `agent`, with the version its session was first given, or the current one for a new session. */
  async attach(agent: GuidelineAgent): Promise<void> {
    const version = await this.versionOf(agent.id, true)
    if (version === null || this.attached.has(agent)) return
    try {
      agent.ctx.systemPrompt.section({ name: GuidelineSection.NAME, order: GuidelineSection.ORDER, interpolate: false, text: GuidelineSection.textOf(version) })
      this.attached.add(agent)
    } catch {
      this.once('A session started without the decision guideline: its system prompt refused the section')
    }
  }
  /**
   * The version the session `sessionId` runs under; for a session not seen yet, or without an id, the current version, read now.
   * `pin` keeps that version for the session from then on.
   */
  versionOf(sessionId?: string, pin = false): Promise<GuidelineVersion | null> {
    const known = sessionId === undefined ? undefined : this.pinned.get(sessionId)
    if (known) return known
    const current = this.current()
    if (pin && sessionId !== undefined) this.pinned.set(sessionId, current)
    return current
  }
  /** The version for `job_start`, as `v<N>`: the one the session `sessionId` runs under, else the current one; `undefined` when there is none. */
  async jobVersion(sessionId?: string): Promise<string | undefined> {
    const version = await this.versionOf(sessionId)
    return version === null ? undefined : `v${version.version}`
  }
  /** The section's text: what it is, then the version's text as written. */
  static textOf(version: GuidelineVersion): string {
    return [
      `# The owner's decision guideline, version ${version.version}${version.date === null ? '' : ` (${version.date})`}`,
      'Decide as this guideline says. It never overrides the never-decide list or the fixed checks: they answer before you are asked.',
      '',
      version.text,
    ].join('\n')
  }

  private async current(): Promise<GuidelineVersion | null> {
    try {
      const read = (await this.records.guidelineReader()).read()
      if (read.current === null) this.once(`Sessions start without a decision guideline: ${read.reason ?? 'there is no version'}`)
      return read.current
    } catch (error) {
      // A refusal's message is this package's own words. Any other error's text is left out: it could quote a path.
      this.once(`Sessions start without a decision guideline: ${error instanceof RecordsRefusal ? error.message : 'it could not be read'}`)
      return null
    }
  }
  private once(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    // A log that fails must not stop the session it reports on.
    try { this.warn(message) } catch { /* nothing more can be said */ }
  }
}
