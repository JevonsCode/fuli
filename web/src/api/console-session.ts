import { computed, ref } from 'vue'

const CONSOLE_SESSION_REQUIRED = 'console_session_required'

// The API paths that answered 401 console_session_required (rec#11 D-61):
// full history needs the console session `fuli open` starts. A later success
// on the same path (the person ran fuli open, and this browser now carries
// the session) clears it. Nothing here redirects or retries.
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

// The command that signs this browser in and comes back to this page.
// Double quotes work in cmd, PowerShell and POSIX shells alike; the
// characters a shell reads inside them stay percent-encoded.
export function consoleOpenCommand(pageUrl: string): string {
  const url = new URL(pageUrl, 'http://console.invalid')
  const page = `${url.pathname}${url.search}${url.hash}`
  return page === '/' ? 'fuli open' : `fuli open --next "${page.replace(/["$`]/g, encodeURIComponent)}"`
}
