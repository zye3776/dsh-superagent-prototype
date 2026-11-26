/**
 * A stand-in for the factory's built job log file (`lib/dist/jobLog.js`), with the same exports, for the tests of the job log and of the review page.
 * Its `JobsReader` only groups the job log into jobs: it reads no automatic answer, which the review page's tests check with the real built file.
 * Its mask refuses an unknown kind or field, replaces one planted value in every text field and puts the fields in the agreed order; its reader skips what is not JSON or lacks its fields, as the real one does.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The value a test plants in a line; the stand-in mask replaces it with `REDACTED`. */
export const PLANTED = 'planted-secret-value'
export const REDACTED = '[redacted-secret]'

/** The source of the stand-in module. */
export const FAKE_RECORDS = `import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const clean = text => text.replaceAll(${JSON.stringify(PLANTED)}, ${JSON.stringify(REDACTED)})
const KINDS = ['job_start', 'job_stop', 'permission_answer', 'fork_answer', 'message_in', 'message_out', 'session_start', 'session_steer']
const ACTION_FIELDS = ['ts', 'project', 'job_id', 'step_id', 'kind', 'summary', 'ref', 'tokens', 'ms', 'from', 'to', 'dsh_session_id', 'guideline_version']
const REVIEW_FIELDS = ['ts', 'project', 'job_id', 'step_id', 'comment']
const ordered = (line, fields) => {
  const unknown = Object.keys(line).find(name => !fields.includes(name))
  if (unknown !== undefined) throw new Error(unknown + ': is not a field')
  const out = {}
  for (const name of fields) if (line[name] !== undefined) out[name] = typeof line[name] === 'string' && !['ts', 'project', 'kind'].includes(name) ? clean(line[name]) : line[name]
  return out
}
export const JobLogMask = { forProject: project => ({
  maskAction: line => {
    if (!KINDS.includes(line.kind)) throw new Error('kind: is not one of ' + KINDS.join(', '))
    return ordered(line, ACTION_FIELDS)
  },
  maskReview: line => ordered(line, REVIEW_FIELDS),
}) }
export class JobLogReader {
  read(project) {
    const lines = (file, field) => {
      let text = ''
      try { text = readFileSync(join(project, '.factory', file), 'utf8') } catch { return [] }
      return text.split('\\n').flatMap(line => {
        try {
          const value = JSON.parse(line)
          return value !== null && typeof value === 'object' && typeof value.job_id === 'string' && typeof value.ts === 'string' && typeof value[field] === 'string' ? [value] : []
        } catch { return [] }
      })
    }
    return { actions: lines('actions.jsonl', 'summary'), reviews: lines('reviews.jsonl', 'comment') }
  }
}
const byTs = (a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
export class JobsReader {
  read(projects) {
    return [...new Set(projects)].map(project => {
      const { actions, reviews } = new JobLogReader().read(project)
      const byId = new Map()
      for (const line of actions) byId.set(line.job_id, [...(byId.get(line.job_id) ?? []), line])
      const jobs = [...byId].map(([job_id, lines]) => {
        lines.sort(byTs)
        const start = lines.find(line => line.kind === 'job_start'), stop = lines.find(line => line.kind === 'job_stop')
        return { project, job_id, number: 0, started: lines[0].ts, stopped: stop ? stop.ts : null, last: lines.at(-1).ts,
          ...(start?.guideline_version ? { guideline_version: start.guideline_version } : {}),
          steps: lines.map(line => ({ automatic: false, ts: line.ts, line })), reviews: reviews.filter(review => review.job_id === job_id) }
      })
      jobs.sort((a, b) => byTs({ ts: a.started }, { ts: b.started })).forEach((job, index) => { job.number = index + 1 })
      return { project, jobs: jobs.reverse(), outside: [] }
    })
  }
}
`

let written = 0
/** Writes a module into `folder` and returns its path. Each one gets a name of its own, because Node loads a path once. */
export function recordsModule(folder: string, source: string = FAKE_RECORDS): string {
  const path = join(folder, `records-${written++}.mjs`)
  writeFileSync(path, source)
  return path
}
