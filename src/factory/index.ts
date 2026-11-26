/**
 * Factory plugin entry: mounts the `/assess` route the factory's hooks ask for a decision, and keeps the read-only judge Sessions that `ModelJudge` asks for each one.
 * Each run of the plugin is one job in the job log: its start, each permission answer, each message into or out of the main session, and its stop
 * (`job.ts`, `mainsession.ts`). It also mounts the owner's review page at `/review`, whose "Start review talk" prepares a job's review talk in Claude
 * Desktop (`talk.ts`) and whose `/review/proposal` takes the talk's proposed guideline text back.
 * Every model thread it runs, the main session and each judge thread, starts with the owner's current decision guideline in its system prompt, and
 * `job_start` names the version (`guideline.ts`).
 * It runs on its own, without the main plugin.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import s from '@deepseek-ai/schemastery'
import { AssessRoute } from './assess.ts'
import { DecisionWriter, FactoryMaskModule } from './decisions.ts'
import { GuidelineSection } from './guideline.ts'
import { FactoryJob } from './job.ts'
import { FactoryGuardModule, JudgeSessions } from './judge.ts'
import { MainSessionWatch } from './mainsession.ts'
import { FactoryRecordsModule, JobRecorder } from './records.ts'
import { ReviewPage, ReviewRoute } from './review.ts'
import { ReviewTalks } from './talk.ts'
import { SharedTokenFile } from './token.ts'
import { ModelJudge } from './verdict.ts'

export const name = 'dsh-superagent-factory'
export const inject = ['webServer', 'agents', 'sessionController', 'workspaceRegistry', 'permissionPresets', 'systemPrompt']
/** Plugin configuration of the dsh-superagent-factory entry. */
export const Config = s.object({
  projects: s.array(s.string().pattern(/^\//)).default([])
    .description('Projects the route may write a decision into. Absolute paths; a project must already have its .factory folder.'),
  tokenFile: s.string().pattern(/^\//).default(SharedTokenFile.DEFAULT_PATH)
    .description('The file that holds the token shared with the factory. Absolute path; the file must be readable by its owner only (mode 0600).'),
  maskModule: s.string().pattern(/^\//)
    .description('The factory\'s built mask file, lib/dist/decisionMask.js in the factory\'s folder. Absolute path, no default; every decision is masked with it before it is written, and without it the route answers 503.'),
  guardModule: s.string().pattern(/^\//)
    .description('The factory\'s built judge guard file, lib/dist/judgeGuard.js in the factory\'s folder. Absolute path, no default; every tool call of a judge Session is checked with it, and without it no judge Session is opened and the route answers 503.'),
  recordsModule: s.string().pattern(/^\//)
    .description('The factory\'s built job log file, lib/dist/jobLog.js in the factory\'s folder. Absolute path, no default; every job log line and every comment of the review page is masked with it before it is written, and the review page reads the records and the decision guideline\'s versions with it. A review talk\'s files are masked with it too, and its tool server is lib/dist/proposeServer.js next to it. Without it no job log line or comment is written and the review page answers 503.'),
})
export type FactoryConfig = ReturnType<typeof Config>
export function apply(ctx: Context, config: FactoryConfig): void {
  // This run of the plugin is one job. Its lines are written as things happen; `FactoryJob` never rejects, so DSH works with or without them.
  const warn = (message: string) => { ctx.logger.warn('dsh-superagent-factory: %s', message) }
  let folder: string | undefined
  // Asking for the start folder throws when that folder was deleted since.
  try { folder = process.cwd() } catch { /* told below */ }
  if (folder === undefined) warn('No job_start line was written: the folder DSH was started in is gone')
  const records = new FactoryRecordsModule(config.recordsModule)
  // Before any session exists, so every agent DSH creates gets the guideline, judges included.
  const guideline = new GuidelineSection(records, warn)
  guideline.install(ctx)
  const job = new FactoryJob(new JobRecorder(records, config.projects ?? []), folder, warn, undefined, { versionOf: id => guideline.jobVersion(id) })
  new MainSessionWatch(job).install(ctx)
  ctx.effect(() => () => job.stop(), 'factory: job stop')
  const judges = new JudgeSessions(ctx, new FactoryGuardModule(config.guardModule))
  const tokens = new SharedTokenFile(config.tokenFile ?? SharedTokenFile.DEFAULT_PATH)
  const route = new AssessRoute(config.projects ?? [], tokens, new ModelJudge(judges), undefined,
    new DecisionWriter(new FactoryMaskModule(config.maskModule)), job)
  ctx.effect(() => route.register(ctx), 'factory: assess route')
  ctx.logger.info('dsh-superagent-factory serves POST %s for %d project(s)', AssessRoute.PATH, route.projectCount)
  // A review talk's folder is outside every repository; its propose server is the factory's `lib/dist/proposeServer.js`, next to the job log file.
  const talks = new ReviewTalks({ records, tokenFile: tokens.path, words: ReviewPage })
  const review = new ReviewRoute(config.projects ?? [], tokens, records, undefined, talks)
  ctx.effect(() => review.register(ctx), 'factory: review page')
}
export { AssessRoute, StubJudge, TempFactsShape, type AnswerLog, type AssessRequest, type Judge, type TempFacts, type TempPathFact, type TokenSource, type Verdict } from './assess.ts'
export { DecisionsFile, DecisionWriter, FactoryMaskModule, type Decision, type DecisionLine, type DecisionMasker, type MaskSource } from './decisions.ts'
export { GuidelineSection, type GuidelineAgent } from './guideline.ts'
export { FactoryJob, type JobAnswer, type JobGuideline } from './job.ts'
export { MainSessionWatch, type MainSessionJob } from './mainsession.ts'
export { FactoryGuardModule, JudgeSession, JudgeSessions, ReadLedger, type AskedJudge, type GuardSource, type JudgeGuard, type JudgeOpener, type JudgeReply, type JudgeToolCall } from './judge.ts'
export {
  FactoryRecordFile, FactoryRecordsModule, JobRecorder, RecordsRefusal, ReviewWriter, type AutomaticAnswer, type GuidelineRead, type GuidelineSource, type GuidelineVersion, type JobLogKind, type JobLogLine, type JobsSource, type JobStep,
  type ProjectJobs, type ReadJobLog, type RecordedJob, type RecordsMasker, type RecordsReader, type RecordsSource, type ReviewLine, type StepAsked, type StepDetail,
  type StepOutcome, type StepSource, type StepWhy, type TimelineStep,
} from './records.ts'
export { TextDiff, type DiffLine, type DiffMark, type DiffSides } from './diff.ts'
export { JobComments, ReviewAccess, ReviewPage, ReviewRefusal, ReviewRoute, type ReviewTokenSource, type ReviewView } from './review.ts'
export {
  GuidelineProposals, ReviewTalks, TalkComments, TalkFolder, TalkLink, TalkOpening, TalkRefusal, TalkTexts, type GuidelineProposal, type ReviewTalksOptions, type StepWords,
  type TalkServer, type TalkStart, type TalkState,
} from './talk.ts'
export { SharedTokenFile } from './token.ts'
export { TokenTally, type TalliedEvent } from './usage.ts'
export { JudgeAnswer, JudgeQuestion, ModelJudge, UnusableAnswer } from './verdict.ts'
