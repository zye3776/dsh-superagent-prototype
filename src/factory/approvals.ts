/**
 * Holds the approvals a worker asked for before it acted ("ask first"), until the factory's hook claims them.
 * A worker posts its action to `/ask`; when the judge approves, the approval is held here under the request's key, the factory's own `request_key`
 * (a hash of the session id, the tool and its input). When the same call then reaches the factory's hook, the hook posts that key to `/claim` and gets
 * the approval's `decision_id` back, with no second model call.
 * An approval is handed out once, only to the same session and project, and only until it expires. It lives in this process's memory and nowhere
 * else: nothing is written to a file, so a restart drops every held approval and the hook then asks `/assess` as before.
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
  /** Kept in the order they were held, so the first entry is the oldest. `expires` is in milliseconds, as `now()` counts them. */
  private readonly held = new Map<string, HeldApproval & { expires: number }>()
  constructor(readonly seconds: number = PendingApprovals.DEFAULT_SECONDS, private readonly now: () => number = () => Date.now(),
    private readonly max: number = PendingApprovals.MAX_HELD) {
    if (!Number.isInteger(seconds) || seconds < PendingApprovals.MIN_SECONDS || seconds > PendingApprovals.MAX_SECONDS) {
      throw new Error(`dsh-superagent-factory approvalSeconds must be ${PendingApprovals.MIN_SECONDS} to ${PendingApprovals.MAX_SECONDS}: ${seconds}`)
    }
    if (!Number.isInteger(max) || max < 1) throw new Error(`PendingApprovals needs room for at least one approval: ${max}`)
  }
  /** How many approvals are held right now, expired ones included until the next `hold` or their own `claim` drops them. */
  get size(): number { return this.held.size }

  /**
   * Holds one approval and returns the moment it expires. An approval already held for the same key is replaced: the newer decision counts.
   * Expired approvals are dropped first, then the oldest ones while there is no room.
   */
  hold(approval: HeldApproval): Date {
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
   * Forgets the approval held for this key, if any: a newer decision on the same call that is not an approve (a deny, or a hand-over to the
   * owner) takes back the older approve, so the newest decision always counts.
   */
  release(requestKey: string): void { this.held.delete(requestKey) }

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
