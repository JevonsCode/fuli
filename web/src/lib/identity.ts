import { t } from '@/i18n'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function compactIdentity(value: unknown, limit = 18) {
  const identity = String(value ?? '').trim()
  if (!identity) return t('common.status.notRecorded')
  if (identity.length <= limit) return identity
  if (UUID.test(identity)) return identity.slice(0, 8)
  const head = Math.max(7, Math.ceil((limit - 1) * 0.58))
  const tail = Math.max(4, limit - head - 1)
  return `${identity.slice(0, head)}…${identity.slice(-tail)}`
}

export function identitySearchText(value: unknown) {
  const identity = String(value ?? '').trim()
  return `${identity} ${compactIdentity(identity)}`
}

export function graphNodeIdentity(node: {
  id?: unknown
  attributes?: Record<string, unknown>
} | null | undefined) {
  const projectId = node?.attributes?.projectId
  return compactIdentity(projectId || node?.id, projectId ? 26 : 18)
}
