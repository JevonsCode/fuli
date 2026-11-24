<script setup lang="ts">
import { computed, watch } from 'vue'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { useConversationLauncherConfiguration } from '@/features/knowledge/conversation-launcher-settings'
import { t } from '@/i18n'
import type { ProjectAgentTaskSession } from '@/types'
import ClientInitial from './ClientInitial.vue'
import { clientMarks, SHOWN_CLIENTS } from './working-clients'

// Which clients a piece of work runs in, at the end of its 正在干活 row: a mark
// that opens the session where this console can, a plain one where the client
// only opens itself, a muted one where nothing opens it. It sits beside the
// row's link, never inside it, so a click here never also opens the row.
const props = defineProps<{ sessions: ProjectAgentTaskSession[] }>()
const launchers = useConversationLauncherConfiguration()
const links = useClientLinks()
// The client link list is read once per page load, when a row first has a session to show.
let linksRead = false
watch(() => props.sessions.length, (length) => {
  if (!length || linksRead) return
  linksRead = true
  links.load().catch(() => {})
}, { immediate: true })
const marks = computed(() => clientMarks(props.sessions, launchers.value, links.state?.manifest))
const shown = computed(() => marks.value.slice(0, SHOWN_CLIENTS))
const more = computed(() => marks.value.length - shown.value.length)
</script>

<template>
  <span v-if="marks.length" class="working-clients" data-working-clients>
    <template v-for="mark in shown" :key="mark.client">
      <ClientInitial v-if="mark.way === 'session'" :client="mark.client" :href="mark.href"
        :label="t('today.clients.open', { app: mark.name })" :data-working-client="mark.client" data-way="session" />
      <ClientInitial v-else :client="mark.client" :muted="mark.way === 'none'"
        :label="t(`today.clients.${mark.way}`, { app: mark.name })" :data-working-client="mark.client" :data-way="mark.way" />
    </template>
    <span v-if="more > 0" class="working-clients-more" :title="t('today.clients.more', { count: more })" data-working-clients-more>+{{ more }}</span>
  </span>
</template>

<style scoped>
/* Small marks on the row's centre line; a mark that opens something reads as a control. */
.working-clients { display: inline-flex; flex: none; align-items: center; gap: 4px; user-select: none; }
.working-clients-more {
  display: inline-grid; min-width: 18px; height: 18px; padding-inline: 2px; place-items: center;
  color: var(--color-muted); font-size: 10px; font-weight: var(--weight-medium); line-height: 1;
}
</style>
