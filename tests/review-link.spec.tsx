// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { apply, en, inject, NS } from '../packages/review-link/src/client.tsx'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: keyof typeof en) => en[key]) as never
const ROOT = join(import.meta.dirname, '..', 'packages', 'review-link')

function fixture() {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { effect() },
  }
  apply(ctx as never)
  return { entries, dictionaries }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}

it('registers only the "Review" link at the foot of DSH\'s sidebar, with its own word, and needs only slots and locale', () => {
  const { entries, dictionaries } = fixture()
  expect(inject).toEqual(['slots', 'locale'])
  expect(entries.map(entry => entry.options.name)).toEqual(['sidebar.footer.action'])
  expect(entries[0]!.options).toMatchObject({ id: 'dsh-superagent-review', order: 10, locale: NS })
  expect(entries[0]!.options.label?.()).toBe('Review')
  expect(Object.keys(dictionaries)).toEqual([NS])
})

it('puts a "Review" link to /review at the foot of DSH\'s sidebar, the word when wide and an icon named by it on the rail, opening in the same tab', async () => {
  const [link] = fixture().entries
  const wide = await render(link!, { wide: true, t })
  const anchor = wide.container.querySelector('a')!
  expect([anchor.getAttribute('href'), anchor.getAttribute('target'), anchor.textContent, anchor.getAttribute('aria-label')]).toEqual(['/review', null, 'Review', null])
  wide.dispose()
  const rail = await render(link!, { wide: false, t })
  const icon = rail.container.querySelector('a')!
  expect([icon.getAttribute('href'), icon.getAttribute('target'), icon.textContent, icon.getAttribute('aria-label'), icon.querySelector('svg') !== null])
    .toEqual(['/review', null, '', 'Review', true])
  rail.dispose()
})

it('declares a web client and a bundle layer that inserts its root row, so DSH serves the link for an enabled row', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; exports: Record<string, string>; dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } } }
  expect(pkg.name).toBe('dsh-superagent-review-link')
  expect(pkg.exports['./client']).toBe('./lib/client.js')
  expect(pkg.dsh.client.platform).toBe('web')
  expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar')
  // DSH serves a client only for an enabled row named by the bare package name, so the row must be the package root.
  expect(readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8')).toMatch(/^- insert:\n {4}- id: dsh-superagent-review-link\n {6}name: dsh-superagent-review-link$/m)
})
