/** Factory plugin entry: mounts the `/assess` route the factory's hooks ask for a decision. It runs on its own, without the main plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import s from '@deepseek-ai/schemastery'
import { AssessRoute } from './assess.ts'

export const name = 'dsh-superagent-factory'
export const inject = ['webServer']
/** Plugin configuration of the dsh-superagent-factory entry. */
export const Config = s.object({
  projects: s.array(s.string().pattern(/^\//)).default([])
    .description('Projects the route may write a decision into. Absolute paths; a project must already have its .factory folder.'),
})
export type FactoryConfig = ReturnType<typeof Config>
export function apply(ctx: Context, config: FactoryConfig): void {
  const route = new AssessRoute(config.projects ?? [])
  ctx.effect(() => route.register(ctx), 'factory: assess route')
  ctx.logger.info('dsh-superagent-factory serves POST %s for %d project(s)', AssessRoute.PATH, route.projectCount)
}
export { AssessRoute, DecisionsFile, StubJudge, type Decision, type DecisionLine } from './assess.ts'
