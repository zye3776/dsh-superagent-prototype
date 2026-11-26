/** Which session is the main one, and which of its events become a message line: session events sent through a real cordis Context to a stand-in job. */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { JudgeSessions } from '../src/factory/judge.ts'
import { MainSessionWatch, type MainSessionJob } from '../src/factory/mainsession.ts'

/** A job that only notes what it is told, in order. */
class NotedJob implements MainSessionJob {
  readonly calls: string[] = []
  async noteMainSession(id: string): Promise<void> { this.calls.push(`main ${id}`) }
  async messageIn(from: string, text: string): Promise<void> { this.calls.push(`in ${from}: ${text}`) }
  async messageOut(to: string, text: string): Promise<void> { this.calls.push(`out ${to}: ${text}`) }
}
type Header = { origin?: string; delegationDepth?: number }
const session = (id: string, header: Header = {}) => ({ id, header })
const text = (words: string) => ({ type: 'text', text: words })
const user = (words: string, kind = 'user') =>
  ({ type: 'user/message', data: { id: `m-${words}`, role: 'user', content: [text(words)], source: { kind } } }) as unknown as SessionEvent
const assistant = (turn: number, content: unknown[]) =>
  ({ type: 'assistant/message', data: { turn, step: 0, message: { role: 'assistant', content } } }) as unknown as SessionEvent
const turnEnd = (turn: number) => ({ type: 'turn/end', data: { turn, reason: 'done' } }) as unknown as SessionEvent

function watched() {
  const ctx = new Context()
  const job = new NotedJob()
  new MainSessionWatch(job).install(ctx)
  // Only `id` and `header` of a Session are read.
  const emit = (from: ReturnType<typeof session>, event: SessionEvent) => { ctx.emit('session/event', from as unknown as Session, event) }
  return { job, emit }
}

it('takes the first session the owner writes in as the main one, and records its messages in and its reply out', () => {
  const { job, emit } = watched()
  const main = session('main-1')
  emit(main, user('Build story 3.'))
  emit(main, assistant(1, [text('Starting.'), { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]))
  emit(main, assistant(1, [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }]))
  emit(main, assistant(1, [{ type: 'reasoning', text: 'thinking' }, text('Story 3 is built.')]))
  emit(main, turnEnd(1))
  expect(job.calls).toEqual(['main main-1', 'in owner: Build story 3.', 'out owner: Story 3 is built.'])
})

it('notes the main session once and keeps it: another top-level session the owner writes in later is not recorded', () => {
  const { job, emit } = watched()
  emit(session('main-1'), user('First.'))
  emit(session('second'), user('Elsewhere.'))
  emit(session('second'), assistant(1, [text('Reply elsewhere.')]))
  emit(session('second'), turnEnd(1))
  emit(session('main-1'), user('Again.'))
  expect(job.calls).toEqual(['main main-1', 'in owner: First.', 'in owner: Again.'])
})

it('never takes a judge or a subagent as the main session', () => {
  const { job, emit } = watched()
  emit(session(`${JudgeSessions.PREFIX}0123456789abcdef`), user('Judge this.'))
  emit(session('child', { origin: 'subagent' }), user('Do part of it.'))
  emit(session('deep', { delegationDepth: 1 }), user('Do a smaller part.'))
  expect(job.calls).toEqual([])
  expect(JudgeSessions.idOf('/p', 's').startsWith(JudgeSessions.PREFIX)).toBe(true)
})

it('records a subagent\'s report to the main session, and skips context the host injects', () => {
  const { job, emit } = watched()
  const main = session('main-1')
  emit(main, user('Start.'))
  emit(main, user('The subagent finished.', 'subagent-settled'))
  emit(main, user('It is 9:00.', 'time-context'))
  emit(main, user('Hello from a plugin.', 'dsh-superagent-factory'))
  expect(job.calls).toEqual(['main main-1', 'in owner: Start.', 'in subagent: The subagent finished.'])
})

it('does not take a session as the main one from an injected message, only from the owner', () => {
  const { job, emit } = watched()
  emit(session('main-1'), user('It is 9:00.', 'time-context'))
  emit(session('main-1'), user('The subagent finished.', 'subagent-settled'))
  expect(job.calls).toEqual([])
})

it('writes no reply for a turn without text, and one reply per turn', () => {
  const { job, emit } = watched()
  const main = session('main-1')
  emit(main, user('Go.'))
  emit(main, assistant(1, [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]))
  emit(main, assistant(1, [text('   ')]))
  emit(main, turnEnd(1))
  emit(main, assistant(2, [text('First line.'), text('Second line.')]))
  emit(main, turnEnd(2))
  expect(job.calls).toEqual(['main main-1', 'in owner: Go.', 'out owner: First line.\nSecond line.'])
})
