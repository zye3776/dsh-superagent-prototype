/**
 * A plugin run in a process of its own, for the test that kills it: it begins a job in the project, records one permission answer,
 * prints `ready` and then waits to be killed. Run with Node straight from source, which strips the types: `node factory-job-child.mjs <recordsModule> <project>`.
 */
import { FactoryJob } from '../../src/factory/job.ts'
import { FactoryRecordsModule, JobRecorder } from '../../src/factory/records.ts'

const [records, project] = process.argv.slice(2)
const job = new FactoryJob(new JobRecorder(new FactoryRecordsModule(records), [project]), project, message => { process.stderr.write(`${message}\n`) })
await job.answered({ project, requestId: 'request-1', decisionId: 'decision-1', decision: 'approve', tokens: 40, seconds: 1.25 })
process.stdout.write('ready\n')
// Keeps the process alive until the test kills it.
setInterval(() => {}, 60_000)
