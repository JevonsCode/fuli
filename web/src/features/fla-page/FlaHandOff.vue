<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { clipboardText, mentionPhrasings, type MentionKind } from '@/features/agent-profile/fla-mention'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { openInTerminal, type NewSessionWay } from '@/features/client-links/new-session'
import { useNewSessionClients } from '@/features/client-links/new-session-clients'
import { useConversationLauncherConfiguration } from '@/features/knowledge/conversation-launcher-settings'
import ClientInitial from '@/features/today/ClientInitial.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiIcon from '@/ui/UiIcon.vue'
import type { ProjectAgentTaskRecord } from '@/types'
import { closedSessionNotes, sessionRows } from './hand-off'
import { useWorkLocations } from './work-locations'

// 交给它一件事, the page's one ink button (docs/fla-page.md, The one action).
// Nothing to type. First, a new conversation where it carries on: one row per
// client that opens one with the opening message already in it (the shared
// new-session way, client-links/new-session.ts, as 「让 Tonborg 给你解释」
// uses); only when none can does the menu copy the message, and say why and
// where to set that up. The message keeps the `#FLA` / `#FLG` protocol; the
// rows say in words what happens. Then the open-ended group phrasings to
// paste, and the client sessions its open tasks run in: those that open, one
// row each; the rest in one closing note. Arrow keys reach every row; Esc
// closes and focus returns to the button.
const props = defineProps<{
  spaceId: string; agentId: string; name: string; partner: string | null; kind: MentionKind | null
  tasks: ProjectAgentTaskRecord[]; projectName: (id: string) => string
}>()

const store = useConsoleStore()
const phrasings = computed(() => props.kind
  ? mentionPhrasings(props.name, props.partner, (key, values) => t(`agentProfiles.mention.${key}`, values), props.kind) : [])
const { located } = useWorkLocations(toRef(props, 'spaceId'), toRef(props, 'agentId'))
const continuation = computed(() => located.value?.continuation ?? null)
// The opening message a new conversation starts with: the recorded hand-over of its last
// conversation when there is one, else the FLA called by name to carry on.
const ask = computed(() => continuation.value?.prompt ?? phrasings.value.find(item => item.key === 'continue')?.text ?? '')
const askTitle = computed(() => {
  const value = continuation.value
  if (!value) return t('flaPage.handOff.newConversation', { name: props.name })
  const project = value.personal_project_id ? props.projectName(value.personal_project_id) : t('flaPage.worked.global')
  return t('flaPage.handOff.carry', { title: value.title || t('flaPage.worked.untitled'), project })
})
// The group phrasings end where the person goes on typing: they are copied, never sent.
const groupPhrasings = computed(() => phrasings.value.filter(item => item.open))
const shownText = (text: string) => text.replace(/^#FL[AG]\s+/, '')

const clients = useNewSessionClients(ask)
const openable = computed(() => clients.rows.value.filter((row): row is typeof row & { way: NewSessionWay } => Boolean(row.way)))
const open = ref(false)
// Finding the terminal ways starts shells on this computer: only once the menu is opened.
watch(open, (now) => { if (now) void clients.load() })

const launchers = useConversationLauncherConfiguration()
const links = useClientLinks()
let linksRead = false
watch(() => props.tasks.some(task => task.sessions?.length), (has) => {
  if (!has || linksRead) return
  linksRead = true
  links.load().catch(() => {})
}, { immediate: true })
const sessions = computed(() => sessionRows(props.tasks, launchers.value, links.state?.manifest))
const sessionsOpen = computed(() => sessions.value.filter(row => row.way === 'session'))
const sessionNotes = computed(() => closedSessionNotes(sessions.value,
  (names, why) => t('flaPage.handOff.closed', { clients: names, why: t(`flaPage.handOff.why.${why}`) })))
const offers = computed(() => Boolean(ask.value) || groupPhrasings.value.length + sessions.value.length > 0)

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    store.notify(done)
  } catch (cause) {
    store.reportError(cause)
  }
}
const copyAsk = () => copy(ask.value, t('flaPage.handOff.copied'))
const copyPhrasing = (text: string) => copy(clipboardText(text), t('flaPage.handOff.copiedGroup'))
const opened = (client: string) => store.notify(t('flaPage.handOff.opened', { client }))
// The terminal opens on this computer; when FULI cannot open it, the message is copied instead.
async function launch(name: string, way: Extract<NewSessionWay, { kind: 'terminal' }>) {
  try {
    await openInTerminal(way, ask.value)
    opened(name)
  } catch {
    await copy(ask.value, t('clientLinks.newSession.pasteIn', { client: name }))
  }
}
</script>

