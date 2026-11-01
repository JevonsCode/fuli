import { t } from '@/i18n'
import { isResponseShape, mismatchPath, type ResponseShape } from './response-shape'

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

async function requestJson<T>(url: string, init?: RequestInit, shape?: ResponseShape<T>): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const detail = (await response.text()).trim()
    const message = isKnowledgeRecoveryPending({ status: response.status, detail })
      ? t('common.errors.knowledgeRecoveryPending') : response.status >= 500
      ? t('common.errors.serviceUnavailable', { status: response.status })
      : detail || t('common.errors.requestFailed', { status: response.status })
    throw new ApiError(message, response.status, detail)
  }
  const value: unknown = await response.json()
  if (!shape) return value as T
  const checked = shape.schema.safeParse(value)
  if (checked.success) return checked.data as T
  // An answer the console cannot read is one error that names the field, never its value.
  const message = t('common.errors.invalidResponse', { field: mismatchPath(checked.error) })
  throw new ApiError(message, response.status, JSON.stringify({ code: RESPONSE_INVALID, error: message }))
}

/** The code of an answer that did not have the shape the console checks for. */
export const RESPONSE_INVALID = 'response_invalid'

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
  if (error instanceof ApiError && error.status < 500 && error.detail) {
    try {
      const reason = (JSON.parse(error.detail) as { error?: unknown })?.error
      if (typeof reason === 'string' && reason) return reason
    } catch { /* A plain-text answer is already the message. */ }
  }
  return error instanceof Error && error.message ? error.message : fallback
}

type Init = Pick<RequestInit, 'signal'>
const JSON_HEADERS = { 'content-type': 'application/json' }

// Each verb takes an optional ResponseShape (api/response-shape.ts) that checks
// the answer before it is returned. A call without one is an unchecked cast;
// web/src/api/response-validation.spec.ts keeps their number from growing.
export function getJson<T>(url: string, init?: Init): Promise<T>
export function getJson<T>(url: string, shape: ResponseShape<T>, init?: Init): Promise<T>
export function getJson<T>(url: string, shapeOrInit?: ResponseShape<T> | Init, init?: Init): Promise<T> {
  return isResponseShape(shapeOrInit)
    ? requestJson<T>(url, init, shapeOrInit as ResponseShape<T>)
    : requestJson<T>(url, shapeOrInit as Init | undefined)
}

export function postJson<T>(url: string, body: unknown, init?: Init): Promise<T>
export function postJson<T>(url: string, body: unknown, shape: ResponseShape<T>, init?: Init): Promise<T>
export function postJson<T>(url: string, body: unknown, shapeOrInit?: ResponseShape<T> | Init, init?: Init): Promise<T> {
  const shape = isResponseShape(shapeOrInit) ? shapeOrInit as ResponseShape<T> : undefined
  return requestJson<T>(url, { ...(shape ? init : shapeOrInit as Init | undefined), method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, shape)
}

export function putJson<T>(url: string, body: unknown, shape?: ResponseShape<T>): Promise<T> {
  return requestJson<T>(url, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) }, shape)
}

export function patchJson<T>(url: string, body: unknown, shape?: ResponseShape<T>): Promise<T> {
  return requestJson<T>(url, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, shape)
}

export function deleteJson<T>(url: string, body?: unknown, shape?: ResponseShape<T>): Promise<T> {
  return requestJson<T>(url, body === undefined ? { method: 'DELETE' } : { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify(body) }, shape)
}
