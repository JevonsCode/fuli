import { z } from 'zod'
import { shapeOf } from '@/api/response-shape'
import { roleName, type ModelRoleId } from '@/features/model-settings/model'
import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import type { IconName } from '@/ui/icons'

// 「最近你可能需要知道的事」 (src/notices/recent-notices.js): the record the
// server sends and how the console words it. The workbench card and the
// list's own page (/workbench/notices) share it.
const notice = z.looseObject({ id: z.string(), kind: z.string(), at: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])), href: z.string() })
export const noticePageShape = shapeOf(z.looseObject({ items: z.array(notice), total: z.number().optional(), nextCursor: z.string().nullable().optional() }))
export type Notice = z.infer<typeof notice>

export const NOTICE_ICONS: Record<string, IconName> = {
  topic_promoted: 'project', dreaming_found: 'memory', dreaming_stopped: 'warning', retrospective_ready: 'memory', tonborg_confirmed: 'check',
  fla_joined: 'agents', fla_left: 'agents', delegated_change: 'settings', model_failing: 'error', update_available: 'refresh',
}
export const NOTICE_KINDS = Object.keys(NOTICE_ICONS)

/** A notice of a kind this console can word; one from a newer server stays out. */
export const knownNotice = (item: Notice) => item.kind in NOTICE_ICONS
export const isProblemNotice = (item: Notice) => item.kind === 'model_failing' || item.kind === 'dreaming_stopped'

export function noticeText(item: Notice) {
  const params = item.kind === 'model_failing' ? { role: roleName(String(item.params.role) as ModelRoleId) } : item.params
  return t(`overview.notices.kinds.${item.kind}`, params)
}
export const noticeAction = (item: Notice) => t(`overview.notices.actions.${item.kind}`)
export const noticeTime = (item: Notice) => formatRelativeTime(item.at, currentLocale()) ?? ''
