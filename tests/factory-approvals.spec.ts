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
  expect(approvals.hold(approval())?.getTime()).toBe(15_000)
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

it('accepts only whole seconds, and offers no way to take back a held approval but its claim, its expiry or a decision on the real call', () => {
  expect(() => new PendingApprovals(1.5)).toThrow()
  // A later ask that is not an approve must not cancel an approval held for the call, so there is nothing that releases one.
  expect('release' in new PendingApprovals(60)).toBe(false)
})

it('drops the held approval of a settled request, and only for the same key, session and project', () => {
  const approvals = new PendingApprovals()
  approvals.hold(approval())
  // Another key, another session, another project: the approval stays.
  const others: Record<string, string>[] = [{ request_key: 'k2' }, { session_id: 's2' }, { project: '/q' }]
  for (const other of others) approvals.settle(claim(other))
  expect(approvals.size).toBe(1)
  expect(approvals.claim(claim())).toBe('d1')
  approvals.hold(approval())
  approvals.settle(claim())
  expect(approvals.size).toBe(0)
  expect(approvals.claim(claim())).toBeUndefined()
  // Settling a key nothing is held for is no error.
  expect(() => approvals.settle(claim({ request_key: 'never-held' }))).not.toThrow()
})

it('holds nothing for an ask that started before its request was settled, and holds as before for one that started after', () => {
  // The clock never moves: only the count of settlements orders the events.
  const approvals = new PendingApprovals(10, () => 1_000)
  const before = approvals.mark()
  approvals.settle(claim())
  expect(approvals.mark()).toBeGreaterThan(before)
  expect(approvals.hold(approval(), before)).toBeUndefined()
  expect(approvals.size).toBe(0)
  expect(approvals.claim(claim())).toBeUndefined()
  // An ask that starts after the settlement is a new ask for a new call.
  expect(approvals.hold(approval({ decision_id: 'd2' }), approvals.mark())?.getTime()).toBe(11_000)
  expect(approvals.claim(claim())).toBe('d2')
  // Without a mark, the approval is always held.
  expect(approvals.hold(approval({ decision_id: 'd3' }))?.getTime()).toBe(11_000)
  expect(approvals.claim(claim())).toBe('d3')
})

it('lets a settlement stop only asks of the same key, session and project', () => {
  const approvals = new PendingApprovals()
  const before = approvals.mark()
  approvals.settle(claim())
  const others: Record<string, string>[] = [{ request_key: 'k2' }, { session_id: 's2' }, { project: '/q' }]
  for (const other of others) {
    expect(approvals.hold(approval(other), before), JSON.stringify(other)).toBeInstanceOf(Date)
    expect(approvals.claim(claim(other)), JSON.stringify(other)).toBe('d1')
  }
})

it('remembers at most its cap of settled keys, and none past the horizon', () => {
  let now = 0
  const approvals = new PendingApprovals(10, () => now, 2)
  const before = approvals.mark()
  for (const key of ['a', 'b', 'c']) approvals.settle(claim({ request_key: key }))
  // `a` was the oldest and made room: its record is gone, the other two still stop a late approve.
  expect(approvals.settledCount).toBe(2)
  expect(approvals.hold(approval({ request_key: 'b' }), before)).toBeUndefined()
  expect(approvals.hold(approval({ request_key: 'c' }), before)).toBeUndefined()
  // Settling `b` again makes it the newest, so `c` goes when `d` comes.
  approvals.settle(claim({ request_key: 'b' }))
  approvals.settle(claim({ request_key: 'd' }))
  expect(approvals.settledCount).toBe(2)
  expect(approvals.hold(approval({ request_key: 'b' }), before)).toBeUndefined()
  expect(approvals.hold(approval({ request_key: 'c' }), before)).toBeInstanceOf(Date)
  // Past the horizon every older record is dropped at the next settlement.
  now = PendingApprovals.SETTLED_SECONDS * 1000
  approvals.settle(claim({ request_key: 'e' }))
  expect(approvals.settledCount).toBe(1)
  expect(PendingApprovals.SETTLED_SECONDS).toBeGreaterThan(120)
})
