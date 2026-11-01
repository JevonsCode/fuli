<script setup lang="ts">
import { computed } from 'vue'

import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { t } from '@/i18n'
import type { ProjectFieldAuthor } from '@/types'
import { UiAvatar } from '@/ui'
import { authorChip } from './profile-authors'

// Who wrote one profile field: an FLA, the person, or both, with its weight in
// the tooltip. Nothing for a field without a record.
const props = defineProps<{ author?: ProjectFieldAuthor | null }>()
const chip = computed(() => authorChip(props.author))
const agentName = computed(() => chip.value?.agentName ?? t('projects.profileAuthors.unnamedAgent'))
const label = computed(() => chip.value && t(`projects.profileAuthors.${chip.value.kind}`, { agent: agentName.value }))
const tooltip = computed(() => chip.value && t(`projects.profileAuthors.weight.${chip.value.kind}`, { weight: chip.value.weight }))
</script>

<template>
  <span v-if="chip" class="profile-author" :class="`is-${chip.kind}`" :title="tooltip ?? undefined"
    :data-term="`authorship.${chip.kind}`" :data-author="chip.kind">
    <span v-if="chip.kind !== 'agent' || chip.agentIds.length" class="profile-author-faces" aria-hidden="true">
      <UiAvatar v-if="chip.kind !== 'agent'" size="sm" :name="t('projects.profileAuthors.you')" />
      <UiAvatar v-for="agentId in chip.agentIds" :key="agentId" size="sm" :name="agentName" :image="agentAvatarUrl(agentId)" />
    </span>
    <span class="profile-author-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.profile-author {
  display: inline-flex; align-items: center; gap: 6px; max-width: 220px; height: 22px; padding: 0 8px 0 3px;
  border-radius: var(--radius-pill); color: var(--color-ink-soft); background: var(--color-surface-subtle);
  font-size: 12px; font-weight: var(--weight-medium); line-height: 1; vertical-align: middle;
  -webkit-user-select: none; user-select: none;
}
.profile-author.is-person { color: var(--color-accent); background: var(--color-accent-soft); }
.profile-author-faces { display: inline-flex; flex: none; }
.profile-author-faces :deep(.ui-avatar) { width: 16px; height: 16px; font-size: 10px; box-shadow: 0 0 0 1.5px var(--color-surface); }
.profile-author-faces :deep(.ui-avatar + .ui-avatar) { margin-left: -5px; }
.profile-author-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
