/**
 * A stand-in for the factory's built job log file (`lib/dist/jobLog.js`), with the same exports, for the tests of the job log and of the review page.
 * Its mask replaces one planted value and puts the fields in the agreed order; its reader skips what is not JSON or lacks its fields, as the real one does.
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
export const JobLogMask = { forProject: project => ({
  maskAction: ({ ts, project, job_id, step_id, kind, summary }) => {
    if (kind !== 'job_start') throw new Error('kind: is not one of job_start')
    return { ts, project, job_id, step_id, kind, summary: clean(summary) }
  },
  maskReview: ({ ts, project, job_id, comment }) => ({ ts, project, job_id, comment: clean(comment) }),
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
`

let written = 0
/** Writes a module into `folder` and returns its path. Each one gets a name of its own, because Node loads a path once. */
export function recordsModule(folder: string, source: string = FAKE_RECORDS): string {
  const path = join(folder, `records-${written++}.mjs`)
  writeFileSync(path, source)
  return path
}
