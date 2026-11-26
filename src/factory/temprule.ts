/**
 * The temp-folder rule of the factory's `/assess` route, as plain code: a worker keeps its temp files in its session's own temp folder.
 * In a shared temp folder such as `/tmp` it may read anything, but outside its own folder and the one allowed shared folder it may not write or change
 * a path, may delete only what its session created, and may never delete through a variable.
 * `TempRule` takes the request's `temp` facts as the factory's hook sent them and works none of them out again. What the action does to a path comes
 * from the tool's name where that says it, and from the judge's answer for Bash and every other tool, because no command is parsed here.
 * This file takes only types from `assess.ts`, so it runs without DSH.
 */
import type { AssessRequest, TempFacts, TempPathFact } from './assess.ts'

/** What an action does to one path. A move, rename, chmod, truncation or any other change is a `write`. */
export type TempAction = 'read' | 'write' | 'delete'
/** One entry of the `temp` list in the judge's answer, as the judge wrote it: `action` is not checked yet. */
export interface TempListed { path: string; action: string }
/** What a decision says when the request breaks the rule. */
export interface TempBreak { reason: string; alternative: string; cites: string }

/** The temp-folder rule for one request. */
export class TempRule {
  static readonly ACTIONS: readonly TempAction[] = ['read', 'write', 'delete']
  /** The tools whose name says that they only read. */
  static readonly READ_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep']
  /** The tools whose name says that they write or change. */
  static readonly WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
  /** The `cites` of a decision the rule made. */
  static readonly CITES = 'The factory\'s temp-folder rule: a worker keeps its temp files in its session\'s own temp folder.'
  static readonly VARIABLE_REASON = 'The action deletes through a variable, so the path it deletes cannot be checked.'
  static readonly VARIABLE_ALTERNATIVE = 'Ask again with the path to delete written out in the command, not held in a variable.'
  static readonly NO_SESSION_DIR = 'This session has no known temp folder. Keep temp files in Claude Code\'s scratchpad folder for this session, and write, change and delete them only there.'

  private readonly facts: TempFacts | null
  /** The action the tool's name gives every path, or `undefined` when only the judge can say. */
  private readonly byTool: TempAction | undefined

  constructor(request: AssessRequest) {
    this.facts = request.temp ?? null
    const tool = request.tool_name
    this.byTool = typeof tool !== 'string' ? undefined : TempRule.READ_TOOLS.includes(tool) ? 'read' : TempRule.WRITE_TOOLS.includes(tool) ? 'write' : undefined
  }

  /** The facts the rule is about: the paths outside both the session's own temp folder and the allowed shared folder. */
  get relevant(): readonly TempPathFact[] {
    return this.facts === null ? [] : this.facts.paths.filter(fact => !fact.in_session_dir && !fact.in_exception)
  }

  /** Whether the request carries anything the rule is about. When not, the rule does nothing and the judge's question stays as it was. */
  get applies(): boolean { return this.relevant.length > 0 || this.facts?.variable_delete === true }

  /** The paths the judge's answer must give an action for: none when the tool's name already says what it does. Each path once. */
  get asked(): readonly string[] {
    return this.byTool === undefined ? [...new Set(this.relevant.map(fact => fact.path))] : []
  }

  /**
   * What is wrong with the judge's `temp` list, in words the judge can act on, or `undefined` when it can be used:
   * every asked path needs at least one entry, and each of its entries one of the three actions. Entries for other paths are not looked at.
   */
  problem(listed: readonly TempListed[]): string | undefined {
    const missing = this.asked.filter(path => {
      const actions = listed.filter(entry => entry.path === path).map(entry => entry.action)
      return actions.length === 0 || actions.some(action => !(TempRule.ACTIONS as readonly string[]).includes(action))
    })
    if (missing.length === 0) return undefined
    return `\`temp\` must give an \`action\` of ${TempRule.ACTIONS.map(action => `"${action}"`).join(', ')} for each of these paths, written exactly as here: ${JSON.stringify(missing)}`
  }

  /**
   * What the decision says when the request breaks the rule, or `undefined` when it keeps it.
   * A path breaks it when it is written, or deleted without being created by this session; a read never does. A delete through a variable always does.
   * @param listed - the judge's `temp` list, already found usable by `problem`. It is not looked at when the tool's name says what the tool does.
   */
  broken(listed: readonly TempListed[]): TempBreak | undefined {
    const paths = [...new Set(this.relevant.filter(fact => this.actionsOn(fact.path, listed).some(action => action === 'write' || (action === 'delete' && !fact.created_by_session)))
      .map(fact => fact.path))]
    const variable = this.facts?.variable_delete === true
    if (paths.length === 0 && !variable) return undefined
    const reasons: string[] = [], alternatives: string[] = []
    if (paths.length > 0) {
      const dir = this.facts?.session_dir ?? null
      reasons.push(`The action writes, changes or deletes in a shared temp folder, outside ${dir === null ? 'any temp folder of this session' : `the session temp folder ${dir}`}: `
        + `${paths.join(', ')}. There a session may only read, and delete what it created itself.`)
      alternatives.push(dir === null ? TempRule.NO_SESSION_DIR : `Keep temp files in the session temp folder, ${dir}, and write, change and delete them only there.`)
    }
    if (variable) {
      reasons.push(TempRule.VARIABLE_REASON)
      alternatives.push(TempRule.VARIABLE_ALTERNATIVE)
    }
    return { reason: reasons.join(' '), alternative: alternatives.join(' '), cites: TempRule.CITES }
  }

  /** Everything the action does to `path`: what the tool's name says, or else each action the judge listed for it. */
  private actionsOn(path: string, listed: readonly TempListed[]): string[] {
    return this.byTool !== undefined ? [this.byTool] : listed.filter(entry => entry.path === path).map(entry => entry.action)
  }
}
