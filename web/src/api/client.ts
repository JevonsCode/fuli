import { t } from '@/i18n'

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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const detail = (await response.text()).trim()
    const message = response.status >= 500
      ? t('common.errors.serviceUnavailable', { status: response.status })
      : detail || t('common.errors.requestFailed', { status: response.status })
    throw new ApiError(message, response.status, detail)
  }
  return response.json() as Promise<T>
}

// Why a request failed, in words: the API's own { "error": "…" } text for a
// request it refused, otherwise the error's message.
export function apiErrorReason(error: unknown, fallback = t('common.errors.operationFailed')): string {
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
