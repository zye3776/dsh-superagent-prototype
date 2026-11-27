/**
 * Holds the approvals a worker asked for before it acted ("ask first"), until the factory's hook claims them.
 * A worker posts its action to `/ask`; when the judge approves, the approval is held here under the request's key, the factory's own `request_key`
 * (a hash of the session id, the tool and its input). When the same call then reaches the factory's hook, the hook posts that key to `/claim` and gets
 * the approval's `decision_id` back, with no second model call.
 * An approval is handed out once, only to the same session and project, and only until it expires. It lives in this process's memory and nowhere
 * else: nothing is written to a file, so a restart drops every held approval and the hook then asks `/assess` as before.
 * When the real call is decided through `/assess` after all (the hook's claim came before the ask was answered), that decision settles the request:
 * `settle` drops the approval held for it and remembers the key for a while, so an ask that started before the decision holds nothing when its
 * approve comes back late. Without this, the same call sent again would be allowed on the older approval.
 * This file imports nothing, so the factory's contract test can run it with Node straight from source.
 */

/** What identifies the request an approval is for: the factory's key, and the session and project that asked. */
export interface ApprovalClaim { request_key: string; session_id: string; project: string }
/** An approval to hold: the request it is for, and the id of the judge's decision that approved it. */
export interface HeldApproval extends ApprovalClaim { decision_id: string }

/**
 * Keeps approved asks, one for each request key, each for `seconds` seconds.
 * At most `max` are held: when one more comes, the oldest is dropped, so a worker that asks without end cannot fill the memory.
 */
export class PendingApprovals {
  static readonly DEFAULT_SECONDS = 120
  static readonly MIN_SECONDS = 1
  static readonly MAX_SECONDS = 600
  static readonly MAX_HELD = 1000
  /**
   * How long a settled key is remembered, in seconds. It only bounds memory: an ask cannot take longer than the judge's time limit (120 seconds),
   * so a record older than this can no longer stop any ask.
   * It is not the only limit: the records also share the cap `max`, and a record can be dropped for room long before it is this old (see `settle`).
   */
  static readonly SETTLED_SECONDS = PendingApprovals.MAX_SECONDS
  /** Kept in the order they were held, so the first entry is the oldest. `expires` is in milliseconds, as `now()` counts them. */
  private readonly held = new Map<string, HeldApproval & { expires: number }>()
  /**
   * The requests decided on the real call, one record for each key, in the order they were settled, so the first entry is the oldest.
   * `seq` is the count of `settle` calls when this one was made; `at` is in milliseconds, as `now()` counts them. At most `max` are kept.
   */
  private readonly settled = new Map<string, { session_id: string; project: string; seq: number; at: number }>()
  /** How many times `settle` has run. A count and not a clock reading, so two events in the same millisecond still have an order. */
  private seq = 0
  constructor(readonly seconds: number = PendingApprovals.DEFAULT_SECONDS, private readonly now: () => number = () => Date.now(),
    private readonly max: number = PendingApprovals.MAX_HELD) {
    if (!Number.isInteger(seconds) || seconds < PendingApprovals.MIN_SECONDS || seconds > PendingApprovals.MAX_SECONDS) {
      throw new Error(`dsh-superagent-factory approvalSeconds must be ${PendingApprovals.MIN_SECONDS} to ${PendingApprovals.MAX_SECONDS}: ${seconds}`)
    }
    if (!Number.isInteger(max) || max < 1) throw new Error(`PendingApprovals needs room for at least one approval: ${max}`)
  }
  /** How many approvals are held right now, expired ones included until the next `hold` or their own `claim` drops them. */
  get size(): number { return this.held.size }
  /** How many settled keys are remembered right now. */
  get settledCount(): number { return this.settled.size }

  /** The current point in the order of settlements. An ask takes it before its judge is asked and gives it to `hold` as `since`. */
  mark(): number { return this.seq }

  /**
   * Records that this request was decided on the real call: the approval held for its key is dropped when it is for the same session and project
   * (one held for another session or project stays, as in `claim`), and the key is remembered, so `hold` refuses an approve of an ask that
   * started before this moment. The newest record for a key replaces the older one. Records past `SETTLED_SECONDS` are dropped first, then the
   * oldest ones while there is no room.
   * The trade-off of the cap: when there is no room the oldest record goes whatever its age. So if more than `max` other keys are settled while
   * one ask is still with the judge, the record of that ask's key is forgotten, and its late approve is held again as before this record existed.
   * That keeps the memory bounded, at the price of this one rare case.
   */
  settle(claim: ApprovalClaim): void {
    const now = this.now()
    const entry = this.held.get(claim.request_key)
    if (entry && entry.session_id === claim.session_id && entry.project === claim.project) this.held.delete(claim.request_key)
    for (const [key, record] of this.settled) if (record.at + PendingApprovals.SETTLED_SECONDS * 1000 <= now) this.settled.delete(key)
    // Deleted first, so the new record goes to the end of the order and counts as the newest.
    this.settled.delete(claim.request_key)
    while (this.settled.size >= this.max) {
      const oldest = this.settled.keys().next()
      if (oldest.done) break
      this.settled.delete(oldest.value)
    }
    this.seq += 1
    this.settled.set(claim.request_key, { session_id: claim.session_id, project: claim.project, seq: this.seq, at: now })
  }

  /**
   * Holds one approval and returns the moment it expires. An approval already held for the same key is replaced: the newer decision counts.
   * Expired approvals are dropped first, then the oldest ones while there is no room.
   * With `since` (a value `mark()` gave when the ask started), nothing is held and `undefined` is returned when the same key was settled for the
   * same session and project after that mark: the real call was decided in the meantime, so this approve is for a call that is already over.
   * Without `since` the approval is always held.
   */
  hold(approval: HeldApproval, since?: number): Date | undefined {
    const record = since === undefined ? undefined : this.settled.get(approval.request_key)
    if (record && since !== undefined && record.seq > since && record.session_id === approval.session_id && record.project === approval.project) return undefined
    const now = this.now()
    for (const [key, entry] of this.held) if (entry.expires <= now) this.held.delete(key)
    // Deleted first, so the new entry goes to the end of the order and counts as the newest.
    this.held.delete(approval.request_key)
    while (this.held.size >= this.max) {
      const oldest = this.held.keys().next()
      if (oldest.done) break
      this.held.delete(oldest.value)
    }
    const expires = now + this.seconds * 1000
    this.held.set(approval.request_key, { request_key: approval.request_key, session_id: approval.session_id, project: approval.project,
      decision_id: approval.decision_id, expires })
    return new Date(expires)
  }

  /**
   * Hands out the approval held for exactly this request, once: returns its `decision_id` and forgets it, or returns `undefined` when there is none.
   * It matches only the same key, the same session and the same project, and only before the approval expires. An expired approval is dropped; one held
   * for another session or project stays, because the claim was not for it.
   */
  claim(claim: ApprovalClaim): string | undefined {
    const entry = this.held.get(claim.request_key)
    if (!entry) return undefined
    if (entry.expires <= this.now()) { this.held.delete(claim.request_key); return undefined }
    if (entry.session_id !== claim.session_id || entry.project !== claim.project) return undefined
    this.held.delete(claim.request_key)
    return entry.decision_id
  }
}
