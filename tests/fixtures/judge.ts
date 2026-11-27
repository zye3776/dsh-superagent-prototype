/** A stand-in for the DSH services the factory's judge Sessions use: the Session controller, the workspace registry and the permission presets. */
import { vi } from 'vitest'
import type { HelperExit, HelperSpawner } from '../../src/factory/helpers.ts'
import type { JudgeGuard, JudgeSessions, JudgeToolCall } from '../../src/factory/judge.ts'

/** What DSH hands a guard for one tool call; the real one carries more. */
export interface FakeExecution { name: string; arguments: unknown }
type GuardFunction = (execution: FakeExecution) => string | undefined
/** Makes one call of a tool registered on the agent's own scope, as DSH does: the agent's guards first, then the tool. Gives the refusal or the tool's text. */
export type ToolCaller = (execution: FakeExecution) => Promise<string>
/**
 * What a fake judge answers to one message. `run` makes a tool call as the judge would: it passes the call through the agent's guards, as DSH does before a
 * tool runs, and returns the refusal, or `undefined` when the call may run. `call` also runs a tool registered on the agent (`docs_lookup`, `ask_helper`)
 * when its guards let it. A promise makes the judge slow.
 */
export type FakeReply = (text: string, run: GuardFunction, call: ToolCaller) => string | FakeAnswer | Promise<string | FakeAnswer>
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
  /** Every tool registered on the agent's own scope, in order (the judge's `docs_lookup` and `ask_helper`). */
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
  /** Runs one registered tool of `agent` after its guards, as DSH does. */
  const callTool = async (agent: FakeAgent, execution: FakeExecution): Promise<string> => {
    const refusal = guarded(agent, execution)
    if (refusal !== undefined) return refusal
    const tool = agent.registered.find(item => item.name === execution.name)
    if (tool === undefined) throw new Error(`no tool ${execution.name} is registered`)
    return (await tool.execute(execution.arguments, {})).text
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
          const replied = await reply(text, execution => guarded(agent, execution), execution => callTool(agent, execution))
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

/** What a fake helper process does: ends with this exit code and output, never ends by itself (`hang`), or is not installed (`missing`). */
export type FakeRun = { code: number; stdout: string } | 'hang' | 'missing'
/** One process the fake spawner started, as it was asked: the command line, the folder and the standard input; `killed` once its group was killed. */
export interface FakeStart { argv: string[]; cwd: string; input: string; killed: boolean }

/**
 * A stand-in for the helpers' process spawner. `answer` says what each started command does; every start is kept in `starts`. `kill` ends a process at once,
 * as SIGKILL to its group does.
 */
export function fakeSpawner(answer: (argv: readonly string[], cwd: string) => FakeRun) {
  const starts: FakeStart[] = []
  const spawner: HelperSpawner = {
    start(argv, options) {
      const start: FakeStart = { argv: [...argv], cwd: options.cwd, input: options.input, killed: false }
      starts.push(start)
      const run = answer(argv, options.cwd)
      let end: (exit: HelperExit) => void = () => {}
      const done = new Promise<HelperExit>(resolveExit => { end = resolveExit })
      if (run === 'missing') end({ code: null, stdout: '', overflow: false, failure: 'missing' })
      else if (run !== 'hang') setTimeout(() => { end({ code: run.code, stdout: run.stdout, overflow: false }) }, 1)
      return { done, kill: () => { start.killed = true; end({ code: null, stdout: '', overflow: false }) } }
    },
  }
  return { spawner, starts }
}

/** What `claude -p --output-format json` prints for a helper that made these tool calls and gave this answer. */
export function claudeOutput(answer: string, calls: { name: string; input: Record<string, unknown> }[] = []): string {
  return JSON.stringify([
    { type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] },
    ...calls.map(call => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: call.name, input: call.input }] } })),
    { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
    { type: 'result', subtype: 'success', is_error: false, result: answer },
  ])
}

/** What `codex exec --json` prints for a helper that gave this answer. */
export function codexOutput(answer: string): string {
  return [{ type: 'thread.started', thread_id: 't-1' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }].map(event => JSON.stringify(event)).join('\n') + '\n'
}
