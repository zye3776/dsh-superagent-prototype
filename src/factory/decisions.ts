/**
 * Writes decisions to `<project>/.factory/decisions.jsonl`, masked first.
 * The mask is the factory's own: this package does not copy it. It loads the factory's built file `lib/dist/decisionMask.js` from the absolute
 * path in the plugin's `maskModule` setting, and passes every decision line through it before the line is appended, so no secret and nothing that
 * says who the owner is reaches the file. Without a working mask nothing is written: the request is refused with 503.
 * The same built file also masks a request a worker asks about before it acts (`/ask`) and gives the factory's key of that request, so this package
 * copies neither.
 * This file imports only Node's own modules, so the factory's contract test can run it with Node straight from source.
 */
import { closeSync, constants, lstatSync, openSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One file the judge read, and whether it used it. */
export interface DecisionRead { path: string; used: boolean }
/** A decision in the shape the factory's `lib/decisionSchema` checks. */
export interface Decision {
  decision_id: string
  request_id: string
  kind: 'permission' | 'fork'
  decision: 'approve' | 'deny' | 'ask_owner'
  choice: string | null
  risk: 'low' | 'medium' | 'high'
  reason: string
  alternative: string
  cites: string
  reads: DecisionRead[]
  tokens: number
  seconds: number
}
/** A line of `decisions.jsonl`: the decision, the time it was written (ISO-8601, UTC) and the project's absolute path. */
export type DecisionLine = Decision & { ts: string; project: string }

/**
 * Represents a refusal of one `/assess` request, with the HTTP status to answer.
 * The route's steps throw it, and `AssessRoute.handle` turns it into a JSON error body; nothing is written in that case.
 */
export class AssessRefusal extends Error { constructor(readonly status: 400 | 401 | 403 | 405 | 409 | 413 | 503, message: string) { super(message) } }

/**
 * Appends decision lines to one project's `.factory/decisions.jsonl`.
 * It never creates `.factory/`: only the factory's own record writer does, so a project without the folder is refused.
 * A symlink at the folder's or the file's place is refused too, so a line cannot land in another folder.
 * It writes the line as it is given: `DecisionWriter` is the one that masks it first.
 */
export class DecisionsFile {
  static readonly FOLDER = '.factory'
  static readonly FILE = 'decisions.jsonl'
  constructor(readonly project: string) {}
  /** Appends the line after whatever the file already holds, and returns the exact text written, without its line break. */
  append(line: DecisionLine): string {
    const folder = join(this.project, DecisionsFile.FOLDER)
    let real = false
    // lstat does not follow a symlink, so a link to a folder does not count as the folder.
    try { real = lstatSync(folder).isDirectory() } catch { /* missing: refused below */ }
    if (!real) throw new AssessRefusal(409, `The project has no ${DecisionsFile.FOLDER} folder yet`)
    const text = JSON.stringify(line)
    let fd: number
    // Append-only, and NOFOLLOW makes the open fail when the file's place holds a symlink.
    try { fd = openSync(join(folder, DecisionsFile.FILE), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new AssessRefusal(409, `Refusing to write through a symlink at ${DecisionsFile.FILE}`)
      throw error
    }
    try { writeSync(fd, `${text}\n`, null, 'utf8') } finally { closeSync(fd) }
    return text
  }
}

/** Cleans one decision line: the result holds no secret and nothing that says who the owner is. It throws when the line is not a decision. */
export interface DecisionMasker {
  mask(line: DecisionLine): DecisionLine
  /**
   * Cleans the fields of a request a worker sent (`/ask`), the way the factory's hook masks a request before it is written. A masker of a factory
   * from before "ask first" has none; then nothing can be asked.
   */
  maskRequest?(fields: Record<string, unknown>): Record<string, unknown>
}
/**
 * Gives the masker of one project. It rejects with `AssessRefusal(503)` when there is none.
 * `requestKey` gives the factory's key of one request (session id, tool, input, all raw); a source without it cannot serve `/ask`.
 */
export interface MaskSource {
  maskerFor(project: string): Promise<DecisionMasker>
  requestKey?(sessionId: string, toolName: string, toolInput: unknown): Promise<string>
}
/**
 * What the factory's built mask file exports: `DecisionMask.forProject(project)` gives the masker of that project, and
 * `DecisionMask.requestKey(session, tool, input)` the key the factory's hook writes as `request_key`.
 */
interface MaskModuleExports { DecisionMask?: { forProject?: unknown; requestKey?: unknown } }

/**
 * The factory's mask, loaded from its built file `lib/dist/decisionMask.js`.
 * The file is imported on the first decision, not at start, so the plugin starts without it, and a masker is built once for each project.
 * Any failure is a 503: no path given, a path that is not absolute, a file that does not load, a file without `DecisionMask.forProject`, or a
 * masker that cannot be built.
 * Only a missing file is tried again on the next request. Node keeps a file once it has loaded it (with or without `DecisionMask.forProject`) or once
 * it threw while loading, and a masker is kept for as long as the process runs. So a mask file that was fixed or rebuilt takes effect only after DSH restarts.
 * The refusal says which step failed and never repeats the error's own text, which could quote what was to be masked.
 */
export class FactoryMaskModule implements MaskSource {
  private readonly maskers = new Map<string, DecisionMasker>()
  constructor(readonly path?: string) {}
  async maskerFor(project: string): Promise<DecisionMasker> {
    const known = this.maskers.get(project)
    if (known) return known
    if (this.path === undefined || this.path === '') throw new AssessRefusal(503, 'No maskModule is configured, so no decision can be masked and none is written')
    if (!isAbsolute(this.path)) throw new AssessRefusal(503, 'The configured maskModule is not an absolute path, so no decision is written')
    const loaded = await this.load('no decision is written')
    const forProject = loaded.DecisionMask?.forProject
    if (typeof forProject !== 'function') throw new AssessRefusal(503, 'The configured maskModule does not export DecisionMask.forProject, so no decision is written')
    let masker: unknown
    try { masker = forProject.call(loaded.DecisionMask, project) }
    catch { throw new AssessRefusal(503, 'The configured maskModule could not build a mask for the project, so no decision is written') }
    if (masker === null || typeof masker !== 'object' || typeof (masker as DecisionMasker).mask !== 'function') {
      throw new AssessRefusal(503, 'The configured maskModule gave no masker for the project, so no decision is written')
    }
    this.maskers.set(project, masker as DecisionMasker)
    return masker as DecisionMasker
  }

  /**
   * The factory's own key of one request, computed by its `RequestKey` inside the built file, so this package holds no second implementation of it.
   * Pass the raw values, before masking. Refuses with 503 when the module is missing or is from a factory without `DecisionMask.requestKey`, and
   * with 400 when the values cannot be turned into a key.
   */
  async requestKey(sessionId: string, toolName: string, toolInput: unknown): Promise<string> {
    if (this.path === undefined || this.path === '') throw new AssessRefusal(503, 'No maskModule is configured, so no request can be keyed and none is judged')
    if (!isAbsolute(this.path)) throw new AssessRefusal(503, 'The configured maskModule is not an absolute path, so no request is judged')
    const loaded = await this.load('no request is judged')
    const requestKey = loaded.DecisionMask?.requestKey
    if (typeof requestKey !== 'function') throw new AssessRefusal(503, 'The configured maskModule does not export DecisionMask.requestKey, so no request is judged')
    let key: unknown
    try { key = requestKey.call(loaded.DecisionMask, sessionId, toolName, toolInput) }
    catch { throw new AssessRefusal(400, 'The request cannot be given a key') }
    if (typeof key !== 'string' || key === '') throw new AssessRefusal(503, 'The configured maskModule gave no key for the request, so it is not judged')
    return key
  }

  /** Imports the module; `what` says, in the refusal, what does not happen without it. */
  private async load(what: string): Promise<MaskModuleExports> {
    try { return await import(pathToFileURL(this.path as string).href) as MaskModuleExports }
    catch { throw new AssessRefusal(503, `The configured maskModule could not be loaded, so ${what}`) }
  }
}

/**
 * Writes one decision: masks the line, then appends the masked line to its project's file.
 * A line that cannot be masked is not written, and the request is refused with 503.
 */
export class DecisionWriter {
  constructor(private readonly masks: MaskSource = new FactoryMaskModule()) {}
  /** Returns the exact text written, without its line break. It is the masked line, so the caller answers with what the file holds. */
  async write(line: DecisionLine): Promise<string> {
    const masker = await this.masks.maskerFor(line.project)
    let masked: DecisionLine
    try { masked = masker.mask(line) }
    catch { throw new AssessRefusal(503, 'The decision could not be masked, so it is not written') }
    if (masked === null || typeof masked !== 'object' || Array.isArray(masked)) throw new AssessRefusal(503, 'The decision could not be masked, so it is not written')
    return new DecisionsFile(line.project).append(masked)
  }

  /**
   * Masks the fields of a request a worker sent, with the same factory mask, before the judge sees them. Returns the masked copy.
   * Refuses with 503 when there is no mask, when it cannot mask a request (a factory from before "ask first"), or when masking fails.
   */
  async maskRequest(project: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const masker = await this.masks.maskerFor(project)
    if (typeof masker.maskRequest !== 'function') throw new AssessRefusal(503, 'The configured maskModule cannot mask a request, so it is not judged')
    let masked: unknown
    try { masked = masker.maskRequest(fields) }
    catch { throw new AssessRefusal(503, 'The request could not be masked, so it is not judged') }
    if (masked === null || typeof masked !== 'object' || Array.isArray(masked)) throw new AssessRefusal(503, 'The request could not be masked, so it is not judged')
    return masked as Record<string, unknown>
  }

  /** The factory's key of one request, from the same mask source. Refuses with 503 when the source cannot give one. */
  async requestKey(sessionId: string, toolName: string, toolInput: unknown): Promise<string> {
    if (typeof this.masks.requestKey !== 'function') throw new AssessRefusal(503, 'The mask source cannot key a request, so it is not judged')
    return this.masks.requestKey(sessionId, toolName, toolInput)
  }
}
