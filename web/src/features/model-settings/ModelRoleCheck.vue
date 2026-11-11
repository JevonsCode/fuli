<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { roleName, type ModelRoleId } from './model'
import { useRoleCheck } from './useRoleCheck'

// 测试连接 with its answer beside it, in a use's details.
const props = defineProps<{ role: ModelRoleId; model: string }>()
const { checking, result, check } = useRoleCheck(() => props)
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
