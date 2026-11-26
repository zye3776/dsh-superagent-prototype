/**
 * Session events of a judge in the shape DSH records them (DSH 0.2.x), for the token count: `assistant/message`, `assistant/attempt` and `llm/retry-started`.
 * The shape of the recorded answer is copied from a real DSH Session log; its text is made up, and it holds no ids, paths or account details.
 */
import type { FakeEvent } from './judge.ts'

/** The token usage of one model call as DSH reports it; `totalTokens` and the cache counts may be missing. */
export interface RecordedUsage { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }

/** Builds judge Session events. */
export class JudgeEvents {
  /** The usage of the recorded answer: 13148 tokens in and 12 out. */
  static readonly RECORDED_USAGE: RecordedUsage = { inputTokens: 13148, outputTokens: 12, totalTokens: 13160 }
  /** What `RECORDED_USAGE` counts as. */
  static readonly RECORDED_TOKENS = 13160
  /** The time of the first stream record, in milliseconds; made up. */
  private static readonly TIME = 1_700_000_000_000

  /** A stream as DSH packs it: the text in one run of chunks, then the usage as a raw chunk when there is one, then the finish. */
  static stream(text: string, usage?: RecordedUsage): unknown[] {
    return [
      { type: 'text-chunks', time0: JudgeEvents.TIME, index: 0, dt: [0, 40], texts: [text.slice(0, 4), text.slice(4)] },
      ...usage === undefined ? [] : [{ type: 'chunk', time: JudgeEvents.TIME + 60, chunk: { type: 'usage', usage: { ...usage } } }],
      { type: 'chunk', time: JudgeEvents.TIME + 61, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]
  }

  /**
   * An `assistant/message`: a step of the judge's turn that settled.
   * @param usage - `message` is the usage on the event itself, `stream` the usage chunk of its stream; either may be left out.
   */
  static message(turn: number, step: number, usage: { message?: RecordedUsage; stream?: RecordedUsage } = {}, text = 'A made-up answer.'): FakeEvent {
    return { type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: JudgeEvents.stream(text, usage.stream),
      ...usage.message === undefined ? {} : { usage: { ...usage.message } } } }
  }

  /** An `assistant/attempt`: a model call of a step that failed after it streamed something. It has no message and no usage of its own. */
  static attempt(turn: number, step: number, usage?: RecordedUsage): FakeEvent {
    return { type: 'assistant/attempt', data: { turn, step, stream: JudgeEvents.stream('A cut-', usage) } }
  }

  /** An `llm/retry-started`: DSH calls the model again for the same step. */
  static retryStarted(turn: number, step: number): FakeEvent {
    return { type: 'llm/retry-started', data: { retryId: 'retry-1', turn, step, retry: 1 } }
  }

  /** The recorded answer: one `assistant/message` with its usage on the event and the same usage as a chunk of its stream. */
  static recordedAnswer(text = 'A made-up answer.'): FakeEvent {
    return JudgeEvents.message(1, 1, { message: JudgeEvents.RECORDED_USAGE, stream: JudgeEvents.RECORDED_USAGE }, text)
  }
}
