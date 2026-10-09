<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
import { personalProjectsPath } from '@/router/paths'

defineProps<{ personalSpaceId: string }>()
</script>

<template>
  <aside class="project-agent-first-task" :aria-label="t('projectAgents.firstTask.title')">
    <strong>{{ t('projectAgents.firstTask.title') }}</strong>
    <p>{{ t('projectAgents.firstTask.hint') }}</p>
    <label>
      <span>{{ t('projectAgents.firstTask.promptLabel') }}</span>
      <textarea readonly rows="3" :value="t('projectAgents.firstTask.prompt')" />
    </label>
    <p class="project-agent-first-task-outcome">{{ t('projectAgents.firstTask.outcome') }}</p>
    <RouterLink v-if="personalSpaceId" :to="personalProjectsPath(personalSpaceId, 'directory')">{{ t('projectAgents.firstTask.registerOptional') }}</RouterLink>
  </aside>
</template>

<style scoped>
.project-agent-first-task { margin: 16px 0; padding: 18px 20px; border: 1px solid #d8e3db; border-radius: 10px; background: #f4f8f4; color: #2c4937; }
.project-agent-first-task strong { font-size: 14px; }
.project-agent-first-task p { margin: 8px 0; color: #53685b; font-size: 13px; line-height: 1.7; }
.project-agent-first-task label { display: grid; gap: 7px; margin-top: 12px; font-size: 12px; }
.project-agent-first-task textarea { box-sizing: border-box; width: 100%; padding: 10px 12px; resize: vertical; border: 1px solid #c9d6cc; border-radius: 6px; background: #fff; color: #304d3b; font: inherit; line-height: 1.7; }
.project-agent-first-task textarea:focus-visible { outline: 2px solid #356448; outline-offset: 2px; }
.project-agent-first-task a { display: inline-block; margin-top: 4px; color: #356448; font-size: 12px; text-underline-offset: 3px; }
</style>
