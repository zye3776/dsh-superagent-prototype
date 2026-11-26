/**
 * The before → after comparison of the review page's proposal view: two whole texts in, each side's lines out, every line marked as kept, removed
 * (only on the before side) or added (only on the after side).
 * It compares by line, with the longest common run of lines (the classic longest-common-subsequence table), after setting aside the lines both texts
 * share at their start and end. A pair of texts too large for the table is shown as wholly removed and wholly added, which is still correct, only coarse.
 * It has no dependency and knows nothing of HTML: the page marks each line itself.
 */

/** What happened to one line: it is on both sides, only before, or only after. */
export type DiffMark = 'kept' | 'removed' | 'added'
/** One line of one side. */
export interface DiffLine { mark: DiffMark; text: string }
/** Both sides in reading order: the before side holds kept and removed lines, the after side kept and added lines. */
export interface DiffSides { before: DiffLine[]; after: DiffLine[] }

/** Compares two whole texts by line: `new TextDiff(before, after).sides()` gives each side's lines, marked. */
export class TextDiff {
  /** The largest table the comparison builds (lines before × lines after, after the shared start and end are set aside). */
  static readonly MAX_CELLS = 4_000_000
  private readonly before: readonly string[]
  private readonly after: readonly string[]
  constructor(before: string, after: string) {
    this.before = TextDiff.linesOf(before)
    this.after = TextDiff.linesOf(after)
  }

  /** Both sides, line by line, each line marked. */
  sides(): DiffSides {
    const a = this.before, b = this.after
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let endA = a.length, endB = b.length
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
    const head = a.slice(0, start).map(text => ({ mark: 'kept' as const, text }))
    const tail = a.slice(endA).map(text => ({ mark: 'kept' as const, text }))
    const middle = TextDiff.middle(a.slice(start, endA), b.slice(start, endB))
    return { before: [...head, ...middle.before, ...tail], after: [...head, ...middle.after, ...tail] }
  }

  /** A text's lines. A last line break ends the last line and starts no new one, so `a\n` and `a` are both one line; an empty text has none. */
  private static linesOf(text: string): string[] {
    if (text === '') return []
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length > 1 && lines.at(-1) === '') lines.pop()
    return lines
  }

  /** The changed middle of the two texts, compared with the table of longest common runs. */
  private static middle(a: readonly string[], b: readonly string[]): DiffSides {
    const removedAll = (): DiffSides => ({ before: a.map(text => ({ mark: 'removed', text })), after: b.map(text => ({ mark: 'added', text })) })
    if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) > TextDiff.MAX_CELLS) return removedAll()
    // `table[i][j]` is the length of the longest common run of `a[i..]` and `b[j..]`, kept in one flat array of width `b.length + 1`.
    const width = b.length + 1
    const table = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
      }
    }
    const before: DiffLine[] = [], after: DiffLine[] = []
    let i = 0, j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { before.push({ mark: 'kept', text: a[i]! }); after.push({ mark: 'kept', text: b[j]! }); i++; j++ }
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) before.push({ mark: 'removed', text: a[i++]! })
      else after.push({ mark: 'added', text: b[j++]! })
    }
    while (i < a.length) before.push({ mark: 'removed', text: a[i++]! })
    while (j < b.length) after.push({ mark: 'added', text: b[j++]! })
    return { before, after }
  }
}
