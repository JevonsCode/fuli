<script setup lang="ts">
import { ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { checkModelRole, roleName, type ModelRoleId } from './model'

// One real request with the saved settings, so "configured" means it answered.
// 语义搜索's check also says how many numbers its model gives each text.
const props = defineProps<{ role: ModelRoleId; model: string }>()

const checking = ref(false)
const result = ref<{ ok: boolean; text: string } | null>(null)

// A reason FULI knows reads as words; any other stays as the provider gave it.
function readableReason(reason: string) {
  const key = `modelSettings.check.reasons.${reason}`
  const text = t(key)
  return text === key ? reason : text
}

async function check() {
  checking.value = true
  result.value = null
  try {
    const { ok, receipt, dimensions } = await checkModelRole(props.role)
    const model = receipt.actualModel ?? props.model
    result.value = ok
      ? { ok, text: dimensions ? t('modelSettings.semantic.passed', { model, dimensions }) : t('modelSettings.check.passed', { model }) }
      : { ok, text: t('modelSettings.check.failed', { reason: readableReason(receipt.reason ?? receipt.status) }) }
  } catch (cause) {
    result.value = { ok: false, text: t('modelSettings.check.failed', { reason: apiErrorReason(cause) }) }
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <div class="model-role-check-row">
    <p v-if="result" :role="result.ok ? 'status' : 'alert'" :class="{ 'model-role-check-failed': !result.ok }" data-model-check-result>{{ result.text }}</p>
    <Button type="button" variant="outline" size="sm" :loading="checking" :loading-label="t('modelSettings.check.running', { name: roleName(role) })"
      data-model-check @click="check">
      {{ t('modelSettings.check.run') }}
    </Button>
  </div>
</template>

<style scoped>
.model-role-check-row { display: flex; align-items: center; justify-content: flex-end; gap: 12px; min-width: 0; }
.model-role-check-row p { min-width: 0; margin: 0; color: var(--color-muted); font-size: 13px; overflow-wrap: anywhere; }
.model-role-check-row .model-role-check-failed { color: var(--color-danger); }
</style>
