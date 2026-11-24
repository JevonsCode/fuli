<script setup lang="ts">
import { computed, toRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { clipboardText, mentionPhrasings, type MentionKind } from '@/features/agent-profile/fla-mention'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { useConversationLauncherConfiguration } from '@/features/knowledge/conversation-launcher-settings'
import { taskStatusLabel } from '@/features/project-agents/task-labels'
import ClientInitial from '@/features/today/ClientInitial.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiIcon from '@/ui/UiIcon.vue'
import type { ProjectAgentTaskRecord } from '@/types'
import { openWork, sessionRows } from './hand-off'
import { useWorkLocations } from './work-locations'

// 交给它一件事, the page's one ink button (docs/fla-page.md, The one action).
// One menu, three named groups, nothing to type: a phrase to paste into a new
// conversation (shown in full, copied on click), an open FULI task to
// continue, the client session the work is running in. Arrow keys move
// between rows; Esc closes and focus returns to the button.
const props = defineProps<{
  spaceId: string; agentId: string; name: string; partner: string | null; kind: MentionKind | null
  tasks: ProjectAgentTaskRecord[]; projectName: (id: string) => string
}>()

const store = useConsoleStore()
const phrasings = computed(() => props.kind
  ? mentionPhrasings(props.name, props.partner, (key, values) => t(`agentProfiles.mention.${key}`, values), props.kind) : [])
const { located } = useWorkLocations(toRef(props, 'spaceId'), toRef(props, 'agentId'))
const continuation = computed(() => located.value?.continuation ?? null)
const continuationWhat = computed(() => {
  const value = continuation.value
  if (!value) return ''
  const project = value.personal_project_id ? props.projectName(value.personal_project_id) : t('flaPage.worked.global')
  return t('flaPage.handOff.carry', { title: value.title || t('flaPage.worked.untitled'), project })
})
const work = computed(() => openWork(props.tasks))
const launchers = useConversationLauncherConfiguration()
const links = useClientLinks()
let linksRead = false
watch(() => props.tasks.some(task => task.sessions?.length), (has) => {
  if (!has || linksRead) return
  linksRead = true
  links.load().catch(() => {})
}, { immediate: true })
const sessions = computed(() => sessionRows(props.tasks, launchers.value, links.state?.manifest))
const offers = computed(() => phrasings.value.length + (continuation.value ? 1 : 0) + work.value.length + sessions.value.length)

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    store.notify(done)
  } catch (cause) {
    store.reportError(cause)
  }
}
const copyPhrasing = (text: string) => copy(clipboardText(text), t('flaPage.handOff.copied'))
const copyContinuation = () => continuation.value && copy(continuation.value.prompt, t('flaPage.handOff.carried'))
</script>

<template>
  <DropdownMenu v-if="offers">
    <DropdownMenuTrigger as-child>
      <Button data-hand-off>{{ t('flaPage.handOff.button') }}<UiIcon name="chevron-down" :size="14" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="hand-off" data-hand-off-panel>
      <template v-if="phrasings.length || continuation">
        <DropdownMenuLabel>{{ t('flaPage.handOff.newConversation') }}</DropdownMenuLabel>
        <DropdownMenuItem v-for="item in phrasings" :key="item.key" class="hand-off-row" :data-hand-off-phrase="item.key" @select="copyPhrasing(item.text)">
          <span class="hand-off-text"><span>{{ item.text }}<span v-if="item.open" aria-hidden="true"> …</span></span></span>
          <UiIcon name="copy" :size="14" class="hand-off-icon" />
        </DropdownMenuItem>
        <DropdownMenuItem v-if="continuation" class="hand-off-row" data-hand-off-carry @select="copyContinuation">
          <span class="hand-off-text">{{ continuationWhat }}<small>{{ t('flaPage.handOff.carryHow') }}</small></span>
          <UiIcon name="copy" :size="14" class="hand-off-icon" />
        </DropdownMenuItem>
      </template>

      <template v-if="work.length">
        <DropdownMenuSeparator v-if="phrasings.length || continuation" />
        <DropdownMenuLabel>{{ t('flaPage.handOff.continueWork') }}</DropdownMenuLabel>
        <DropdownMenuItem v-for="item in work" :key="item.taskId" as-child class="hand-off-row">
          <RouterLink :to="{ query: { task: item.taskId } }" :data-hand-off-task="item.taskId">
            <span class="hand-off-text hand-off-one-line">{{ item.title }}</span>
            <span class="hand-off-meta">{{ taskStatusLabel(item.status) }}</span>
          </RouterLink>
        </DropdownMenuItem>
      </template>

      <template v-if="sessions.length">
        <DropdownMenuSeparator v-if="phrasings.length || continuation || work.length" />
        <DropdownMenuLabel>{{ t('flaPage.handOff.openSession') }}</DropdownMenuLabel>
        <template v-for="row in sessions" :key="row.key">
          <DropdownMenuItem v-if="row.way === 'session'" as-child class="hand-off-row">
            <a :href="row.href" rel="noreferrer" :data-hand-off-session="row.client">
              <ClientInitial :client="row.client" :label="row.name" />
              <span class="hand-off-text">{{ t('flaPage.handOff.openIn', { app: row.name }) }}</span>
            </a>
          </DropdownMenuItem>
          <template v-else>
            <DropdownMenuItem disabled class="hand-off-row" :data-hand-off-session="row.client" :data-why="row.way">
              <ClientInitial :client="row.client" :label="row.name" muted />
              <span class="hand-off-text">{{ row.name }}<small>{{ t(`flaPage.handOff.why.${row.way}`) }}</small></span>
            </DropdownMenuItem>
            <DropdownMenuItem v-if="row.way === 'settings'" as-child class="hand-off-row hand-off-indent">
              <RouterLink :to="{ path: '/settings', query: { setting: 'launchers' } }" data-hand-off-settings>{{ t('flaPage.handOff.toSettings') }}</RouterLink>
            </DropdownMenuItem>
          </template>
        </template>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<style scoped>
.hand-off-icon { margin-left: auto; color: var(--color-muted); }
.hand-off-meta { flex: none; margin-left: auto; color: var(--color-muted); font-size: var(--text-meta); }
</style>

<style>
/* The panel renders outside this component. */
[data-slot="dropdown-menu-content"].hand-off { width: min(420px, calc(100vw - 32px)); max-height: min(70vh, 560px); padding: 6px; overflow-y: auto; }
.hand-off .hand-off-row { align-items: center; gap: 10px; color: var(--color-ink); text-decoration: none; }
.hand-off .hand-off-text { display: grid; min-width: 0; gap: 2px; overflow-wrap: anywhere; }
.hand-off .hand-off-text small { color: var(--color-muted); font-size: var(--text-meta); }
.hand-off .hand-off-one-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hand-off .hand-off-row[data-disabled] { opacity: 1; }
.hand-off .hand-off-indent { padding-left: 38px; color: var(--color-accent); }
</style>
