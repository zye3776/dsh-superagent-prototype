/** The decision writer on a temporary project: every line goes through the mask module first, and without a working mask nothing is written. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AssessRefusal, DecisionsFile, DecisionWriter, FactoryMaskModule, type DecisionLine } from '../src/factory/decisions.ts'

let root = '', project = ''
const file = (of: string = project) => join(of, DecisionsFile.FOLDER, DecisionsFile.FILE)
const lines = (of: string = project) => readFileSync(file(of), 'utf8').split('\n').filter(line => line !== '')
const line = (fields: Partial<DecisionLine> = {}): DecisionLine => ({ decision_id: 'd-1', request_id: 'req-1', kind: 'permission', decision: 'deny', choice: null, risk: 'high', tier: 1, tier_set_by: 'judge',
  reason: 'The command prints planted-secret-value.', alternative: 'Ask for a narrower command.', cites: 'Ticket 3.', reads: [{ path: '.env', used: false }], tokens: 12,
  seconds: 0.5, ts: '2026-11-26T08:09:10.123Z', project, ...fields })
/** Writes a stand-in for the factory's built mask file and returns its path. Each one gets a name of its own, because Node loads a path once. */
let modules = 0
function maskModule(source: string): string {
  const path = join(root, `mask-${modules++}.mjs`)
  writeFileSync(path, source)
  return path
}
/** A mask module as the factory builds it: `DecisionMask.forProject(project)` gives `{ mask(line) }`. This one replaces the planted value. */
const REPLACING = `export const DecisionMask = { forProject: project => ({ mask: line => ({ ...line, reason: line.reason.replace('planted-secret-value', '[redacted-secret]') }) }) }\n`
/** The status and message of the refusal a failed write gives. */
async function refusal(writer: DecisionWriter, written: DecisionLine = line()): Promise<[number, string]> {
  try { await writer.write(written) } catch (error) {
    if (error instanceof AssessRefusal) return [error.status, error.message]
    throw error
  }
  throw new Error('the line was written')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-decisions-'))
  project = join(root, 'project')
  mkdirSync(join(project, DecisionsFile.FOLDER), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

it('masks the line, appends the masked line and returns the text it wrote', async () => {
  const writer = new DecisionWriter(new FactoryMaskModule(maskModule(REPLACING)))
  const text = await writer.write(line())
  expect(JSON.parse(text)).toEqual(line({ reason: 'The command prints [redacted-secret].' }))
  expect(lines()).toEqual([text])
  expect(readFileSync(file(), 'utf8')).not.toContain('planted-secret-value')
  // The fields keep the order the masker gives them, and what is not text keeps its type.
  expect(Object.keys(JSON.parse(text) as object)).toEqual(Object.keys(line()))
  expect(JSON.parse(text)).toMatchObject({ reads: [{ path: '.env', used: false }], tokens: 12, seconds: 0.5 })
})

it('builds one masker for each project and uses it for every line of that project', async () => {
  const other = join(root, 'other')
  mkdirSync(join(other, DecisionsFile.FOLDER), { recursive: true })
  // The module counts its own calls and writes the count and the project into the line.
  const counting = maskModule(`let built = 0
export const DecisionMask = { forProject: project => { const number = ++built; return { mask: line => ({ ...line, cites: number + ' for ' + project }) } } }\n`)
  const writer = new DecisionWriter(new FactoryMaskModule(counting))
  await writer.write(line())
  await writer.write(line({ request_id: 'req-2' }))
  await writer.write(line({ project: other }))
  expect(lines().map(text => (JSON.parse(text) as DecisionLine).cites)).toEqual([`1 for ${project}`, `1 for ${project}`])
  expect(lines(other).map(text => (JSON.parse(text) as DecisionLine).cites)).toEqual([`2 for ${other}`])
})

it('refuses with 503 and writes nothing when there is no usable mask module', async () => {
  const cases: [string | undefined, string][] = [
    [undefined, 'No maskModule is configured'],
    ['', 'No maskModule is configured'],
    ['relative/decisionMask.js', 'not an absolute path'],
    [join(root, 'missing.mjs'), 'could not be loaded'],
    [maskModule('this is not JavaScript {'), 'could not be loaded'],
    [maskModule('throw new Error("planted-detail")\n'), 'could not be loaded'],
    [maskModule('export const Other = 1\n'), 'does not export DecisionMask.forProject'],
    [maskModule('export const DecisionMask = { forProject: "no" }\n'), 'does not export DecisionMask.forProject'],
    [maskModule('export const DecisionMask = { forProject: () => { throw new Error("planted-detail") } }\n'), 'could not build a mask'],
    [maskModule('export const DecisionMask = { forProject: () => ({}) }\n'), 'gave no masker'],
  ]
  for (const [path, message] of cases) {
    const [status, text] = await refusal(new DecisionWriter(new FactoryMaskModule(path)))
    expect([path, status]).toEqual([path, 503])
    expect(text).toContain(message)
    expect(text).not.toContain('planted-detail')
  }
  // With no argument at all, the writer has no mask module either.
  expect((await refusal(new DecisionWriter()))[0]).toBe(503)
  expect(existsSync(file())).toBe(false)
})

it('refuses with 503 and writes nothing when the masker throws or gives no line', async () => {
  for (const mask of ['() => { throw new Error("planted-detail: " + "reason") }', '() => undefined', '() => null', '() => "text"', '() => []']) {
    const writer = new DecisionWriter(new FactoryMaskModule(maskModule(`export const DecisionMask = { forProject: () => ({ mask: ${mask} }) }\n`)))
    const [status, text] = await refusal(writer)
    expect([mask, status, text]).toEqual([mask, 503, 'The decision could not be masked, so it is not written'])
  }
  expect(existsSync(file())).toBe(false)
})

it('tries a missing mask module again, so a file that appears later works without a restart', async () => {
  const path = join(root, 'later.mjs')
  const writer = new DecisionWriter(new FactoryMaskModule(path))
  expect((await refusal(writer))[0]).toBe(503)
  writeFileSync(path, REPLACING)
  await writer.write(line())
  expect(lines()).toHaveLength(1)
})

it('still refuses a project without its .factory folder, after masking', async () => {
  rmSync(join(project, DecisionsFile.FOLDER), { recursive: true })
  expect(await refusal(new DecisionWriter(new FactoryMaskModule(maskModule(REPLACING))))).toEqual([409, 'The project has no .factory folder yet'])
  expect(existsSync(join(project, DecisionsFile.FOLDER))).toBe(false)
})

/** The status and message of the refusal a call ends in. */
const refusedWith = async (attempt: Promise<unknown>): Promise<[number, string]> => {
  try { await attempt } catch (error) { if (error instanceof AssessRefusal) return [error.status, error.message]; throw error }
  throw new Error('The call was not refused')
}

it('gives the factory\'s key of a request and masks a request\'s fields, both through the mask module', async () => {
  const path = maskModule(`export const DecisionMask = {
    requestKey(session, tool, input) { return this === DecisionMask ? 'key:' + JSON.stringify([session, tool, input]) : 'wrong this' },
    forProject: project => ({ mask: line => line, maskRequest: fields => ({ ...fields, reason: fields.reason.replace('planted-secret-value', '[redacted-secret]') }) }),
  }\n`)
  const masks = new FactoryMaskModule(path)
  const writer = new DecisionWriter(masks)
  expect(await writer.requestKey('s1', 'Bash', { command: 'ls' })).toBe('key:["s1","Bash",{"command":"ls"}]')
  const fields = { reason: 'It prints planted-secret-value.', tool_input: { command: 'ls' } }
  expect(await writer.maskRequest(project, fields)).toEqual({ reason: 'It prints [redacted-secret].', tool_input: { command: 'ls' } })
  // The fields passed in are not changed.
  expect(fields.reason).toBe('It prints planted-secret-value.')
})

it('refuses to key or mask a request with 503 when the mask module cannot, and never repeats the module\'s own error', async () => {
  const old = maskModule('export const DecisionMask = { forProject: () => ({ mask: line => line }) }\n')
  const throwing = maskModule(`export const DecisionMask = { requestKey: () => { throw new Error('planted-secret-value') },
    forProject: () => ({ mask: line => line, maskRequest: () => { throw new Error('planted-secret-value') } }) }\n`)
  const empty = maskModule('export const DecisionMask = { requestKey: () => \'\', forProject: () => ({ mask: line => line, maskRequest: () => null }) }\n')
  const key = (path?: string) => refusedWith(new DecisionWriter(new FactoryMaskModule(path)).requestKey('s1', 'Bash', {}))
  const mask = (path?: string) => refusedWith(new DecisionWriter(new FactoryMaskModule(path)).maskRequest(project, { reason: 'x' }))
  expect((await key())[0]).toBe(503)
  expect((await key('relative/mask.mjs'))[0]).toBe(503)
  expect((await key(join(root, 'missing.mjs')))[0]).toBe(503)
  expect(await key(old)).toEqual([503, 'The configured maskModule does not export DecisionMask.requestKey, so no request is judged'])
  // A request that cannot be keyed is the caller's fault, not this side's.
  expect(await key(throwing)).toEqual([400, 'The request cannot be given a key'])
  expect((await key(empty))[0]).toBe(503)
  expect((await mask())[0]).toBe(503)
  expect(await mask(old)).toEqual([503, 'The configured maskModule cannot mask a request, so it is not judged'])
  expect(await mask(throwing)).toEqual([503, 'The request could not be masked, so it is not judged'])
  expect((await mask(empty))[0]).toBe(503)
  // A mask source without a key function of its own (a test's stand-in) cannot key either.
  expect((await refusedWith(new DecisionWriter({ maskerFor: async () => ({ mask: line => line }) }).requestKey('s1', 'Bash', {})))[0]).toBe(503)
})
