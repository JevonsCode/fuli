<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { overviewOwnerId, overviewTaskHref } from '@/features/overview/overview-data'
import { taskStatusTone } from '@/features/project-agents/task-labels'
import type { ProjectAgentTaskRecord } from '@/types'
import UiIcon from '@/ui/UiIcon.vue'
import '@/features/overview/workbench-card.css'

// One task on 进行中 or 最近完成's own page; the whole row opens the task.
const props = defineProps<{
  task: ProjectAgentTaskRecord
  done: boolean
  title: string
  meta: string
  time: string
  statusLabel: string
}>()
const lead = computed(() => overviewOwnerId(props.task))
</script>

<template>
  <RouterLink :to="overviewTaskHref(task)" class="workbench-row task-list-row" data-task-row>
    <span v-if="done" class="workbench-done-mark" aria-hidden="true"><UiIcon name="check" :size="16" /></span>
    <span v-else class="workbench-face" :style="agentIdentityStyle(lead)" aria-hidden="true">
      <img v-if="lead" :src="agentAvatarUrl(lead)" alt="" />
      <UiIcon v-else name="agents" class="workbench-face-none" />
    </span>
    <span class="workbench-row-text">
      <span class="workbench-row-title">{{ title }}</span>
      <span class="workbench-meta task-list-meta"><time class="task-list-time-inline">{{ time }} · </time>{{ meta }}</span>
    </span>
    <span class="task-list-end">
      <Badge v-if="!done" :variant="taskStatusTone(task.status)">{{ statusLabel }}</Badge>
      <time class="workbench-meta" :datetime="(done ? task.completedAt : task.updatedAt) ?? undefined">{{ time }}</time>
    </span>
  </RouterLink>
</template>

<style scoped>
.task-list-row { height: 100%; padding: 0 10px; border-radius: 12px; color: inherit; text-decoration: none; user-select: none; transition: background var(--motion-fast); }
.task-list-row:hover { background: var(--color-surface-subtle); }
.task-list-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-list-end { display: grid; justify-items: end; gap: 4px; }
/* Narrow rows give the title the room: the time moves into the meta line. */
.task-list-time-inline { display: none; }
@media (max-width: 560px) {
  .task-list-end time { display: none; }
  .task-list-time-inline { display: inline; }
}
</style>
