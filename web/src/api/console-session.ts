import { computed, ref } from 'vue'

const CONSOLE_SESSION_REQUIRED = 'console_session_required'

// The API paths that answered 401 console_session_required (rec#11 D-61):
// full history needs a signed-in console session. A later success on the
// same path (this browser now carries the session) clears it. Nothing here
// redirects or retries.
const refusedPaths = ref<ReadonlySet<string>>(new Set())

export const consoleSessionRequired = computed(() => refusedPaths.value.size > 0)

function pathOf(url: string): string {
  return new URL(url, 'http://console.invalid').pathname
}

export function noteConsoleSession(url: string, refused: boolean): void {
  const path = pathOf(url)
  if (refused === refusedPaths.value.has(path)) return
  const next = new Set(refusedPaths.value)
  if (refused) next.add(path)
  else next.delete(path)
  refusedPaths.value = next
}

export function isConsoleSessionRefusal(status: number, detail: string): boolean {
  if (status !== 401 || !detail) return false
  try { return JSON.parse(detail)?.code === CONSOLE_SESSION_REQUIRED } catch { return false }
}

// The session token the sign-in page received (rec#11 D-61). It lives in this
// origin's storage, which another port of the host cannot read, unlike the
// session cookie; every request sends it as a header. When storage cannot be
// used there is no token, the protected reads are refused and the shell shows
// the sign-in notice.
const TOKEN_KEY = 'fuli.consoleSession'
export const CONSOLE_SESSION_HEADER = 'x-fuli-console-session'

export function consoleSessionToken(): string | null {
  try { return window.localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function storeConsoleSessionToken(token: string): boolean {
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
    return true
  } catch {
    return false
  }
}

// Only the console on the computer running FULI can be signed in; a LAN
// device is never offered a sign-in.
export function isLocalConsoleHost(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)
}

// Runs once this origin receives a session token from another tab: the sign-in
// page the console opened stored it. Returns the unsubscribe.
export function onConsoleSessionStored(run: () => void): () => void {
  const listener = (event: StorageEvent) => { if (event.key === TOKEN_KEY && event.newValue) run() }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}
