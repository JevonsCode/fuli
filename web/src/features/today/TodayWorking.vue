<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import AgentAvatar from '@/features/agent-profile/AgentAvatar.vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { agentProfilePath } from '@/features/agent-profile/profile-model'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'
import type { WorkingRow } from './today-model'
import TodaySection from './TodaySection.vue'

// 正在干活: who is working on what right now, alone or together. A row opens
// its assistant's own page; a row with no assistant opens nothing. 全部助手
// opens the assistants page with the ones at work first.
defineProps<{ rows: WorkingRow[]; spaceId: string; name: (row: WorkingRow) => string; project: (id: string | null) => string }>()
const ALL_ASSISTANTS = { path: '/project-agents', query: { view: 'work', first: 'working' } }
</script>

<template>
  <TodaySection :title="t('today.sections.working')" data-today-section="working">
    <template #action>
      <Button as-child variant="ghost" size="sm"><RouterLink :to="ALL_ASSISTANTS" data-today-action="working">{{ t('today.actions.allAssistants') }}</RouterLink></Button>
    </template>
    <ul class="workbench-rows">
      <li v-for="row in rows" :key="row.key" data-today-working>
        <component :is="row.agentId ? RouterLink : 'div'" :to="row.agentId ? agentProfilePath(spaceId, row.agentId) : undefined"
          class="workbench-row today-working-row" :class="{ 'is-link': row.agentId }" data-today-working-row>
          <span class="workbench-face" :style="agentIdentityStyle(row.agentId)">
            <AgentAvatar v-if="row.agentId" :agent-id="row.agentId" :name="name(row)" />
            <UiIcon v-else name="agents" class="workbench-face-none" />
          </span>
          <span class="workbench-row-text">
            <span class="workbench-row-title">{{ row.title || t('overview.missing.taskTitle') }}</span>
            <span class="workbench-meta">{{ t('today.working.meta', { name: name(row), project: project(row.projectId) }) }}</span>
          </span>
        </component>
      </li>
    </ul>
  </TodaySection>
</template>

<style scoped>
/* No trailing action: the row is the face and its text. */
.today-working-row { grid-template-columns: 34px minmax(0, 1fr); color: inherit; text-decoration: none; }
.today-working-row.is-link { margin-inline: -8px; width: calc(100% + 16px); padding-inline: 8px; border-radius: 12px; user-select: none; transition: background var(--motion-fast); }
.today-working-row.is-link:hover { background: var(--color-surface-subtle); }
</style>
