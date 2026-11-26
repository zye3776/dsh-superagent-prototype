/** The before → after comparison of the review page's proposal view: each side's lines, marked kept, removed or added. */
import { describe, expect, it } from 'vitest'
import { TextDiff, type DiffLine } from '../src/factory/diff.ts'

const kept = (text: string): DiffLine => ({ mark: 'kept', text })
const removed = (text: string): DiffLine => ({ mark: 'removed', text })
const added = (text: string): DiffLine => ({ mark: 'added', text })

describe('TextDiff', () => {
  it('marks every line kept when the texts are the same, a last line break included or not', () => {
    expect(new TextDiff('a\nb\n', 'a\nb').sides()).toEqual({ before: [kept('a'), kept('b')], after: [kept('a'), kept('b')] })
  })

  it('marks one changed line as removed before and added after, and keeps the lines around it', () => {
    expect(new TextDiff('# Guideline\nKeep it small.\nAsk first.\n', '# Guideline\nKeep to the minimum feature.\nAsk first.\n').sides()).toEqual({
      before: [kept('# Guideline'), removed('Keep it small.'), kept('Ask first.')],
      after: [kept('# Guideline'), added('Keep to the minimum feature.'), kept('Ask first.')],
    })
  })

  it('shows an added line only after, and a removed line only before', () => {
    expect(new TextDiff('a\nc', 'a\nb\nc').sides()).toEqual({ before: [kept('a'), kept('c')], after: [kept('a'), added('b'), kept('c')] })
    expect(new TextDiff('a\nb\nc', 'a\nc').sides()).toEqual({ before: [kept('a'), removed('b'), kept('c')], after: [kept('a'), kept('c')] })
  })

  it('finds the lines both keep in the middle of several changes', () => {
    const { before, after } = new TextDiff('x\na\nb\ny\nc', 'a\nz\nb\nc\nw').sides()
    expect(before).toEqual([removed('x'), kept('a'), kept('b'), removed('y'), kept('c')])
    expect(after).toEqual([kept('a'), added('z'), kept('b'), kept('c'), added('w')])
    // Each side holds its own text, whole and in order.
    expect(before.map(line => line.text).join('\n')).toBe('x\na\nb\ny\nc')
    expect(after.map(line => line.text).join('\n')).toBe('a\nz\nb\nc\nw')
  })

  it('compares against an empty text as wholly added, as for a first version', () => {
    expect(new TextDiff('', 'v1 line\n').sides()).toEqual({ before: [], after: [added('v1 line')] })
  })

  it('shows texts too large for the table as wholly removed and added, still each in full, even where they share lines', () => {
    // Every other line is the same on both sides (but not the first or the last, which would be set aside as a shared start or end), so only the size
    // guard makes the shared lines come out removed and added instead of kept.
    const many = (prefix: string) => Array.from({ length: 2101 }, (_, n) => n % 2 === 1 ? `same ${n}` : `${prefix}${n}`).join('\n')
    const { before, after } = new TextDiff(many('a'), many('b')).sides()
    expect((2101 + 1) * (2101 + 1)).toBeGreaterThan(TextDiff.MAX_CELLS)
    expect([before.length, after.length]).toEqual([2101, 2101])
    expect([before.every(line => line.mark === 'removed'), after.every(line => line.mark === 'added')]).toEqual([true, true])
    expect([before[1], after[1]]).toEqual([removed('same 1'), added('same 1')])
  })
})
