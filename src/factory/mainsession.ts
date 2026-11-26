/**
 * The super agent's main session, watched from DSH's own session events: which session it is, and which of its events are messages into or out of it.
 * DSH has no fixed main session: its web client opens sessions after DSH starts. So the main session is the first top-level session, not a judge, that
 * the owner writes in; the sessions opened after it, such as a review talk, are not part of the job and are not watched.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { JudgeSessions } from './judge.ts'

/** What the watcher tells the job: the main session's id once, and each message in and out (`FactoryJob` in `job.ts`). */
export interface MainSessionJob {
  noteMainSession(id: string): Promise<void>
  messageIn(from: string, text: string): Promise<void>
  messageOut(to: string, text: string): Promise<void>
}

/**
 * Watches every session event and passes the main session's messages to the job.
 * - Into it: a message the owner wrote (`source.kind` `user`) or a subagent's closing report (`subagent-settled`). The other kinds are context
 *   that DSH or a plugin adds to a turn, and are left out.
 * - Out of it: the reply of each turn, which is the turn's last assistant text, told when the turn ends. A step that only calls tools has no text.
 */
export class MainSessionWatch {
  /** Who a message into the main session is from, by the kind of its source. */
  static readonly SENDERS: Readonly<Record<string, string>> = { 'user': 'owner', 'subagent-settled': 'subagent' }
  /** Whom the main session's replies go to. */
  static readonly OWNER = 'owner'
  private main: string | undefined
  /** The newest text of the turn under way, by turn number. */
  private readonly replies = new Map<number, string>()
  constructor(private readonly job: MainSessionJob) {}

  install(ctx: Pick<Context, 'on'>): void {
    ctx.on('session/event', (session, event) => { this.observe(session, event) })
  }

  private observe(session: Session, event: SessionEvent): void {
    if (event.type === 'user/message') this.received(session, event.data)
    else if (session.id !== this.main) return
    else if (event.type === 'assistant/message') {
      const text = MainSessionWatch.textOf(event.data.message.content)
      if (text !== '') this.replies.set(event.data.turn, text)
    } else if (event.type === 'turn/end') {
      const text = this.replies.get(event.data.turn)
      this.replies.delete(event.data.turn)
      if (text !== undefined) void this.job.messageOut(MainSessionWatch.OWNER, text)
    }
  }
  private received(session: Session, message: Extract<SessionEvent, { type: 'user/message' }>['data']): void {
    const kind = (message.source as { kind?: unknown } | undefined)?.kind
    if (this.main === undefined && kind === 'user' && MainSessionWatch.candidate(session)) {
      this.main = session.id
      void this.job.noteMainSession(session.id)
    }
    const from = typeof kind === 'string' ? MainSessionWatch.SENDERS[kind] : undefined
    if (session.id === this.main && from !== undefined) void this.job.messageIn(from, MainSessionWatch.textOf(message.content))
  }
  /** Whether a session could be the main one: top-level, and not one of the factory's judges. */
  private static candidate(session: Session): boolean {
    const header = session.header as { origin?: string; delegationDepth?: number } | undefined
    return header?.origin !== 'subagent' && header?.delegationDepth === undefined && !session.id.startsWith(JudgeSessions.PREFIX)
  }
  /** The text blocks of a message, joined by line breaks; tool calls and reasoning are left out. */
  private static textOf(content: readonly unknown[]): string {
    return content.flatMap(block => {
      const { type, text } = block as { type?: unknown; text?: unknown }
      return type === 'text' && typeof text === 'string' ? [text] : []
    }).join('\n').trim()
  }
}
