import { ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import { t } from '@/i18n'
import { checkModelRole, type ModelRoleId } from './model'
import { failureReason } from './model-health'

// 测试连接: one real request with a role's saved settings, so "connected"
// means it answered. Every place that offers the test (a connection's row, a
// failure line, a use's details) shows the same sentence. 语义搜索's check
// also says how many numbers its model gives each text.
export interface RoleCheckResult { ok: boolean; text: string }

/** Tests the role's saved connection once and says what came back. */
export async function runRoleCheck(role: ModelRoleId, model: string): Promise<RoleCheckResult> {
  try {
    const { ok, receipt, dimensions } = await checkModelRole(role)
    const answered = receipt.actualModel ?? model
    return ok
      ? { ok, text: dimensions ? t('modelSettings.semantic.passed', { model: answered, dimensions }) : t('modelSettings.check.passed', { model: answered }) }
      : { ok, text: t('modelSettings.check.failed', { reason: failureReason(receipt.reason ?? receipt.status) }) }
  } catch (cause) {
    return { ok: false, text: t('modelSettings.check.failed', { reason: apiErrorReason(cause) }) }
  }
}

export function useRoleCheck(target: () => { role: ModelRoleId; model: string }, checked: (ok: boolean) => void = () => {}) {
  const checking = ref(false)
  const result = ref<RoleCheckResult | null>(null)

  async function check() {
    checking.value = true
    result.value = null
    const { role, model } = target()
    result.value = await runRoleCheck(role, model)
    checking.value = false
    checked(result.value.ok)
  }

  return { checking, result, check }
}
