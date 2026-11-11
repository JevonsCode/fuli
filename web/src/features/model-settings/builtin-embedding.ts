import { z } from 'zod'

import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

// Built-in embedding models (src/embedding-models/port.js): small models FULI
// downloads and runs on this computer, so 语义搜索 needs no model service.
const download = z.looseObject({
  status: z.enum(['downloading', 'failed']), receivedBytes: z.number(), totalBytes: z.number(), reason: z.string().nullable(),
})
const model = z.looseObject({
  id: z.string(),
  name: z.string(),
  summary: z.looseObject({ zh: z.string(), en: z.string() }),
  languages: z.array(z.string()),
  license: z.string(),
  source: z.string(),
  dimensions: z.number(),
  memoryMb: z.number(),
  recommended: z.boolean(),
  downloadBytes: z.number(),
  installed: z.boolean(),
  outdated: z.boolean(),
  inUse: z.boolean(),
  download: download.nullable(),
})
const list = z.looseObject({ inUse: z.string().nullable(), models: z.array(model), retired: z.array(z.string()) })
const models = shapeOf(list)

export type BuiltinDownload = z.infer<typeof download>
export type BuiltinModel = z.infer<typeof model>
export type BuiltinModels = z.infer<typeof list>

const BASE = '/api/embedding-models'
export const readBuiltinModels = (signal?: AbortSignal) => getJson(BASE, models, { signal })
// Answers at once; the list says how far the download is. Search uses the model once it is whole.
export const downloadBuiltinModel = (id: string) => postJson(`${BASE}/download`, { id, use: true }, models)
export const useBuiltinModel = (id: string) => postJson(`${BASE}/use`, { id }, models)
export const removeBuiltinModel = (id: string) => postJson(`${BASE}/remove`, { id }, models)

export const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)))
export const downloadPercent = (state: BuiltinDownload) =>
  (state.totalBytes > 0 ? Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100)) : 0)

// Why a download was not kept, in the person's words.
const FAILURES: Record<string, string> = {
  embedding_model_altered: 'modelSettings.builtin.failedAltered',
  // The disk refused the file (src/embedding-models/store.js); not the network.
  embedding_model_not_written: 'modelSettings.builtin.failedNotWritten',
}
export const downloadFailure = (reason: string | null) => t(FAILURES[reason ?? ''] ?? 'modelSettings.builtin.failedUnavailable')
