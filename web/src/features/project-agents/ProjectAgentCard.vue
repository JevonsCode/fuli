<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { agentDisplayName, agentResponsibility } from '@/features/agent-profile/profile-model'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import AgentMentionCopy from '@/features/agent-profile/AgentMentionCopy.vue'
import { mentionKind } from '@/features/agent-profile/fla-mention'
import { t } from '@/i18n'
import type { ProjectAgentRecord } from '@/types'
import AgentHand from './AgentHand.vue'
import TaskBlockerNotice from './TaskBlockerNotice.vue'
import { currentWork } from './agent-roster-records'
import { agentManagementPath, projectChipGroups } from './orchestration-filters'
import { statusTone, taskStatusLabel } from './task-labels'

// One Agent in 编排's collection, built like the directory's AgentCard: the
// name opens the Agent's management page, "quick look" (or a click on the
// card's empty surface) asks the collection for a Peek, and the card lifts
// while its Peek is open. Running work shows as the status dot beside the
// task, never as a ring on the avatar (that reads as selected).
const props = defineProps<{
  agent: ProjectAgentRecord
  spaceId: string
  /** The projects this Agent is responsible for (policy membership for employees). */
  projects: Array<{ id: string; name: string }>
  selected?: boolean
  /** Another FLA to name in the "call them in together" phrasing. */
  mentionPartner?: string | null
}>()
const emit = defineEmits<{ peek: [] }>()

const MAX_PROJECT_CHIPS = 3
const name = computed(() => agentDisplayName(props.agent))
const path = computed(() => agentManagementPath(props.spaceId, props.agent.agentId))
const work = computed(() => currentWork(props.agent))
const reportedWaiting = computed(() => !work.value && (props.agent.workStatus === 'blocked' || props.agent.workStatus === 'queued'))
const chips = computed(() => projectChipGroups(props.projects))
// Like the directory, only a membership other than available is called out.
const membershipTone = computed(() => (props.agent.profile.status === 'inactive' ? 'warning' : 'secondary'))

function surfaceClick(event: MouseEvent) {
  if ((event.target as Element).closest('a, button, input, summary')) return
  if (window.getSelection()?.toString()) return
  emit('peek')
}
</script>

<template>
  <article
    class="agent-card project-agent-card group/card flex h-full min-w-0 cursor-pointer flex-col gap-2 rounded-lg border bg-card px-4 pt-3.5 pb-3 transition-[border-color,box-shadow] hover:border-border-strong"
    :class="{ 'is-selected border-border-strong shadow-md': selected }"
    :data-return-focus="agent.agentId"
    :data-selected="selected || undefined"
    @click="surfaceClick"
  >
    <div class="flex items-start gap-3">
      <span
        class="agent-portrait small agent-card-identity"
        :style="agentIdentityStyle(agent.agentId)"
        aria-hidden="true"
      >
        <img :src="agentAvatarUrl(agent.agentId)" alt="" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-start gap-1.5">
          <RouterLink class="agent-card-name" :to="path" :title="name" data-agent-manage-link>{{ name }}</RouterLink>
          <AgentHand :agent-id="agent.agentId" />
        </div>
        <p class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span class="whitespace-nowrap" data-agent-type>{{ t(`projectAgents.agentType.${agent.profile.agentType ?? 'durable'}`) }}</span>
          <Badge v-if="agent.profile.status !== 'active'" :variant="membershipTone" data-agent-status>{{ t(`projectAgents.status.${agent.profile.status}`) }}</Badge>
          <span v-if="agent.isTestRole" class="whitespace-nowrap">{{ t('projectAgents.source.testRole') }}</span>
        </p>
      </div>
    </div>
    <p class="agent-card-current project-agent-row-work" data-current-task>
      <template v-if="work">
        <span class="agent-card-work-status" :class="`is-${work.status}`" :data-tone="statusTone(work.status)"><span class="agent-card-work-status-text">{{ taskStatusLabel(work.status) }}</span></span>
        <RouterLink class="agent-card-current-task" :to="{ path, query: { task: work.taskId } }" :title="work.title">{{ work.title }}</RouterLink>
      </template>
      <template v-else-if="reportedWaiting">
        <span class="agent-card-work-status" :class="`is-${agent.workStatus}`" :data-tone="statusTone(agent.workStatus!)"><span class="agent-card-work-status-text">{{ taskStatusLabel(agent.workStatus!) }}</span></span>
        <span class="text-xs text-muted-foreground">{{ t('projectAgents.detail.stateReported') }}</span>
      </template>
      <span v-else class="text-xs text-muted-foreground">{{ t('projectAgents.detail.noRun') }}</span>
    </p>
    <TaskBlockerNotice v-if="work?.status === 'blocked' && work.blocker" compact :blocker="work.blocker" :updated-at="work.updatedAt" />
    <p class="agent-card-responsibility project-agent-row-responsibility" :title="agentResponsibility(agent)">
      {{ agentResponsibility(agent) || t('projectAgents.notReported') }}
    </p>
    <div class="agent-card-meta mt-auto flex items-center justify-between gap-3 border-t pt-2.5">
      <div class="agent-card-project-list project-agent-row-projects min-w-0 flex-1">
        <Badge v-for="group in chips.slice(0, MAX_PROJECT_CHIPS)" :key="group.name" variant="secondary" class="project-agent-chip" :title="group.name">
          {{ group.name }}<template v-if="group.count > 1"> ×{{ group.count }}</template>
        </Badge>
        <Badge v-if="chips.length > MAX_PROJECT_CHIPS" variant="secondary">+{{ chips.length - MAX_PROJECT_CHIPS }}</Badge>
        <span v-if="!chips.length" class="agent-card-no-project">{{ t('employees.noAssignedProjects') }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <AgentMentionCopy v-if="mentionKind(agent)" :kind="mentionKind(agent)" :name="name" :partner="mentionPartner" />
        <Button
          variant="ghost"
          size="sm"
          class="shrink-0"
          data-agent-peek
          :aria-label="t('agentProfiles.quickLookAgent', { name })"
          aria-haspopup="dialog"
          @click.stop="emit('peek')"
        >
          {{ t('agentProfiles.quickLook') }}
        </Button>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* A long project name or task title takes a second line before it is cut. */
.project-agent-chip {
  display: -webkit-box; max-width: 100%; border-radius: var(--radius-control); line-height: 1.4;
  white-space: normal; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
}
.project-agent-row-work .agent-card-current-task {
  display: -webkit-box; white-space: normal; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
}
</style>
