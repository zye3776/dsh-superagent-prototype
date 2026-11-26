/**
 * The node half of the "Review" link plugin. It does nothing on the server: the empty `apply` only gives the package a row in
 * DSH's plugin list, and DSH serves the browser half (`./client`, declared by `dsh.client` in package.json) for that row.
 */
export const name = 'dsh-superagent-review-link'

/** No server-side behaviour; the review page itself is served by dsh-superagent's factory plugin. */
export function apply(): void {}
