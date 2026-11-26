/** The token count of a judge's answer: `TokenTally` on Session events in the shape DSH records them (`tests/fixtures/judge-events.ts`). */
import { describe, expect, it } from 'vitest'
import { TokenTally } from '../src/factory/usage.ts'
import { JudgeEvents } from './fixtures/judge-events.ts'

describe('TokenTally', () => {
  it('counts the recorded answer once, though its usage is on the event and in its stream', () => {
    expect(TokenTally.of([JudgeEvents.recordedAnswer()])).toBe(13160)
    expect(JudgeEvents.RECORDED_TOKENS).toBe(13160)
  })

  it('reads the usage from the stream when the message has none of its own', () => {
    expect(TokenTally.of([JudgeEvents.message(1, 1, { stream: { inputTokens: 100, outputTokens: 20 } })])).toBe(120)
  })

  it('takes the usage on the message before the one in its stream', () => {
    expect(TokenTally.of([JudgeEvents.message(1, 1, { message: { inputTokens: 100, outputTokens: 20 }, stream: { inputTokens: 1, outputTokens: 1 } })])).toBe(120)
  })

  it('takes the last usage chunk of a stream that holds several', () => {
    const event = JudgeEvents.message(1, 1)
    event.data.stream = [...JudgeEvents.stream('one', { inputTokens: 5, outputTokens: 1 }), ...JudgeEvents.stream('two', { inputTokens: 100, outputTokens: 20 })]
    expect(TokenTally.of([event])).toBe(120)
  })

  it('adds the cache-read and cache-write tokens, and does not use totalTokens', () => {
    expect(TokenTally.of([JudgeEvents.message(1, 1, { message: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 40 } })])).toBe(355)
    expect(TokenTally.of([JudgeEvents.message(1, 1, { message: { inputTokens: 10, outputTokens: 5, totalTokens: 999 } })])).toBe(15)
  })

  it('adds the steps of one turn: a tool-call step and the answer step', () => {
    expect(TokenTally.of([
      JudgeEvents.message(1, 1, { message: { inputTokens: 500, outputTokens: 20 } }),
      { type: 'tool/call', data: { turn: 1, step: 1 } },
      { type: 'tool/result', data: { turn: 1, step: 1 } },
      JudgeEvents.message(1, 2, { message: { inputTokens: 700, outputTokens: 30 } }),
    ])).toBe(1250)
  })

  it('lets the message of a step replace a failed attempt of the same step', () => {
    expect(TokenTally.of([JudgeEvents.attempt(1, 1, { inputTokens: 400, outputTokens: 0 }), JudgeEvents.message(1, 1, { message: { inputTokens: 450, outputTokens: 15 } })])).toBe(465)
  })

  it('adds the message to the attempt when a retry of that step started between them', () => {
    expect(TokenTally.of([JudgeEvents.attempt(1, 1, { inputTokens: 400, outputTokens: 0 }), JudgeEvents.retryStarted(1, 1),
      JudgeEvents.message(1, 1, { message: { inputTokens: 450, outputTokens: 15 } })])).toBe(865)
  })

  it('still replaces when the retry that started was of another step', () => {
    expect(TokenTally.of([JudgeEvents.attempt(1, 2, { inputTokens: 400, outputTokens: 0 }), JudgeEvents.retryStarted(1, 1),
      JudgeEvents.message(1, 2, { message: { inputTokens: 450, outputTokens: 15 } })])).toBe(465)
  })

  it('counts 0 when no usage was reported, and an event without a sample does not end a replacement', () => {
    expect(TokenTally.of([JudgeEvents.message(1, 1)])).toBe(0)
    expect(TokenTally.of([JudgeEvents.attempt(1, 1)])).toBe(0)
    expect(TokenTally.of([])).toBe(0)
    expect(TokenTally.of([JudgeEvents.attempt(1, 1, { inputTokens: 400, outputTokens: 0 }), JudgeEvents.attempt(1, 1),
      JudgeEvents.message(1, 1, { message: { inputTokens: 450, outputTokens: 15 } })])).toBe(465)
  })

  it('reads no other event, also one that carries a usage', () => {
    expect(TokenTally.of([{ type: 'user/message', data: { turn: 1, step: 1, usage: { inputTokens: 9, outputTokens: 9 } } }, { type: 'session/start' },
      { type: 'tool/result', data: null }])).toBe(0)
  })

  it('gives a whole number of 0 or more for a usage with broken counts', () => {
    const broken = { inputTokens: 10.7, outputTokens: -5, cacheReadTokens: Number.NaN } as never
    expect(TokenTally.of([JudgeEvents.message(1, 1, { message: broken })])).toBe(10)
  })
})
