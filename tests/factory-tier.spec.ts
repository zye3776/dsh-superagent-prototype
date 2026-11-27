/** The loader of the factory's tier sorter (`FactoryTierModule`), with stand-in tier files in a temporary folder. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FactoryTierModule, type TierSortFields } from '../src/factory/tier.ts'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'factory-tier-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** Writes a stand-in tier file and returns its path. */
const moduleWith = (name: string, source: string) => { const path = join(root, name); writeFileSync(path, source); return path }
const fields = (extra: Partial<TierSortFields> = {}): TierSortFields => ({ tool_name: 'Bash', tool_input: { command: 'bun test' }, cwd: '/work/app', scratchpad_dir: null, ...extra })

it('hands the sorter the call under the hook\'s field names and returns its tier and rule', async () => {
  const path = moduleWith('tier.mjs', `export class GateTierSorter {
    constructor(...given) { this.given = given.length }
    sort(request) { return { tier: 1, rule: JSON.stringify([this.given, request]), extra: 'not passed on' } }
  }\n`)
  const sorted = await new FactoryTierModule(path).sort(fields({ tool_name: 'Edit', tool_input: { file_path: '/work/app/prd.md' }, scratchpad_dir: '/tmp/s1' }))
  expect(Object.keys(sorted!)).toEqual(['tier', 'tier_rule'])
  expect(sorted!.tier).toBe(1)
  // Built with no argument, so the sorter uses its real helpers; the request has exactly the four fields the factory's sorter reads.
  expect(JSON.parse(sorted!.tier_rule)).toEqual([0, { toolName: 'Edit', toolInput: { file_path: '/work/app/prd.md' }, cwd: '/work/app', scratchpadDir: '/tmp/s1' }])
})

it('builds one sorter and keeps it', async () => {
  const path = moduleWith('tier.mjs', `let built = 0
  export class GateTierSorter { constructor() { built += 1 } sort() { return { tier: 3, rule: String(built) } } }\n`)
  const tiers = new FactoryTierModule(path)
  expect(await tiers.sort(fields())).toEqual({ tier: 3, tier_rule: '1' })
  expect(await tiers.sort(fields())).toEqual({ tier: 3, tier_rule: '1' })
})

it('gives null for a call the sorter leaves unsorted', async () => {
  const path = moduleWith('tier.mjs', 'export class GateTierSorter { sort() { return null } }\n')
  expect(await new FactoryTierModule(path).sort(fields())).toBeNull()
})

it('gives null, and never throws, when the module is not set, not absolute, missing or unusable', async () => {
  const cases: Record<string, string | undefined> = {
    'no path': undefined,
    'an empty path': '',
    'a relative path': 'tier.mjs',
    'a missing file': join(root, 'missing.mjs'),
    'a file that does not load': moduleWith('broken.mjs', 'export class GateTierSorter {\n'),
    'a file that throws while loading': moduleWith('throws.mjs', 'throw new Error("no")\n'),
    'no GateTierSorter': moduleWith('none.mjs', 'export const DecisionMask = {}\n'),
    'a GateTierSorter that is not a class': moduleWith('value.mjs', 'export const GateTierSorter = { sort: () => ({ tier: 1, rule: "r" }) }\n'),
    'a sorter that cannot be built': moduleWith('nobuild.mjs', 'export class GateTierSorter { constructor() { throw new Error("no") } }\n'),
    'a sorter without sort': moduleWith('nosort.mjs', 'export class GateTierSorter {}\n'),
    'a sorter that throws': moduleWith('sortthrows.mjs', 'export class GateTierSorter { sort() { throw new Error("no") } }\n'),
  }
  for (const [name, path] of Object.entries(cases)) expect(await new FactoryTierModule(path).sort(fields()), name).toBeNull()
})

it('gives null for a result that is not a tier 1, 2 or 3 with a text rule', async () => {
  const results = ['undefined', '"1"', '7', '[1, "r"]', '{}', '{ tier: 0, rule: "r" }', '{ tier: 4, rule: "r" }', '{ tier: "1", rule: "r" }', '{ tier: 1.5, rule: "r" }',
    '{ tier: 1 }', '{ tier: 1, rule: 7 }', '{ tier: 1, rule: null }', '{ rule: "r" }', 'Promise.resolve({ tier: 1, rule: "r" })']
  for (const [index, result] of results.entries()) {
    const path = moduleWith(`shape-${index}.mjs`, `export class GateTierSorter { sort() { return ${result} } }\n`)
    expect(await new FactoryTierModule(path).sort(fields()), result).toBeNull()
  }
  for (const tier of [1, 2, 3]) {
    const path = moduleWith(`good-${tier}.mjs`, `export class GateTierSorter { sort() { return { tier: ${tier}, rule: "r-${tier}" } } }\n`)
    expect(await new FactoryTierModule(path).sort(fields())).toEqual({ tier, tier_rule: `r-${tier}` })
  }
})

it('tries a missing file again on the next ask', async () => {
  const path = join(root, 'later.mjs')
  const tiers = new FactoryTierModule(path)
  expect(await tiers.sort(fields())).toBeNull()
  writeFileSync(path, 'export class GateTierSorter { sort() { return { tier: 2, rule: "late" } } }\n')
  expect(await tiers.sort(fields())).toEqual({ tier: 2, tier_rule: 'late' })
})

/** Opt-in: the factory's real built sorter (`ZEES_FACTORY_DIR` is the factory's folder), as the other factory specs use the real guard. */
const factoryDir = process.env.ZEES_FACTORY_DIR
const realTier = factoryDir === undefined ? '' : join(factoryDir, 'lib', 'dist', 'gateTier.js')
it.skipIf(realTier === '' || !existsSync(realTier))('sorts with the factory\'s real built sorter: a planning edit is tier 1, a project check tier 3', async () => {
  const project = join(root, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  const tiers = new FactoryTierModule(realTier)
  const edit = await tiers.sort({ tool_name: 'Edit', tool_input: { file_path: join(project, '_bmad-output', 'x', 'prd-x.md'), old_string: 'a', new_string: 'b' }, cwd: project, scratchpad_dir: null })
  expect(edit).toEqual({ tier: 1, tier_rule: 'project-direction-file' })
  expect(await tiers.sort({ tool_name: 'Bash', tool_input: { command: 'bun test' }, cwd: project, scratchpad_dir: null })).toEqual({ tier: 3, tier_rule: 'project-check' })
  // A claimed temp folder apart from the project does not turn a delete in the project into a temp-folder write.
  expect(await tiers.sort({ tool_name: 'Bash', tool_input: { command: 'rm -rf src' }, cwd: project, scratchpad_dir: join(root, 'temp') })).toMatchObject({ tier: 1 })
  expect(await tiers.sort({ tool_name: 'Edit', tool_input: { file_path: join(project, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }, cwd: project, scratchpad_dir: null })).toBeNull()
})
