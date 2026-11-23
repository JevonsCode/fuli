<script setup lang="ts">
import { computed, ref } from 'vue'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import NewSessionPanel from '@/features/client-links/NewSessionPanel.vue'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiAiButton from '@/ui/UiAiButton.vue'

import { runnerUpdatePrompt } from './runner-update-prompt'

// 「让 AI 来做：更新这台电脑的 FULI」 on a runner whose FULI is older than its
// host's (rec issue 144): the shared new-session panel hands the prompt to one
// of the person's AI clients here, or copies it. A runner's page cannot run
// the update itself (its relay refuses /api/system/update, docs/runner.md).
const props = defineProps<{ hostVersion: string }>()
const store = useConsoleStore()
const open = ref(false)
const prompt = computed(() => runnerUpdatePrompt(props.hostVersion, currentLocale()) ?? '')
const openedNotice = (client: string) => t('settings.connection.clients.runner.updateOpened', { client })

function done(notice: string) {
  open.value = false
  store.notify(notice)
}
</script>

<template>
  <Popover v-if="prompt" v-model:open="open">
    <PopoverTrigger as-child>
      <UiAiButton size="sm" :area="t('settings.connection.clients.runner.updateArea')" :active="open" data-runner-update />
    </PopoverTrigger>
    <PopoverContent align="end" :side-offset="8" :collision-padding="12" class="new-session-popover" data-runner-update-panel>
      <NewSessionPanel :title="t('settings.connection.clients.runner.updateArea')" :lead="t('settings.connection.clients.runner.updateLead')"
        :ask="prompt" :opened-notice="openedNotice" :copied-notice="t('settings.connection.clients.runner.updateCopied')" @done="done" />
    </PopoverContent>
  </Popover>
</template>
