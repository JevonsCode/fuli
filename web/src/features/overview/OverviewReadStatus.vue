<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
const props = defineProps<{ state: { loading: boolean; slow: boolean; error: string; data: unknown; updatedAt: string | null; status: number | null }; label: string; failed: string; testId?: string }>()
const emit = defineEmits<{ retry: [] }>()
</script>
<template>
  <div v-if="state.loading || state.error" class="overview-read-status">
    <GrowthLoading v-if="state.loading" :variant="state.data === null ? 'compact' : 'inline'" :label="label" />
    <p v-if="state.slow" role="status">{{ t('overview.read.slow') }}</p>
    <UiNotice v-if="state.error" tone="error" class="overview-read-error">
      <p>{{ state.error === 'timeout' ? t('overview.read.timeout') : failed }}</p>
      <p v-if="state.data !== null">{{ t('overview.read.stale') }}</p>
      <time v-if="state.data !== null && state.updatedAt" :datetime="state.updatedAt">{{ t('overview.read.lastRead', { date: new Date(state.updatedAt).toLocaleTimeString() }) }}</time>
      <details v-if="state.status"><summary>{{ t('overview.read.diagnostics') }}</summary>HTTP {{ state.status }}</details>
      <template #actions><Button :data-testid="testId" :disabled="state.loading" variant="ghost" size="sm" @click="emit('retry')">{{ t('overview.read.reload') }}</Button></template>
    </UiNotice>
  </div>
</template>
<style scoped>
.overview-read-status { margin-block: 12px; color: var(--color-ink-soft); font-size: 14px; overflow-wrap: anywhere; }
p { margin: 4px 0; }
time, details { display: block; color: var(--color-muted); font-size: 12px; }
summary { cursor: pointer; display: flex; align-items: center; }
@media (pointer: coarse) { summary, .overview-read-error :deep(button) { min-height: var(--control-height-lg); } }
</style>
