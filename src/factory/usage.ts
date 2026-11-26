/**
 * Counts the tokens a judge used for one answer, from the events its DSH Session recorded while it answered.
 * It counts the way DSH's own token meter does (`usageOf` and `tokenUsageProjectionDefinition.apply` in DSH's `token-meter` package), over a slice of the
 * Session's events and not the whole Session: a judge Session lives across many requests, and a decision needs the cost of its own request only.
 */
import { lastAssistantStreamChunk, type AssistantStreamRecord, type TokenUsage } from '@deepseek-ai/dsh-llm'

/** One Session event as the tally reads it: its type and its data. Every `SessionEvent` of DSH fits. */
export interface TalliedEvent { readonly type: string; readonly data?: unknown }
/** The data of the events the tally reads: `assistant/message`, `assistant/attempt` and `llm/retry-started`. */
interface StepData { turn?: unknown; step?: unknown; usage?: TokenUsage; stream?: readonly AssistantStreamRecord[] }
/** The meter's four token buckets of one usage sample. */
type Buckets = readonly [input: number, output: number, cacheRead: number, cacheWrite: number]

/**
 * The token count of a list of Session events.
 * Only `assistant/message` and `assistant/attempt` events give a usage sample: a message gives its `usage`, else the last `usage` chunk of its stream; an attempt
 * gives the last `usage` chunk of its stream. An event without a sample adds nothing. A sample for the same turn and step as the sample before it replaces that
 * one, because DSH records a step again when it settles; after an `llm/retry-started` event for that turn and step it adds, because the retry was a new model call.
 * One sample counts its input, output, cache-read and cache-write tokens; `totalTokens` is not used, because adapters leave it out when they cannot give it.
 */
export class TokenTally {
  /** DSH's retry event. Matched by its text: the package that declares its type is not a dependency of this one. */
  static readonly RETRY_STARTED = 'llm/retry-started'
  private sum = 0
  /** The last counted sample, while a later sample of the same turn and step would replace it. */
  private last: { turn: unknown; step: unknown; buckets: Buckets } | undefined

  /** The tokens of `events`, a whole number of 0 or more. */
  static of(events: readonly TalliedEvent[]): number {
    const tally = new TokenTally()
    for (const event of events) tally.add(event)
    return tally.total
  }

  /** The tokens counted so far. */
  get total(): number { return this.sum }

  /** Counts one event, in the order the Session recorded it. */
  add(event: TalliedEvent): void {
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as StepData
    if (event.type === TokenTally.RETRY_STARTED) {
      if (this.last !== undefined && this.last.turn === data.turn && this.last.step === data.step) this.last = undefined
      return
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const usage = TokenTally.usageOf(event.type, data)
    if (usage === undefined) return
    const buckets = TokenTally.bucketsOf(usage)
    const previous = this.last !== undefined && this.last.turn === data.turn && this.last.step === data.step ? this.last.buckets : undefined
    this.sum += TokenTally.sumOf(buckets) - (previous === undefined ? 0 : TokenTally.sumOf(previous))
    this.last = { turn: data.turn, step: data.step, buckets }
  }

  /** The usage sample of one assistant event, if it has one. */
  private static usageOf(type: 'assistant/message' | 'assistant/attempt', data: StepData): TokenUsage | undefined {
    if (type === 'assistant/message' && data.usage !== undefined && data.usage !== null) return data.usage
    return Array.isArray(data.stream) ? lastAssistantStreamChunk(data.stream, 'usage')?.usage : undefined
  }

  private static bucketsOf(usage: TokenUsage): Buckets {
    return [TokenTally.whole(usage.inputTokens), TokenTally.whole(usage.outputTokens), TokenTally.whole(usage.cacheReadTokens), TokenTally.whole(usage.cacheWriteTokens)]
  }

  private static sumOf(buckets: Buckets): number { return buckets[0] + buckets[1] + buckets[2] + buckets[3] }

  /** A bucket as a whole number of 0 or more; a missing or broken value counts as 0, so the total stays one. */
  private static whole(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }
}
