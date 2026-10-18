<script setup lang="ts">
import { t } from '@/i18n'

defineProps<{ personalSpaceId: string }>()
</script>

<template>
  <aside class="project-agent-first-task" :aria-label="t('projectAgents.firstTask.title')">
    <strong>{{ t('projectAgents.firstTask.title') }}</strong>
    <p>{{ t('projectAgents.firstTask.hint') }}</p>
    <ol class="project-agent-first-task-steps" data-first-task-steps>
      <li>{{ t('projectAgents.firstTask.stepTellPreference') }}</li>
      <li>{{ t('projectAgents.firstTask.stepVerifyAcrossClients') }}</li>
    </ol>
  </aside>
</template>

<style scoped>
.project-agent-first-task { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; margin: 4px 0 20px; padding: 14px 16px; border: 1px solid var(--color-accent-line); border-radius: var(--radius-card); background: var(--color-accent-soft); }
.project-agent-first-task strong { color: var(--color-accent); font-size: 14px; font-weight: 600; }
.project-agent-first-task p { color: var(--color-ink-soft); font-size: 13px; margin: 0; }
.project-agent-first-task-steps { flex-basis: 100%; margin: 2px 0 0; padding-left: 18px; color: var(--color-ink-soft); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 20px; }
</style>
