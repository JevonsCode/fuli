<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { roleName, type ModelRoleId } from './model'
import { useRoleCheck } from './useRoleCheck'

// A failure with its way forward, in one line (11-11): what failed and why in
// plain words, then 「测试连接」 for the connection behind it; the test's answer
// replaces the sentence in place, so nothing around it moves. The thing that
// failed is retried by its owner's own action (重试).
const props = defineProps<{ text: string; role: ModelRoleId; model: string }>()
const emit = defineEmits<{ checked: [ok: boolean] }>()
const { checking, result, check } = useRoleCheck(() => props, ok => emit('checked', ok))
</script>

<template>
  <p class="model-failure" :class="{ 'is-ok': result?.ok }" :role="result?.ok ? 'status' : 'alert'" data-model-failure>
    <span class="model-failure-text" :title="result?.text ?? text" data-model-failure-text>{{ result?.text ?? text }}</span>
    <Button type="button" variant="link" size="sm" class="model-failure-check" :loading="checking"
      :loading-label="t('modelSettings.check.running', { name: roleName(role) })" data-model-check @click="check">
      {{ t('modelSettings.check.run') }}
    </Button>
  </p>
</template>

<style scoped>
/* One line of text and its link share a centre line; the text gives way, the link never wraps or moves. */
.model-failure { display: flex; align-items: center; gap: var(--space-2); min-width: 0; margin: 0; color: var(--color-danger); font-size: var(--text-control); line-height: 20px; }
.model-failure.is-ok { color: var(--color-success); }
.model-failure-text { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-failure-check { flex: none; height: 20px; padding: 0; user-select: none; }
</style>
