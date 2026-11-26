/** The temp-folder rule alone: `TempRule` on recorded requests, with no judge and no DSH. */
import { describe, expect, it } from 'vitest'
import { TempRule, type TempListed } from '../src/factory/temprule.ts'
import { RecordedRequests } from './fixtures/factory-requests.ts'

const requests = new RecordedRequests('/made-up/project')
const { SCRATCHPAD, TEMP_FILE, TEMP_MINE, TEMP_OTHER } = RecordedRequests
const says = (path: string, action: string): TempListed => ({ path, action })

describe('TempRule: which requests it is about', () => {
  it('does nothing for a request with no temp facts, with null facts, or with no path outside the session folder and the allowed folder', () => {
    const none = requests.plain(), unknown = { ...requests.plain(), temp: null }, empty = { ...requests.plain(), temp: RecordedRequests.temp([]) }
    for (const request of [none, unknown, empty, requests.tempAllowed('in_session_dir'), requests.tempAllowed('in_exception')]) {
      const rule = new TempRule(request)
      expect([rule.applies, rule.asked, rule.relevant, rule.problem([]), rule.broken([])], request.request_id).toEqual([false, [], [], undefined, undefined])
    }
  })

  it('ignores what the judge lists for a path in the session folder or the allowed folder', () => {
    const request = requests.tempAllowed('in_session_dir')
    expect(new TempRule(request).broken([says(request.temp!.paths[0]!.path, 'write')])).toBeUndefined()
  })

  it('asks the judge about each path once for Bash and for a tool it does not know, and about none for a tool whose name says what it does', () => {
    expect(new TempRule(requests.tempWrite()).asked).toEqual([TEMP_FILE])
    const twice = { ...requests.tempWrite(), temp: RecordedRequests.temp([RecordedRequests.fact(TEMP_FILE), RecordedRequests.fact(TEMP_FILE), RecordedRequests.fact(TEMP_OTHER)]) }
    expect(new TempRule(twice).asked).toEqual([TEMP_FILE, TEMP_OTHER])
    for (const tool of ['mcp__files__move', 'Task', 7, undefined]) expect(new TempRule({ ...requests.tempWrite(), tool_name: tool }).asked, String(tool)).toEqual([TEMP_FILE])
    for (const tool of [...TempRule.READ_TOOLS, ...TempRule.WRITE_TOOLS]) expect(new TempRule({ ...requests.tempWrite(), tool_name: tool }).asked, tool).toEqual([])
    expect([TempRule.READ_TOOLS, TempRule.WRITE_TOOLS]).toEqual([['Read', 'Glob', 'Grep'], ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']])
  })

  it('applies to a delete through a variable that names no path, and asks the judge about nothing', () => {
    const rule = new TempRule(requests.tempVariableDelete())
    expect([rule.applies, rule.asked]).toEqual([true, []])
  })
})

describe('TempRule.problem', () => {
  it('names each asked path the judge left out or gave an unknown action, and accepts the three actions', () => {
    const rule = new TempRule(requests.tempWrite())
    for (const listed of [[], [says(TEMP_OTHER, 'write')], [says(TEMP_FILE, 'move')], [says(TEMP_FILE, 'read'), says(TEMP_FILE, '')]]) {
      expect(rule.problem(listed)).toBe(`\`temp\` must give an \`action\` of "read", "write", "delete" for each of these paths, written exactly as here: ["${TEMP_FILE}"]`)
    }
    for (const action of TempRule.ACTIONS) expect(rule.problem([says(TEMP_FILE, action), says('/tmp/zsf-unasked.txt', 'move')]), action).toBeUndefined()
  })

  it('wants nothing from the judge for a tool whose name says what it does', () => {
    expect(new TempRule(requests.tempWriteTool()).problem([])).toBeUndefined()
    expect(new TempRule(requests.tempRead()).problem([])).toBeUndefined()
  })
})

describe('TempRule.broken', () => {
  it('is broken by a write, with a message that names the session temp folder and says to keep temp files there', () => {
    const broken = new TempRule(requests.tempWrite()).broken([says(TEMP_FILE, 'write')])
    expect(broken).toEqual({
      reason: `The action writes, changes or deletes in a shared temp folder, outside the session temp folder ${SCRATCHPAD}: ${TEMP_FILE}. There a session may only read, and delete what it created itself.`,
      alternative: `Keep temp files in the session temp folder, ${SCRATCHPAD}, and write, change and delete them only there.`,
      cites: TempRule.CITES,
    })
  })

  it('takes the action from the tool\'s name, whatever the judge lists: a Write breaks it and a Read does not', () => {
    expect(new TempRule(requests.tempWriteTool()).broken([says(TEMP_FILE, 'read')])?.alternative).toContain(SCRATCHPAD)
    expect(new TempRule(requests.tempRead()).broken([says(TEMP_FILE, 'write')])).toBeUndefined()
    for (const tool of TempRule.WRITE_TOOLS) expect(new TempRule({ ...requests.tempWrite(), tool_name: tool }).broken([]), tool).toBeDefined()
    for (const tool of TempRule.READ_TOOLS) expect(new TempRule({ ...requests.tempWrite(), tool_name: tool }).broken([]), tool).toBeUndefined()
  })

  it('is not broken by a read', () => {
    expect(new TempRule(requests.tempWrite()).broken([says(TEMP_FILE, 'read')])).toBeUndefined()
  })

  it('lets a session delete what it created, but not write to it, and not delete what it did not create', () => {
    expect(new TempRule(requests.tempRemoveOwn()).broken([says(TEMP_MINE, 'delete')])).toBeUndefined()
    expect(new TempRule(requests.tempRemoveOwn()).broken([says(TEMP_MINE, 'write')])?.reason).toContain(TEMP_MINE)
    expect(new TempRule(requests.tempRemoveOwn()).broken([says(TEMP_MINE, 'delete'), says(TEMP_MINE, 'write')])).toBeDefined()
    expect(new TempRule(requests.tempRemoveOther()).broken([says(TEMP_OTHER, 'delete')])?.reason).toContain(TEMP_OTHER)
  })

  it('names only the paths that break it', () => {
    const request = { ...requests.tempRemoveOwn(), temp: RecordedRequests.temp([RecordedRequests.fact(TEMP_MINE, { created_by_session: true }), RecordedRequests.fact(TEMP_OTHER), RecordedRequests.fact(TEMP_FILE)]) }
    const broken = new TempRule(request).broken([says(TEMP_MINE, 'delete'), says(TEMP_OTHER, 'delete'), says(TEMP_FILE, 'read')])
    expect(broken?.reason).toContain(`: ${TEMP_OTHER}. `)
  })

  it('says that the session has no known temp folder, and to use the scratchpad, when session_dir is null', () => {
    const broken = new TempRule(requests.tempWrite(null)).broken([says(TEMP_FILE, 'write')])
    expect(broken?.alternative).toBe(TempRule.NO_SESSION_DIR)
    expect(TempRule.NO_SESSION_DIR).toMatch(/no known temp folder.*Claude Code's scratchpad folder for this session/)
    expect(broken?.reason).toContain('outside any temp folder of this session')
  })

  it('is always broken by a delete through a variable, and asks for the path written out', () => {
    expect(new TempRule(requests.tempVariableDelete()).broken([])).toEqual({ reason: TempRule.VARIABLE_REASON, alternative: TempRule.VARIABLE_ALTERNATIVE, cites: TempRule.CITES })
    expect(TempRule.VARIABLE_ALTERNATIVE).toMatch(/path to delete written out/)
    // Also when the only path named is one the session may delete.
    const own = { ...requests.tempRemoveOwn(), temp: RecordedRequests.temp([RecordedRequests.fact(TEMP_MINE, { created_by_session: true })], SCRATCHPAD, true) }
    expect(new TempRule(own).broken([says(TEMP_MINE, 'delete')])?.reason).toBe(TempRule.VARIABLE_REASON)
  })

  it('gives both messages when a write and a delete through a variable come together', () => {
    const both = { ...requests.tempWrite(), temp: RecordedRequests.temp([RecordedRequests.fact(TEMP_FILE)], SCRATCHPAD, true) }
    const broken = new TempRule(both).broken([says(TEMP_FILE, 'write')])
    expect(broken?.reason).toContain(TEMP_FILE)
    expect(broken?.reason.endsWith(TempRule.VARIABLE_REASON)).toBe(true)
    expect(broken?.alternative).toBe(`Keep temp files in the session temp folder, ${SCRATCHPAD}, and write, change and delete them only there. ${TempRule.VARIABLE_ALTERNATIVE}`)
  })
})
