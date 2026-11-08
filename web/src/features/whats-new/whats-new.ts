import { reactive } from 'vue'
import { z } from 'zod'

import { getJson, putJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import type { AppLocale } from '@/i18n'

// What is new in the installed FULI version (src/whats-new/whats-new.js). The
// server keeps whether the console has said so; the console reads it once per
// open and marks it seen as soon as it shows the notice, so it is shown once.

const status = z.looseObject({
  version: z.string(),
  lines: z.looseObject({ zh: z.array(z.string()), en: z.array(z.string()) }).nullable(),
  releaseUrl: z.string(),
  notice: z.looseObject({ skipped: z.number().int().min(0), releasesUrl: z.string() }).nullable(),
})
const statusShape = shapeOf(status)

export type WhatsNewStatus = z.infer<typeof status>

export const whatsNew = reactive({
  // The notice this console open shows: the status that had one, kept after it is marked seen.
  shown: null as WhatsNewStatus | null,
  closed: false,
})

export async function loadWhatsNew() {
  const current = await getJson('/api/system/whats-new', statusShape)
  if (!current.notice || !current.lines) return
  whatsNew.shown = current
  // Shown once: a failed mark only means it shows again next time.
  await putJson('/api/system/whats-new/seen', { version: current.version }, statusShape).catch(() => undefined)
}

export const linesFor = (current: WhatsNewStatus, locale: AppLocale) =>
  current.lines ? (locale === 'en-US' ? current.lines.en : current.lines.zh) : []
