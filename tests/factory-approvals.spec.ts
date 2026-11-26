/** `PendingApprovals`: the approvals a worker asked for before acting, held in memory until the factory's hook claims them. */
import { expect, it } from 'vitest'
import { PendingApprovals } from '../src/factory/approvals.ts'

const approval = (fields: Record<string, string> = {}) => ({ request_key: 'k1', session_id: 's1', project: '/p', decision_id: 'd1', ...fields })
const claim = (fields: Record<string, string> = {}) => ({ request_key: 'k1', session_id: 's1', project: '/p', ...fields })

it('hands a held approval out once, to exactly the request it is for', () => {
  const approvals = new PendingApprovals()
  expect(approvals.claim(claim())).toBeUndefined()
  approvals.hold(approval())
  expect(approvals.size).toBe(1)
  // Another key, another session, another project: no match, and the approval stays.
  const others: Record<string, string>[] = [{ request_key: 'k2' }, { session_id: 's2' }, { project: '/q' }]
  for (const other of others) expect(approvals.claim(claim(other)), JSON.stringify(other)).toBeUndefined()
  expect(approvals.size).toBe(1)
  expect(approvals.claim(claim())).toBe('d1')
  expect(approvals.size).toBe(0)
  expect(approvals.claim(claim())).toBeUndefined()
})

it('holds an approval for its seconds and no longer, and says when it expires', () => {
  let now = 5_000
  const approvals = new PendingApprovals(10, () => now)
  expect(approvals.hold(approval()).getTime()).toBe(15_000)
  now = 14_999
  expect(approvals.claim(claim())).toBe('d1')
  approvals.hold(approval())
  now = 24_999
  // At the moment of expiry it is gone, and it does not come back when the clock steps back.
  expect(approvals.claim(claim())).toBeUndefined()
  expect(approvals.size).toBe(0)
  now = 0
  expect(approvals.claim(claim())).toBeUndefined()
})

it('defaults to 120 seconds and refuses a time outside 1 to 600 seconds', () => {
  expect(new PendingApprovals().seconds).toBe(120)
  expect([new PendingApprovals(1).seconds, new PendingApprovals(600).seconds]).toEqual([1, 600])
  for (const seconds of [0, 0.5, 601, Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(() => new PendingApprovals(seconds), String(seconds)).toThrow('approvalSeconds')
  for (const max of [0, 1.5, -1]) expect(() => new PendingApprovals(120, () => 0, max), String(max)).toThrow('room')
})

it('replaces the approval of the same key with the newer one, with a new expiry', () => {
  let now = 0
  const approvals = new PendingApprovals(10, () => now)
  approvals.hold(approval())
  now = 9_000
  approvals.hold(approval({ decision_id: 'd2' }))
  expect(approvals.size).toBe(1)
  now = 18_999
  expect(approvals.claim(claim())).toBe('d2')
})

it('holds at most its cap: expired approvals go first, then the oldest', () => {
  let now = 0
  const approvals = new PendingApprovals(10, () => now, 3)
  approvals.hold(approval({ request_key: 'a', decision_id: 'da' }))
  now = 5_000
  for (const key of ['b', 'c']) approvals.hold(approval({ request_key: key, decision_id: `d${key}` }))
  // `a` has expired: it makes room, and nothing else is dropped.
  now = 10_000
  approvals.hold(approval({ request_key: 'd', decision_id: 'dd' }))
  expect(approvals.size).toBe(3)
  // Full, and nothing expired: the oldest (`b`) is dropped. Holding `c` again first makes it the newest.
  approvals.hold(approval({ request_key: 'c', decision_id: 'dc2' }))
  approvals.hold(approval({ request_key: 'e', decision_id: 'de' }))
  approvals.hold(approval({ request_key: 'f', decision_id: 'df' }))
  expect(approvals.size).toBe(3)
  expect(['a', 'b', 'c', 'd', 'e', 'f'].map(key => approvals.claim(claim({ request_key: key })))).toEqual([undefined, undefined, 'dc2', undefined, 'de', 'df'])
})

it('takes back a held approval for its key when told to, and accepts only whole seconds', () => {
  const approvals = new PendingApprovals(60, () => 1_000)
  approvals.hold({ request_key: 'k1', session_id: 's1', project: '/p', decision_id: 'd1' })
  approvals.release('k1')
  approvals.release('k-unknown')
  expect(approvals.claim({ request_key: 'k1', session_id: 's1', project: '/p' })).toBeUndefined()
  expect(() => new PendingApprovals(1.5)).toThrow()
})
