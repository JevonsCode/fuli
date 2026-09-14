<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import { useAgentAttention } from './attention-store'
const props = defineProps<{ agentId?: string; passive?: boolean }>()
const attention = useAgentAttention()
const count = computed(() => props.agentId ? attention.counts[props.agentId] ?? 0 : attention.total)
function activate(event: Event) { if (!props.passive) { event.stopPropagation(); attention.show(props.agentId) } }
</script>

<template>
  <component :is="passive ? 'span' : 'button'" v-if="count" :type="passive ? undefined : 'button'" class="agent-hand" :aria-label="t('attention.count', { count })" :title="t('attention.count', { count })" @click="activate">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v6c0 4-2 7-6 7h-1c-3 0-4-1-6-4l-3-4a1.6 1.6 0 0 1 2.5-2z" /></svg>
    <span aria-hidden="true">{{ count }}</span>
  </component>
</template>

<style scoped>
.agent-hand { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; padding: 4px 7px; min-height: 30px; border: 1px solid #bdb28e; border-radius: 7px; background: #f5efd9; color: #685017; font: inherit; font-size: 12px; font-weight: 650; vertical-align: middle; }
button.agent-hand { cursor: pointer; }
.agent-hand svg { width: 18px; height: 18px; }
.agent-hand:focus-visible { outline: 2px solid #315c43; outline-offset: 3px; }
</style>
