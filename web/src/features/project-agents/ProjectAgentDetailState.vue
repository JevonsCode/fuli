<script setup lang="ts">
import { t } from '@/i18n'

defineProps<{
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
}>()

defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="status === 'idle'" class="project-agent-source-state" role="status">
    {{ t('projectAgents.detail.notLoaded') }}
  </div>
  <div v-else-if="status === 'loading'" class="project-agent-source-state" role="status">
    {{ t('projectAgents.detail.loadingSection') }}
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
  border: 1px solid #e1e6e2;
  border-radius: 8px;
  background: #f7f9f7;
  color: #727d75;
  font-size: 10px;
}

.project-agent-source-state.is-error {
  border-color: #ebd5d0;
  background: #fbf3f1;
  color: #8c4f49;
}
</style>
