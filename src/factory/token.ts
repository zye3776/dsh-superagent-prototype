/**
 * The shared token of the `/assess` route: one secret that the factory and this route both read from the same file on this
 * machine. The factory sends it with each request and the route sends it back with each decision, so each side knows the
 * other is the one set up here. This file mirrors the factory's `lib/sharedToken` and `lib/askKey`; the two repositories share no code.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Reads the token file and compares tokens.
 * The file is usable only when it is a regular file (not a symlink), its mode gives nothing to the group or to others (for
 * example 0600), and it holds one token of at least 32 characters from A-Z a-z 0-9 _ -, with at most one line break after it.
 * Any other state counts as "no token". The file is read again on every call, so a replaced token works without a restart.
 * This class never creates the file: the factory's setup does.
 */
export class SharedTokenFile {
  /** Outside every project, next to the factory's settings file. */
  static readonly DEFAULT_PATH = join(homedir(), '.config', 'zees-factory', 'superagent-token')
  /** The HTTP header that carries the token, in the request and in the 200 reply. */
  static readonly HEADER = 'x-factory-token'
  static readonly MIN_LENGTH = 32
  /** No real token file is near this size; a larger file is refused without being read. */
  private static readonly MAX_FILE_BYTES = 4096
  private static readonly SHAPE = new RegExp(`^[A-Za-z0-9_-]{${SharedTokenFile.MIN_LENGTH},}\\n?$`)

  constructor(readonly path: string = SharedTokenFile.DEFAULT_PATH) {}

  /** The token in the file, or `undefined` when the file is missing or not usable. It never says what the file holds. */
  read(): string | undefined {
    let fd: number
    // NOFOLLOW makes the open fail on a symlink. NONBLOCK keeps a named pipe at this path from hanging the call.
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch { return undefined }
    try {
      // The checks run on the opened file, so the file cannot be swapped between the check and the read.
      const stat = fstatSync(fd)
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > SharedTokenFile.MAX_FILE_BYTES) return undefined
      const bytes = Buffer.alloc(SharedTokenFile.MAX_FILE_BYTES + 1)
      let length = 0
      for (;;) {
        const got = readSync(fd, bytes, length, bytes.length - length, null)
        if (got === 0) break
        length += got
        if (length === bytes.length) return undefined
      }
      const text = bytes.toString('utf8', 0, length)
      if (!SharedTokenFile.SHAPE.test(text)) return undefined
      return text.endsWith('\n') ? text.slice(0, -1) : text
    } catch { return undefined } finally { closeSync(fd) }
  }

  /**
   * Whether two tokens are the same, in a time that does not depend on where they differ.
   * Both are hashed first, so the compared values always have the same length and the length of the real token leaks nothing.
   */
  static same(a: string, b: string): boolean {
    const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest()
    return timingSafeEqual(hash(a), hash(b))
  }
}

/**
 * The ask key of one worker session: the credential a worker sends with its `/ask`, so a caller cannot ask in another session's name.
 * It is the lowercase hex HMAC-SHA256 of `zees-ask-v1:<session_id>`, keyed with the shared token (trimmed). The factory's session-start hook
 * computes the same key for each session and puts it in that session's environment; this route computes it again from the ask's `session_id`
 * and the token file. Nothing stores it. This mirrors the factory's `lib/askKey`: both sides pin the same test vector.
 */
export class AskKey {
  /** What comes before the session id in the signed text; the version lets a later key scheme tell its keys apart. */
  static readonly PREFIX = 'zees-ask-v1:'
  /** The HTTP header of an `/ask` request that carries the key. */
  static readonly HEADER = 'x-zees-ask-key'

  /** The key of `sessionId` under the shared `token`, as 64 lowercase hex characters. */
  static compute(token: string, sessionId: string): string {
    return createHmac('sha256', token.trim()).update(AskKey.PREFIX + sessionId, 'utf8').digest('hex')
  }
}
