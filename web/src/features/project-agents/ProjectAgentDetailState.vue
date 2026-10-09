<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'

defineProps<{
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  label: string
}>()

defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="status === 'idle'" class="project-agent-source-state" role="status">
    {{ t('projectAgents.detail.notLoaded') }}
  </div>
  <div v-else-if="status === 'loading'" class="project-agent-source-state">
    <GrowthLoading
      variant="inline"
      :label="label"
    />
  </div>
  <div v-else-if="status === 'error'" class="project-agent-source-state is-error" role="alert">
    <span>{{ error || t('projectAgents.detail.sectionUnavailable') }}</span>
    <button class="quiet-button" type="button" @click="$emit('retry')">
      {{ t('projectAgents.retry') }}
    </button>
  </div>
  <slot v-else />
</template>

<style scoped>
.project-agent-source-state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 22px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-muted);
  font-size: 12px;
}

.project-agent-source-state.is-error {
  border-color: var(--color-danger-soft);
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
</style>
