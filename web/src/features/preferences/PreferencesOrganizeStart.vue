<script setup lang="ts">
import { computed, ref } from 'vue'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import NewSessionPanel from '@/features/client-links/NewSessionPanel.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiAiButton from '@/ui/UiAiButton.vue'

import { organizePreferencesSentence } from './preference-organizing'

// 「让 AI 整理我的偏好」 beside the preference list's refresh (rec issue 121):
// the shared new-session panel hands one of the person's connected AI
// clients one sentence naming Astro and the range picked in 范围. How to tidy
// is in FULI (organize_project, action preferences); the AI proposes and
// changes only what the person says yes to.
const props = defineProps<{ scope: string }>()
const store = useConsoleStore()
const open = ref(false)
const ask = computed(() => organizePreferencesSentence(props.scope))
const openedNotice = (client: string) => t('preferences.profile.organize.opened', { client })

function done(notice: string) {
  open.value = false
  store.notify(notice)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <UiAiButton size="md" :area="t('preferences.profile.organize.area')" :active="open" data-preferences-organize />
    </PopoverTrigger>
    <PopoverContent align="end" :side-offset="8" :collision-padding="12" class="new-session-popover" data-preferences-organize-panel>
      <NewSessionPanel :title="t('preferences.profile.organize.title')" :lead="t('preferences.profile.organize.lead')" :ask="ask"
        :opened-notice="openedNotice" :copied-notice="t('preferences.profile.organize.copied')" @done="done" />
    </PopoverContent>
  </Popover>
</template>
