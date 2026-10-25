import { t } from '@/i18n'
import { CONSOLE_SESSION_HEADER, consoleSessionToken, isConsoleSessionRefusal, noteConsoleSession } from './console-session'

export class ApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(message: string, status: number, detail = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/** Only the recovery gate's explicit 503 code receives recovery guidance. */
export function isKnowledgeRecoveryPending(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 503
    || !('detail' in error) || typeof error.detail !== 'string') return false
  try { return JSON.parse(error.detail)?.code === 'knowledge_recovery_pending' } catch { return false }
}

// The page's own line; the shell's notice (AppShell.vue) says what to do.
function consoleSessionMessage(): string {
  return t('common.errors.consoleSessionRequired')
}

// Every request carries the console session token when this origin holds one
// (rec#11 D-61); a same-origin header needs no CORS.
function withConsoleSession(init?: RequestInit): RequestInit | undefined {
  const token = consoleSessionToken()
  if (!token) return init
  return { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), [CONSOLE_SESSION_HEADER]: token } }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, withConsoleSession(init))
  if (!response.ok) {
    const detail = (await response.text()).trim()
    const sessionRefused = isConsoleSessionRefusal(response.status, detail)
    if (sessionRefused) noteConsoleSession(url, true)
    const message = sessionRefused ? consoleSessionMessage()
      : isKnowledgeRecoveryPending({ status: response.status, detail })
      ? t('common.errors.knowledgeRecoveryPending') : response.status >= 500
      ? t('common.errors.serviceUnavailable', { status: response.status })
      : detail || t('common.errors.requestFailed', { status: response.status })
    throw new ApiError(message, response.status, detail)
  }
  noteConsoleSession(url, false)
  return response.json() as Promise<T>
}

// The API's own { "code": "…" } for a request it refused, else null.
export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.detail) return null
  try {
    const code = (JSON.parse(error.detail) as { code?: unknown })?.code
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

// Why a request failed, in words: the API's own { "error": "…" } text for a
// request it refused, otherwise the error's message.
export function apiErrorReason(error: unknown, fallback = t('common.errors.operationFailed')): string {
  if (isKnowledgeRecoveryPending(error)) return t('common.errors.knowledgeRecoveryPending')
  if (error instanceof ApiError && isConsoleSessionRefusal(error.status, error.detail)) return consoleSessionMessage()
  if (error instanceof ApiError && error.status < 500 && error.detail) {
    try {
      const reason = (JSON.parse(error.detail) as { error?: unknown })?.error
      if (typeof reason === 'string' && reason) return reason
    } catch { /* A plain-text answer is already the message. */ }
  }
  return error instanceof Error && error.message ? error.message : fallback
}

export function getJson<T>(
  url: string,
  init?: Pick<RequestInit, 'signal'>,
): Promise<T> {
  return requestJson<T>(url, init)
}

export function postJson<T>(url: string, body: unknown, init?: Pick<RequestInit, 'signal'>): Promise<T> {
  return requestJson<T>(url, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function putJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function patchJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteJson<T>(url: string, body?: unknown): Promise<T> {
  return requestJson<T>(url, body === undefined ? { method: 'DELETE' } : {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
