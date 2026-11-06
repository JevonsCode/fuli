import { z } from 'zod'

import { postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'
import { validKeyReference, type ModelProtocol } from './model'

// Which models the endpoint typed in the dialog lists (src/model-backends/
// models-http.js), before anything is saved. The server reads the key named
// by secretRef itself; the page never holds it.

export interface ModelListRequest { protocol: ModelProtocol; endpoint: string; secretRef?: string }

const MODEL_LIST = shapeOf(z.looseObject({ models: z.array(z.looseObject({ id: z.string() })), source: z.string() }))

export const listEndpointModels = (request: ModelListRequest, signal?: AbortSignal) =>
  postJson('/api/model-backends/models', request, MODEL_LIST, { signal })

// What the dialog can ask about: an http(s) address, and the key name only when the server would accept it.
export function modelListRequest(protocol: ModelProtocol, endpoint: string, secretRef: string): ModelListRequest | null {
  const address = endpoint.trim()
  let url: URL
  try { url = new URL(address) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const reference = secretRef.trim()
  return { protocol, endpoint: address, ...(validKeyReference(reference) ? { secretRef: reference } : {}) }
}

// 语义搜索 wants a model that turns text into vectors, which names itself
// "embed"; a chat role wants the others. Each group keeps the server's order.
export function orderModels(ids: readonly string[], semantic: boolean): string[] {
  const embeds = (id: string) => /embed/i.test(id)
  return [...ids.filter(id => embeds(id) === semantic), ...ids.filter(id => embeds(id) !== semantic)]
}

const LIST_REASONS = ['network', 'timeout', 'auth_failed', 'missing_key', 'model_or_endpoint_not_found', 'endpoint_redirected',
  'listing_unsupported', 'invalid_response'] as const

export const modelListReason = (code: string | null) =>
  t(`modelSettings.modelList.reasons.${LIST_REASONS.find(known => known === code) ?? 'other'}`)
