/**
 * The browser half: the "Review" link at the foot of DSH's sidebar, beside Settings. It opens the factory's review page
 * (`/review`, served by dsh-superagent's factory plugin, which uses DSH's own sign-in) in the same tab.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

/** The locale namespace of this plugin's one word. */
export const NS = 'dshSuperagentReviewLink'
/** The review page on DSH's own web server. */
export const REVIEW_PATH = '/review'
/** The page itself is in English, so the link's word is too, in both languages. */
const TEXT = { reviewLink: 'Review' } as const
export const zh = TEXT, en = TEXT
type ReviewLinkKey = keyof typeof TEXT
type T = (key: ReviewLinkKey) => string

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dshSuperagentReviewLink: ReviewLinkKey }
}

function ReviewIcon({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 3.5h7.5L19 8v12.5H7z" /><path d="M14.5 3.5V8H19" /><path d="M10 12.5h6M10 16h4" />
  </svg>
}

/**
 * The link: a plain `<a href="/review">` in the same tab. The word when the sidebar is wide, an icon with the word as its name on
 * the narrow rail. Styled with DSH's own design tokens, like the sidebar's own rows.
 */
export function ReviewLink({ wide, t }: SidebarFooterActionOwnerProps & { t: T }) {
  const label = t('reviewLink')
  const look = { display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', textDecoration: 'none',
    borderRadius: 'var(--dsw-radius-md)', ...(wide ? { flex: 1, minHeight: 36, margin: '0 2px', padding: '7px 8px', lineHeight: '22px' } : { width: 36, height: 36, justifyContent: 'center' }) } as const
  return <a href={REVIEW_PATH} style={look} aria-label={wide ? undefined : label} title={wide ? undefined : label}>
    <ReviewIcon size={18} />{wide ? <span>{label}</span> : null}
  </a>
}

export const inject = ['slots', 'locale']
/** Registers the word and the link in the sidebar's `sidebar.footer.action` slot. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent-review-link: dictionaries')
  const t = ctx.locale.bind(NS) as T
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-superagent-review', order: 10, label: () => t('reviewLink'), locale: NS },
    (props: SidebarFooterActionOwnerProps & { t: T }) => <ReviewLink wide={props.wide} t={props.t} />))
}
