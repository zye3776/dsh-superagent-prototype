/**
 * Factory plugin entry: mounts the `/assess` route the factory's hooks ask for a decision, and keeps the read-only judge Sessions that `ModelJudge` asks for each one.
 * It runs on its own, without the main plugin.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-workspace'
import s from '@deepseek-ai/schemastery'
import { AssessRoute } from './assess.ts'
import { DecisionWriter, FactoryMaskModule } from './decisions.ts'
import { FactoryGuardModule, JudgeSessions } from './judge.ts'
import { SharedTokenFile } from './token.ts'
import { ModelJudge } from './verdict.ts'

export const name = 'dsh-superagent-factory'
export const inject = ['webServer', 'agents', 'sessionController', 'workspaceRegistry', 'permissionPresets']
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
})
export type FactoryConfig = ReturnType<typeof Config>
export function apply(ctx: Context, config: FactoryConfig): void {
  const judges = new JudgeSessions(ctx, new FactoryGuardModule(config.guardModule))
  const route = new AssessRoute(config.projects ?? [], new SharedTokenFile(config.tokenFile ?? SharedTokenFile.DEFAULT_PATH), new ModelJudge(judges), undefined,
    new DecisionWriter(new FactoryMaskModule(config.maskModule)))
  ctx.effect(() => route.register(ctx), 'factory: assess route')
  ctx.logger.info('dsh-superagent-factory serves POST %s for %d project(s)', AssessRoute.PATH, route.projectCount)
}
export { AssessRoute, StubJudge, type AssessRequest, type Judge, type TokenSource, type Verdict } from './assess.ts'
export { DecisionsFile, DecisionWriter, FactoryMaskModule, type Decision, type DecisionLine, type DecisionMasker, type MaskSource } from './decisions.ts'
export { FactoryGuardModule, JudgeSession, JudgeSessions, ReadLedger, type AskedJudge, type GuardSource, type JudgeGuard, type JudgeOpener, type JudgeReply, type JudgeToolCall } from './judge.ts'
export { SharedTokenFile } from './token.ts'
export { TokenTally, type TalliedEvent } from './usage.ts'
export { JudgeAnswer, JudgeQuestion, ModelJudge, UnusableAnswer } from './verdict.ts'
