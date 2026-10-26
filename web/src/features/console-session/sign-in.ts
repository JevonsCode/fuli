import { postJson } from '@/api/client'
import { storeConsoleSessionToken } from '@/api/console-session'

export const SIGN_IN_PAGE_PATH = '/auth/console'

export type SignInOutcome = { status: 'signed_in'; next: string } | { status: 'failed'; reason: 'missing' | 'refused' | 'unavailable' }

// The console's sign-in page (rec#11 D-61). `fuli open` opens an owner-only
// file that sends the browser here with the one-time code in the fragment,
// which no server ever sees. The code leaves the address bar at once; the
// page redeems it with a same-origin request (another origin's is refused),
// keeps the session token in this origin's storage, and goes on to the
// landing path the console kept with the code.
export async function signInFromFragment({
  location = window.location,
  history = window.history,
  fetchImpl = (input, init) => fetch(input, init),
}: { location?: Pick<Location, 'hash' | 'origin'>; history?: Pick<History, 'replaceState'>; fetchImpl?: typeof fetch } = {}): Promise<SignInOutcome> {
  const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('code')
  history.replaceState(null, '', SIGN_IN_PAGE_PATH)
  if (!code) return { status: 'failed', reason: 'missing' }
  let answer: Response
  try {
    answer = await fetchImpl('/api/console-session/sign-in', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    })
  } catch {
    return { status: 'failed', reason: 'unavailable' }
  }
  if (!answer.ok) return { status: 'failed', reason: 'refused' }
  const { next, token } = await answer.json() as { next?: unknown; token?: unknown }
  if (typeof token !== 'string' || !storeConsoleSessionToken(token)) return { status: 'failed', reason: 'unavailable' }
  return { status: 'signed_in', next: sameOriginPath(next, location.origin) }
}

// The sign-in button (rec#11 D-69): the console opens its sign-in page in this
// computer's browser, landing on next. The answer holds no code; the code
// reaches the browser the same way `fuli open` hands it over.
export function openSignIn(next: string): Promise<{ status: 'opened' }> {
  return postJson('/api/console-session/open', { next })
}

// Replaces the sign-in page in the history, so Back never returns to it.
export function landOn(path: string): void {
  window.location.replace(path)
}

// The console checked the path; this keeps a wrong answer from leaving the origin.
function sameOriginPath(next: unknown, origin: string): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/'
  const url = new URL(next, origin)
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : '/'
}
