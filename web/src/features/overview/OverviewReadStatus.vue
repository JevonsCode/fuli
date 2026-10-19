<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
const props = defineProps<{ state: { loading: boolean; slow: boolean; error: string; data: unknown; updatedAt: string | null; status: number | null }; label: string; failed: string; testId?: string }>()
const emit = defineEmits<{ retry: [] }>()
</script>
<template>
  <div v-if="state.loading || state.error" class="overview-read-status">
    <GrowthLoading v-if="state.loading" :variant="state.data === null ? 'compact' : 'inline'" :label="label" />
    <p v-if="state.slow" role="status">{{ t('overview.read.slow') }}</p>
    <div v-if="state.error" class="overview-read-error" role="alert">
      <div>
        <p>{{ state.error === 'timeout' ? t('overview.read.timeout') : failed }}</p>
        <p v-if="state.data !== null">{{ t('overview.read.stale') }}</p>
        <time v-if="state.data !== null && state.updatedAt" :datetime="state.updatedAt">{{ t('overview.read.lastRead', { date: new Date(state.updatedAt).toLocaleTimeString() }) }}</time>
        <details v-if="state.status"><summary>{{ t('overview.read.diagnostics') }}</summary>HTTP {{ state.status }}</details>
      </div>
      <Button :data-testid="testId" :disabled="state.loading" variant="ghost" @click="emit('retry')">{{ t('overview.read.reload') }}</Button>
    </div>
  </div>
</template>
<style scoped>
.overview-read-status { margin-block: 12px; color: var(--color-ink-soft); font-size: 14px; overflow-wrap: anywhere; }
p { margin: 4px 0; }
.overview-read-error { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; color: var(--color-danger); }
time, details { font-size: 12px; }
summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
.overview-read-error :deep(button) { min-height: 44px; }
</style>
