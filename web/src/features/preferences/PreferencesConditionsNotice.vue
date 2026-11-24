<script setup lang="ts">
import { computed } from 'vue'

import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import type { KnowledgeItem } from '@/types'

import { unstatedHabits } from './habit-conditions'
import PreferencesOrganizeStart from './PreferencesOrganizeStart.vue'

// How many habits in the range picked never say when they apply, beside the
// tidy entry, with the same hand-off to the person's AI for that one step.
// Nothing shows when every habit says it, or none is confirmed.
const props = defineProps<{ items: readonly KnowledgeItem[]; scope: string }>()
const unstated = computed(() => unstatedHabits(props.items))
const text = computed(() => t(unstated.value.hard ? 'preferences.profile.conditions.countHard' : 'preferences.profile.conditions.count',
  { count: unstated.value.count, hard: unstated.value.hard }))
</script>

<template>
  <UiNotice v-if="unstated.count" data-preferences-conditions>
    {{ text }}
    <template #actions><PreferencesOrganizeStart :scope="scope" step="conditions" /></template>
  </UiNotice>
</template>
