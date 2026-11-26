/** Factory plugin entry: mounts the `/assess` route the factory's hooks ask for a decision. It runs on its own, without the main plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import s from '@deepseek-ai/schemastery'
import { AssessRoute, StubJudge } from './assess.ts'
import { DecisionWriter, FactoryMaskModule } from './decisions.ts'
import { SharedTokenFile } from './token.ts'

export const name = 'dsh-superagent-factory'
export const inject = ['webServer']
/** Plugin configuration of the dsh-superagent-factory entry. */
export const Config = s.object({
  projects: s.array(s.string().pattern(/^\//)).default([])
    .description('Projects the route may write a decision into. Absolute paths; a project must already have its .factory folder.'),
  tokenFile: s.string().pattern(/^\//).default(SharedTokenFile.DEFAULT_PATH)
    .description('The file that holds the token shared with the factory. Absolute path; the file must be readable by its owner only (mode 0600).'),
  maskModule: s.string().pattern(/^\//)
    .description('The factory\'s built mask file, lib/dist/decisionMask.js in the factory\'s folder. Absolute path, no default; every decision is masked with it before it is written, and without it the route answers 503.'),
})
export type FactoryConfig = ReturnType<typeof Config>
export function apply(ctx: Context, config: FactoryConfig): void {
  const route = new AssessRoute(config.projects ?? [], new SharedTokenFile(config.tokenFile ?? SharedTokenFile.DEFAULT_PATH), new StubJudge(), undefined,
    new DecisionWriter(new FactoryMaskModule(config.maskModule)))
  ctx.effect(() => route.register(ctx), 'factory: assess route')
  ctx.logger.info('dsh-superagent-factory serves POST %s for %d project(s)', AssessRoute.PATH, route.projectCount)
}
export { AssessRoute, StubJudge, type TokenSource } from './assess.ts'
export { DecisionsFile, DecisionWriter, FactoryMaskModule, type Decision, type DecisionLine, type DecisionMasker, type MaskSource } from './decisions.ts'
export { SharedTokenFile } from './token.ts'
