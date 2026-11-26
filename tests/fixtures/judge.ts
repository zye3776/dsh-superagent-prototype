/** A stand-in for the DSH services the factory's judge Sessions use: the Session controller, the workspace registry and the permission presets. */
import { vi } from 'vitest'
import type { JudgeGuard, JudgeSessions, JudgeToolCall } from '../../src/factory/judge.ts'

/** What DSH hands a guard for one tool call; the real one carries more. */
export interface FakeExecution { name: string; arguments: unknown }
type GuardFunction = (execution: FakeExecution) => string | undefined
/**
 * What a fake judge answers to one message. `run` makes a tool call as the judge would: it passes the call through the agent's guards, as DSH does before a
 * tool runs, and returns the refusal, or `undefined` when the call may run. A promise makes the judge slow.
 */
export type FakeReply = (text: string, run: GuardFunction) => string | FakeAnswer | Promise<string | FakeAnswer>
/**
 * An answer that also says what the judge Session records for it, so a fake judge can report token usage. `events` are appended before the answer's
 * `assistant/message`, as the steps and attempts before the last one. `usage` and `stream` are put on that message, and `step` is its step in the turn (1 if left out).
 */
export interface FakeAnswer { text: string; events?: FakeEvent[]; usage?: Record<string, number>; stream?: unknown[]; step?: number }
/** A Session event as the stand-in keeps it: any type with its data. */
export interface FakeEvent { type: string; data: Record<string, unknown> }
/** A judge Session's agent as the stand-in keeps it. */
export interface FakeAgent {
  id: string
  /** Every guard registered on the agent, in order. */
  guards: GuardFunction[]
  /** Every allow list set on the agent, in order. */
  allowed: string[][]
  /** The texts sent to the agent, in order. */
  asked: string[]
  /** Every tool registered on the agent's own scope, in order (the judge's `docs_lookup`). */
  registered: FakeTool[]
  session: { id: string; snapshotEvents(): FakeEvent[] }
}

/** A tool registered on an agent, as the stand-in keeps it. */
export interface FakeTool { name: string; description: string; parameters: unknown; execute(args: unknown, execution: { signal?: AbortSignal }): Promise<{ text: string }> }
/** How the stand-in behaves. `restrictable`: when set, an allow list that names another tool throws, as DSH's `restrict` does for a tool it does not know. */
export interface FakeDshOptions { restrictable?: readonly string[] }

/**
 * Builds the stand-in. A Session exists once `create` made it, or once a test puts an agent into `agents`, as a Session DSH kept from an earlier run.
 * An agent answers each message with `reply`'s text, a moment later; `reply` may first make tool calls through the agent's guards.
 */
export function fakeDsh(reply: FakeReply = text => `answer to: ${text}`, options: FakeDshOptions = {}) {
  const agents = new Map<string, FakeAgent>()
  /** Runs `agent`'s guards on one tool call: the first refusal wins. */
  const guarded = (agent: FakeAgent, execution: FakeExecution): string | undefined => {
    for (const guard of agent.guards) {
      const refusal = guard(execution)
      if (refusal !== undefined) return refusal
    }
    return undefined
  }
  /** A new agent for Session `id`, as DSH makes one when it creates or resumes the Session. */
  const agentOf = (id: string): FakeAgent => {
    const events: FakeEvent[] = []
    let idle = Promise.resolve()
    const agent = { id, guards: [] as GuardFunction[], allowed: [] as string[][], asked: [] as string[], registered: [] as FakeTool[],
      session: { id, snapshotEvents: () => [...events] },
      ctx: { tools: {
        restrict: vi.fn((filter: { allow: string[] }) => {
          const unknown = options.restrictable === undefined ? [] : filter.allow.filter(name => !options.restrictable!.includes(name))
          if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tools ${unknown.join(', ')}`)
          agent.allowed.push(filter.allow)
          return () => {}
        }),
        register: vi.fn((tool: FakeTool) => { agent.registered.push(tool); return () => {} }),
        guard: vi.fn((guard: GuardFunction) => { agent.guards.push(guard); return () => {} }),
      } },
      followup: vi.fn((message: { content: { type: string; text: string }[] }) => {
        const text = message.content.map(block => block.text).join('')
        agent.asked.push(text)
        // The turn is the number of the question, as a real Session starts a turn for each message it is sent.
        const turn = agent.asked.length
        events.push({ type: 'user/message', data: { message } })
        idle = idle.then(async () => {
          await new Promise(resolve => { setTimeout(resolve, 1) })
          const replied = await reply(text, execution => guarded(agent, execution))
          const answer: FakeAnswer = typeof replied === 'string' ? { text: replied } : replied
          events.push(...answer.events ?? [])
          events.push({ type: 'assistant/message', data: { turn, step: answer.step ?? 1, message: { content: [{ type: 'text', text: answer.text }] },
            stream: answer.stream ?? [], ...answer.usage === undefined ? {} : { usage: answer.usage } } })
        })
      }),
      whenIdle: () => idle }
    return agent
  }
  const controller = {
    resolveAgent: vi.fn(async (id: string) => agents.has(id) ? { agent: agents.get(id)! } : { error: { code: 'session/not-found' } }),
    create: vi.fn(async (request: { sessionId: string; workspaceId: string; agentPreset: string }) => {
      agents.set(request.sessionId, agentOf(request.sessionId))
      return { sessionId: request.sessionId, agentPreset: request.agentPreset }
    }),
    rename: vi.fn(async (_request: { sessionId: string; title: string }) => ({})),
  }
  const workspaceRegistry = { create: vi.fn(async (cwd: string) => ({ id: `workspace:${cwd}` })) }
  const permissionPresets = { set: vi.fn((_session: { id: string }, _name: string) => {}) }
  const ctx = { sessionController: controller, workspaceRegistry, permissionPresets } as unknown as ConstructorParameters<typeof JudgeSessions>[0]
  /** Runs the guards of Session `id` on one tool call, as DSH does before the tool runs: the first refusal wins. */
  const run = (id: string, execution: FakeExecution): string | undefined => guarded(agents.get(id)!, execution)
  return { ctx, agents, agentOf, controller, workspaceRegistry, permissionPresets, run }
}
export type FakeDsh = ReturnType<typeof fakeDsh>

/**
 * A guard that refuses the tools `write` and `edit` and lets everything else run, and keeps every call it was asked about.
 * @param secrets - file names it also refuses, such as `.env`: any call whose arguments name one of them, as the factory's real guard refuses its secret list.
 */
export function fakeGuard(secrets: readonly string[] = []) {
  const calls: { call: JudgeToolCall; cwd: string }[] = []
  const guard: JudgeGuard = { check: (call, cwd) => {
    calls.push({ call, cwd })
    if (call.name === 'write' || call.name === 'edit') return `Refused: ${call.name}`
    const named = JSON.stringify(call.arguments ?? null)
    return secrets.some(secret => named.includes(secret)) ? 'Refused: the file is on the secret list' : undefined
  } }
  return { guard, calls, source: { guard: vi.fn(async () => guard) } }
}
