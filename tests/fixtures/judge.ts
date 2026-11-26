/** A stand-in for the DSH services the factory's judge Sessions use: the Session controller, the workspace registry and the permission presets. */
import { vi } from 'vitest'
import type { JudgeGuard, JudgeSessions, JudgeToolCall } from '../../src/factory/judge.ts'

/** What DSH hands a guard for one tool call; the real one carries more. */
export interface FakeExecution { name: string; arguments: unknown }
type GuardFunction = (execution: FakeExecution) => string | undefined
interface FakeEvent { type: string; data: { message: { content: { type: string; text: string }[] } } }
/** A judge Session's agent as the stand-in keeps it. */
export interface FakeAgent {
  id: string
  /** Every guard registered on the agent, in order. */
  guards: GuardFunction[]
  /** Every allow list set on the agent, in order. */
  allowed: string[][]
  /** The texts sent to the agent, in order. */
  asked: string[]
  session: { id: string; snapshotEvents(): FakeEvent[] }
}

/**
 * Builds the stand-in. A Session exists once `create` made it, or once a test puts an agent into `agents`, as a Session DSH kept from an earlier run.
 * An agent answers each message with `reply`'s text, a moment later.
 */
export function fakeDsh(reply: (text: string) => string = text => `answer to: ${text}`) {
  const agents = new Map<string, FakeAgent>()
  /** A new agent for Session `id`, as DSH makes one when it creates or resumes the Session. */
  const agentOf = (id: string): FakeAgent => {
    const events: FakeEvent[] = []
    let idle = Promise.resolve()
    const agent = { id, guards: [] as GuardFunction[], allowed: [] as string[][], asked: [] as string[], session: { id, snapshotEvents: () => [...events] },
      ctx: { tools: {
        restrict: vi.fn((filter: { allow: string[] }) => { agent.allowed.push(filter.allow); return () => {} }),
        guard: vi.fn((guard: GuardFunction) => { agent.guards.push(guard); return () => {} }),
      } },
      followup: vi.fn((message: { content: { type: string; text: string }[] }) => {
        const text = message.content.map(block => block.text).join('')
        agent.asked.push(text)
        events.push({ type: 'user/message', data: { message } })
        idle = idle.then(async () => {
          await new Promise(resolve => { setTimeout(resolve, 1) })
          events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply(text) }] } } })
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
  const run = (id: string, execution: FakeExecution): string | undefined => {
    for (const guard of agents.get(id)!.guards) {
      const refusal = guard(execution)
      if (refusal !== undefined) return refusal
    }
    return undefined
  }
  return { ctx, agents, agentOf, controller, workspaceRegistry, permissionPresets, run }
}
export type FakeDsh = ReturnType<typeof fakeDsh>

/** A guard that refuses the tools `write` and `edit` and lets everything else run, and keeps every call it was asked about. */
export function fakeGuard() {
  const calls: { call: JudgeToolCall; cwd: string }[] = []
  const guard: JudgeGuard = { check: (call, cwd) => { calls.push({ call, cwd }); return call.name === 'write' || call.name === 'edit' ? `Refused: ${call.name}` : undefined } }
  return { guard, calls, source: { guard: vi.fn(async () => guard) } }
}
