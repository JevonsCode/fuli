<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import AgentAvatar from '@/features/agent-profile/AgentAvatar.vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'
import type { WorkingRow } from './today-model'
import TodaySection from './TodaySection.vue'

// 正在干活: who is working on what right now, alone or together. 全部任务
// opens 工作台, which shows every task with its stage and lists.
defineProps<{ rows: WorkingRow[]; name: (row: WorkingRow) => string; project: (id: string | null) => string }>()
</script>

<template>
  <TodaySection :title="t('today.sections.working')" data-today-section="working">
    <template #action>
      <Button as-child variant="ghost" size="sm"><RouterLink to="/workbench" data-today-action="working">{{ t('today.actions.allTasks') }}</RouterLink></Button>
    </template>
    <ul class="workbench-rows">
      <li v-for="row in rows" :key="row.key" class="workbench-row today-working-row" data-today-working>
        <span class="workbench-face" :style="agentIdentityStyle(row.agentId)">
          <AgentAvatar v-if="row.agentId" :agent-id="row.agentId" :name="name(row)" />
          <UiIcon v-else name="agents" class="workbench-face-none" />
        </span>
        <div class="workbench-row-text">
          <p class="workbench-row-title">{{ row.title || t('overview.missing.taskTitle') }}</p>
          <p class="workbench-meta">{{ t('today.working.meta', { name: name(row), project: project(row.projectId) }) }}</p>
        </div>
      </li>
    </ul>
  </TodaySection>
</template>

<style scoped>
/* No trailing action: the row is the face and its text. */
.today-working-row { grid-template-columns: 34px minmax(0, 1fr); }
</style>
