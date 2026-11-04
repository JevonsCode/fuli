<script setup lang="ts">
import MeLink from '@/components/MeLink.vue'
import AgentName from '@/features/agent-profile/AgentName.vue'
import { t } from '@/i18n'
import type { ProjectChangeActor } from './project-change-log'

// Who made one change: 我, the Agent by its page, or FULI itself.
defineProps<{ spaceId: string; actor: ProjectChangeActor }>()
</script>

<template>
  <MeLink v-if="actor.kind === 'person'" />
  <AgentName v-else-if="actor.agentId" :space-id="spaceId" :agent-id="actor.agentId"
    :name="actor.agentName ?? t('projects.profileAuthors.unnamedAgent')" />
  <template v-else>{{ actor.agentName ?? t('projects.overview.changeLog.fuli') }}</template>
</template>
