/**
 * Factory plugin entry: mounts the `/assess` route the factory's hooks ask for a decision, and keeps the read-only judge Sessions that `ModelJudge` asks for each one.
 * It runs on its own, without the main plugin.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import s from '@deepseek-ai/schemastery'
import { PendingApprovals } from './approvals.ts'
import { AssessRoute } from './assess.ts'
import { DecisionWriter, FactoryMaskModule } from './decisions.ts'
import { FactoryGuardModule, JudgeSessions } from './judge.ts'
import { SharedTokenFile } from './token.ts'
import { ModelJudge } from './verdict.ts'

export const name = 'dsh-superagent-factory'
export const inject = ['webServer', 'agents', 'sessionController', 'workspaceRegistry', 'permissionPresets', 'tools']
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
  approvalSeconds: s.number().min(PendingApprovals.MIN_SECONDS).max(PendingApprovals.MAX_SECONDS).step(1).default(PendingApprovals.DEFAULT_SECONDS)
    .description('How long an approval a worker asked for before acting (POST /ask) is held for the factory\'s hook to claim (POST /claim), in seconds. Held in memory only; a restart drops them.'),
})
export type FactoryConfig = ReturnType<typeof Config>
export function apply(ctx: Context, config: FactoryConfig): void {
  const judges = new JudgeSessions(ctx, new FactoryGuardModule(config.guardModule))
  // One global guard, in place before any helper exists: DSH does not give a helper its parent's tool limits, so every helper of a judge is checked here with
  // the factory's strict guard. It answers nothing for any other agent.
  ctx.tools.guard(execution => judges.helperRefusal(execution))
  const route = new AssessRoute(config.projects ?? [], new SharedTokenFile(config.tokenFile ?? SharedTokenFile.DEFAULT_PATH), new ModelJudge(judges), undefined,
    new DecisionWriter(new FactoryMaskModule(config.maskModule)), new PendingApprovals(config.approvalSeconds ?? PendingApprovals.DEFAULT_SECONDS))
  ctx.effect(() => route.register(ctx), 'factory: assess, ask and claim routes')
  ctx.logger.info('dsh-superagent-factory serves POST %s, %s and %s for %d project(s)', AssessRoute.PATH, AssessRoute.ASK_PATH, AssessRoute.CLAIM_PATH, route.projectCount)
}
export { PendingApprovals, type ApprovalClaim, type HeldApproval } from './approvals.ts'
export { AssessRoute, StubJudge, TempFactsShape, type AskRequest, type AssessRequest, type ClaimRequest, type Judge, type TempFacts, type TempPathFact, type TokenSource, type Verdict } from './assess.ts'
export { DecisionsFile, DecisionWriter, FactoryMaskModule, type Decision, type DecisionLine, type DecisionMasker, type MaskSource } from './decisions.ts'
export { DocsLookup, type DocsLookupArgs, type DocumentationBodies, type Fetcher } from './docs.ts'
export { FactoryGuardModule, JudgeSession, JudgeSessions, ReadLedger, type AskedJudge, type GuardSource, type JudgeGuard, type JudgeOpener, type JudgeReply, type JudgeTools, type JudgeToolCall } from './judge.ts'
export { SharedTokenFile } from './token.ts'
export { TokenTally, type TalliedEvent } from './usage.ts'
export { JudgeAnswer, JudgeQuestion, ModelJudge, UnusableAnswer } from './verdict.ts'
