<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { useConversationLauncherConfiguration } from '@/features/knowledge/conversation-launcher-settings'
import { t } from '@/i18n'
import type { ProjectAgentTaskSession } from '@/types'
import { CLIENT_INITIALS, clientMarks, SHOWN_CLIENTS } from './working-clients'

// Which clients a piece of work runs in, at the end of its 正在干活 row: a mark
// that opens the session where this console can, a plain one where the client
// only opens itself, a muted one where nothing opens it. It sits beside the
// row's link, never inside it, so a click here never also opens the row.
const props = defineProps<{ sessions: ProjectAgentTaskSession[] }>()
const launchers = useConversationLauncherConfiguration()
const links = useClientLinks()
// The client link list is read once per page load, and only when a row has a session to show.
onMounted(() => { if (props.sessions.length) links.load().catch(() => {}) })
const marks = computed(() => clientMarks(props.sessions, launchers.value, links.state?.manifest))
const shown = computed(() => marks.value.slice(0, SHOWN_CLIENTS))
const more = computed(() => marks.value.length - shown.value.length)
</script>

<template>
  <span v-if="marks.length" class="working-clients" data-working-clients>
    <template v-for="mark in shown" :key="mark.client">
      <a v-if="mark.way === 'session'" class="working-client" :href="mark.href" rel="noreferrer"
        :aria-label="t('today.clients.open', { app: mark.name })" :title="t('today.clients.open', { app: mark.name })"
        :data-working-client="mark.client" data-way="session">{{ CLIENT_INITIALS[mark.client] }}</a>
      <span v-else class="working-client" :class="{ 'is-muted': mark.way === 'none' }" role="img"
        :aria-label="t(`today.clients.${mark.way}`, { app: mark.name })" :title="t(`today.clients.${mark.way}`, { app: mark.name })"
        :data-working-client="mark.client" :data-way="mark.way">{{ CLIENT_INITIALS[mark.client] }}</span>
    </template>
    <span v-if="more > 0" class="working-clients-more" :title="t('today.clients.more', { count: more })" data-working-clients-more>+{{ more }}</span>
  </span>
</template>

<style scoped>
/* Small marks on the row's centre line; a mark that opens something reads as a control. */
.working-clients { display: inline-flex; flex: none; align-items: center; gap: 4px; user-select: none; }
.working-client, .working-clients-more {
  display: inline-grid; min-width: 18px; height: 18px; padding-inline: 2px; place-items: center; border-radius: 5px;
  color: var(--color-ink-soft); background: var(--color-surface-subtle); box-shadow: 0 0 0 1px var(--color-border);
  font-size: 10px; font-weight: var(--weight-medium); line-height: 1; letter-spacing: 0; text-decoration: none;
}
a.working-client { color: var(--color-ink); transition: background var(--motion-fast); }
a.working-client:hover { background: var(--color-accent-soft); }
.working-client.is-muted { opacity: .45; }
.working-clients-more { box-shadow: none; background: transparent; color: var(--color-muted); }
</style>