<template>
  <DropdownMenu v-if="offers" v-model:open="open">
    <DropdownMenuTrigger as-child>
      <Button data-hand-off>{{ t('flaPage.handOff.button') }}<UiIcon name="chevron-down" :size="14" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="hand-off" data-hand-off-panel>
      <template v-if="ask">
        <DropdownMenuLabel class="hand-off-label" data-hand-off-ask>{{ askTitle }}</DropdownMenuLabel>
        <DropdownMenuItem v-if="!clients.ready.value" disabled class="hand-off-row" data-hand-off-checking>
          <span class="hand-off-text hand-off-quiet">{{ t('flaPage.handOff.checking') }}</span>
        </DropdownMenuItem>
        <template v-else-if="openable.length">
          <template v-for="row in openable" :key="row.id">
            <DropdownMenuItem v-if="row.way.kind === 'link'" as-child class="hand-off-row">
              <a :href="row.way.href" :data-hand-off-client="row.id" @click="opened(row.name)">
                <UiIcon name="chat" :size="16" class="hand-off-lead" />
                <span class="hand-off-text">{{ t('flaPage.handOff.newIn', { client: row.name }) }}</span>
                <span v-if="row.tags('')" class="hand-off-meta">{{ row.tags('') }}</span>
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem v-else class="hand-off-row" :data-hand-off-client="row.id" @select="launch(row.name, row.way)">
              <UiIcon name="chat" :size="16" class="hand-off-lead" />
              <span class="hand-off-text">{{ t('flaPage.handOff.newIn', { client: row.name }) }}</span>
              <span class="hand-off-meta">{{ row.tags(t('clientLinks.newSession.terminalTag')) }}</span>
            </DropdownMenuItem>
          </template>
          <DropdownMenuItem class="hand-off-row" data-hand-off-copy @select="copyAsk">
            <UiIcon name="copy" :size="16" class="hand-off-lead" />
            <span class="hand-off-text hand-off-quiet">{{ t('clientLinks.newSession.copyForOther') }}</span>
          </DropdownMenuItem>
        </template>
        <template v-else>
          <DropdownMenuItem class="hand-off-row" data-hand-off-copy data-hand-off-fallback @select="copyAsk">
            <UiIcon name="copy" :size="16" class="hand-off-lead" />
            <span class="hand-off-text">{{ t('flaPage.handOff.copyAsk') }}<small>{{ t('flaPage.handOff.noClient') }}</small></span>
          </DropdownMenuItem>
          <DropdownMenuItem as-child class="hand-off-row hand-off-link">
            <RouterLink :to="{ path: '/settings', query: { tab: 'clients' } }" data-hand-off-clients>{{ t('flaPage.handOff.toClients') }}</RouterLink>
          </DropdownMenuItem>
        </template>
      </template>

      <template v-if="groupPhrasings.length">
        <DropdownMenuSeparator v-if="ask" />
        <DropdownMenuLabel class="hand-off-label">{{ t('flaPage.handOff.group') }}</DropdownMenuLabel>
        <DropdownMenuItem v-for="item in groupPhrasings" :key="item.key" class="hand-off-row" :data-hand-off-phrase="item.key" @select="copyPhrasing(item.text)">
          <UiIcon name="copy" :size="16" class="hand-off-lead" />
          <span class="hand-off-text">{{ shownText(item.text) }} …</span>
        </DropdownMenuItem>
      </template>

      <template v-if="sessions.length">
        <DropdownMenuSeparator v-if="ask || groupPhrasings.length" />
        <DropdownMenuLabel class="hand-off-label">{{ t('flaPage.handOff.openSession') }}</DropdownMenuLabel>
        <DropdownMenuItem v-for="row in sessionsOpen" :key="row.key" as-child class="hand-off-row">
          <a v-if="row.way === 'session'" :href="row.href" rel="noreferrer" :data-hand-off-session="row.client">
            <ClientInitial :client="row.client" :label="row.name" />
            <span class="hand-off-text">{{ t('flaPage.handOff.openIn', { app: row.name }) }}</span>
          </a>
        </DropdownMenuItem>
        <!-- The sessions that cannot open, in one note: why, and the fix when there is one. -->
        <template v-for="note in sessionNotes" :key="note.why">
          <DropdownMenuItem v-if="note.why === 'settings'" as-child class="hand-off-row">
            <RouterLink :to="{ path: '/settings', query: { setting: 'launchers' } }" :data-hand-off-note="note.why" data-hand-off-settings>
              <span class="hand-off-text">{{ t('flaPage.handOff.toSettings') }}<small>{{ note.text }}</small></span>
            </RouterLink>
          </DropdownMenuItem>
          <DropdownMenuLabel v-else class="hand-off-note" :data-hand-off-note="note.why">{{ note.text }}</DropdownMenuLabel>
        </template>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<style>
/* The panel renders outside this component. */
[data-slot="dropdown-menu-content"].hand-off { width: min(400px, calc(100vw - 32px)); max-height: min(70vh, 560px); padding: 6px; overflow-y: auto; }
.hand-off .hand-off-label { color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.hand-off .hand-off-row { align-items: center; gap: 10px; color: var(--color-ink); text-decoration: none; }
.hand-off .hand-off-lead { flex: none; color: var(--color-muted); }
.hand-off .hand-off-text { display: grid; flex: 1 1 auto; min-width: 0; gap: 2px; overflow-wrap: anywhere; }
.hand-off .hand-off-text small { color: var(--color-muted); font-size: var(--text-meta); line-height: 1.45; }
.hand-off .hand-off-quiet { color: var(--color-ink-soft); }
.hand-off .hand-off-meta { flex: none; margin-left: auto; color: var(--color-muted); font-size: var(--text-meta); }
.hand-off .hand-off-link { padding-left: 34px; color: var(--color-link); }
.hand-off .hand-off-note { color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular); line-height: 1.45; }
</style>
