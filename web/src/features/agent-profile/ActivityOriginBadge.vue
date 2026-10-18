<script setup lang="ts">
import { t } from '@/i18n'
import type { TaskActivityOrigin } from '@/types'

// Marks work an AI ran for itself (a test, an input suggestion) so it is not
// mistaken for the person's own task. Absent origin renders nothing.
defineProps<{ origin?: TaskActivityOrigin | null }>()
</script>

<template>
  <span v-if="origin?.kind === 'ai_internal'" class="ui-badge activity-origin-badge" data-activity-origin
    :title="t(`agentProfiles.activityOrigin.sources.${origin.source}`)">
    {{ t('agentProfiles.activityOrigin.label', { purpose: t(`agentProfiles.activityOrigin.purposes.${origin.purpose}`) }) }}
  </span>
</template>

<style scoped>
.activity-origin-badge { color: var(--color-muted); background: var(--color-surface-subtle); }
</style>
