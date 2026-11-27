/**
 * Sorts an action a worker asks about first (`POST /ask`) into the checking tier the factory's gate would give the real call.
 * The sorter is the factory's own: this package does not copy its rules. It loads the factory's built file `lib/dist/gateTier.js` from the absolute
 * path in the plugin's `tierModule` setting and runs its `GateTierSorter` on the ask's raw values, as the factory's hook runs it on the real call.
 * Why: without it an ask carried no gate tier, so the judge's own grade could record a project-direction action (tier 1) at a lower tier, and the
 * real call then ran on that approval with no new judgement.
 * A tier problem never refuses an ask: with no module, or one that cannot be used, the ask has no gate tier and the judge's grade sets it.
 * This file imports only Node's own modules, so the factory's contract test can run it with Node straight from source.
 */
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Tier } from './decisions.ts'

/** What the sorter reads of one ask, all raw (before masking): the call, the folder it runs in and the worker session's own temp folder (`null` when it has none). */
export interface TierSortFields { tool_name: string; tool_input: unknown; cwd: string; scratchpad_dir: string | null }
/** The gate's tier of one ask and the name of the rule that set it, named as an `/assess` request carries them. */
export interface GateTierOfAsk { tier: Tier; tier_rule: string }
/** Sorts one ask. It gives `null` when the ask is unsorted or cannot be sorted, and never rejects. */
export interface TierSource { sort(fields: TierSortFields): Promise<GateTierOfAsk | null> }

/** The sorter the built file gives: the same call the factory's hook makes, with the same field names. */
interface GateSorter { sort(request: { toolName: string; toolInput: unknown; cwd: string; scratchpadDir: string | null }): unknown }
/** What the factory's built tier file exports: `new GateTierSorter()` gives a sorter with its real helpers. */
interface TierModuleExports { GateTierSorter?: unknown }

/**
 * The factory's tier sorter, loaded from its built file `lib/dist/gateTier.js`.
 * The file is imported on the first ask, not at start, so the plugin starts without it, and one sorter is built and kept.
 * Nothing here throws or refuses. No path, a path that is not absolute, a file that does not load, a file without `GateTierSorter`, a sorter that
 * cannot be built or that throws, and a result that is not `{ tier: 1 | 2 | 3, rule: text }` all give `null`: the ask is then judged without a gate
 * tier, as every ask was before this setting.
 * Only a missing file is tried again on the next ask. Node keeps a file once it has loaded it or once it threw while loading, so a tier file that
 * was fixed or rebuilt takes effect only after DSH restarts.
 */
export class FactoryTierModule implements TierSource {
  private static readonly TIERS: readonly unknown[] = [1, 2, 3]
  private sorter?: GateSorter
  constructor(readonly path?: string) {}

  async sort(fields: TierSortFields): Promise<GateTierOfAsk | null> {
    try {
      const sorter = await this.load()
      if (sorter === null) return null
      const result = sorter.sort({ toolName: fields.tool_name, toolInput: fields.tool_input, cwd: fields.cwd, scratchpadDir: fields.scratchpad_dir })
      if (result === null || typeof result !== 'object') return null
      const { tier, rule } = result as { tier?: unknown; rule?: unknown }
      if (!FactoryTierModule.TIERS.includes(tier) || typeof rule !== 'string') return null
      return { tier: tier as Tier, tier_rule: rule }
    } catch {
      // Any failure of the module or its sorter leaves the ask unsorted.
      return null
    }
  }

  /** The sorter, built on first use; `null` when the setting or the file cannot give one. It may throw: `sort` catches it. */
  private async load(): Promise<GateSorter | null> {
    if (this.sorter) return this.sorter
    if (this.path === undefined || this.path === '' || !isAbsolute(this.path)) return null
    const loaded = await import(pathToFileURL(this.path).href) as TierModuleExports
    const Sorter = loaded.GateTierSorter
    if (typeof Sorter !== 'function') return null
    const sorter = new (Sorter as new () => GateSorter)()
    if (sorter === null || typeof sorter !== 'object' || typeof sorter.sort !== 'function') return null
    this.sorter = sorter
    return sorter
  }
}
