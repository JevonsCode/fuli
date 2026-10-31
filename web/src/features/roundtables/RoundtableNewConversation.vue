<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { UiIcon, UiNotice } from '@/ui'
import { projectDisplayName } from '@/features/projects/project-origin'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { listDirectoryAgents, postMessage, type RoundtableDelivery, type RoundtableDirectoryAgent } from './roundtable-api'
import RoundtableComposer from './RoundtableComposer.vue'

// Starts the person's conversation with one FLA, or a group of them, in the
// project they share, like a new message: the chosen FLAs as chips in the To
// field, a searchable list of everyone below, the message at the bottom. The
// new thread opens once the server recorded the message.
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const store = useConsoleStore()
const agents = ref<RoundtableDirectoryAgent[]>([])
const state = ref<'loading' | 'ready' | 'failed'>('loading')
const chosen = ref<string[]>([])
const projectId = ref('')
const mode = ref<RoundtableDelivery>('instant')
const sending = ref(false)
const error = ref<string | null>(null)
const controller = new AbortController()
const query = ref('')
const shown = computed(() => {
  const text = query.value.trim().toLocaleLowerCase()
  return text ? agents.value.filter(agent => (agent.name + ' ' + (agent.responsibility ?? '')).toLocaleLowerCase().includes(text)) : agents.value
})
const chosenAgents = computed(() => chosen.value.map(id => agents.value.find(agent => agent.agentId === id)).filter((agent): agent is RoundtableDirectoryAgent => Boolean(agent)))

const projectNames = computed(() => new Map((store.state?.personalProjects ?? [])
  .map(project => [project.project_id, projectDisplayName(project)])))
// The projects every chosen FLA works in; one is picked for them, several are offered.
const shared = computed(() => {
  const picked = agents.value.filter(agent => chosen.value.includes(agent.agentId))
  if (!picked.length) return []
  return picked.map(agent => agent.projects).reduce((left, right) => left.filter(id => right.includes(id)))
})
const project = computed(() => shared.value.length === 1 ? shared.value[0]! : shared.value.includes(projectId.value) ? projectId.value : '')

async function load() {
  state.value = 'loading'
  try {
    agents.value = (await listDirectoryAgents(controller.signal)).agents
    state.value = 'ready'
  } catch { if (!controller.signal.aborted) state.value = 'failed' }
}
function toggle(agentId: string, on: boolean) {
  chosen.value = on ? [...chosen.value, agentId] : chosen.value.filter(id => id !== agentId)
}
async function send(body: string) {
  sending.value = true
  error.value = null
  try {
    const thread = await postMessage(null, { to: chosen.value, body, mode: mode.value, projectId: project.value })
    await router.push(`/roundtables/${encodeURIComponent(thread.id)}`)
  } catch (cause) {
    error.value = t('roundtable.composer.failed', { reason: apiErrorReason(cause) })
  } finally { sending.value = false }
}
onMounted(load)
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <section class="rt-new" :aria-label="t('roundtable.start.title')" data-roundtable-new>
    <header class="rt-new-head">
      <h2 class="rt-new-title">{{ t('roundtable.start.title') }}</h2>
      <Button size="sm" variant="ghost" @click="emit('close')">{{ t('roundtable.start.cancel') }}</Button>
    </header>
    <GrowthLoading v-if="state === 'loading'" variant="compact" :label="t('roundtable.start.loading')" />
    <p v-else-if="state === 'failed'" class="rt-new-note" role="alert">
      {{ t('roundtable.start.loadFailed') }} <Button size="sm" variant="ghost" @click="load">{{ t('roundtable.retry') }}</Button>
    </p>
    <p v-else-if="!agents.length" class="rt-new-note">{{ t('roundtable.start.none') }}</p>
    <template v-else>
      <!-- To: the chosen FLAs as chips, then a field that narrows the list below. -->
      <div class="rt-new-to">
        <span class="rt-new-to-label">{{ t('roundtable.start.to') }}</span>
        <button v-for="agent in chosenAgents" :key="agent.agentId" type="button" class="rt-chip" :disabled="sending"
          :aria-label="t('roundtable.start.remove', { name: agent.name })" @click="toggle(agent.agentId, false)">
          {{ agent.name }}<UiIcon name="close" :size="12" />
        </button>
        <input v-model="query" class="rt-new-search" type="search" :placeholder="t('roundtable.start.search')" :aria-label="t('roundtable.start.who')" />
      </div>
      <ul class="rt-new-list" :aria-label="t('roundtable.start.who')">
        <li v-for="agent in shown" :key="agent.agentId" :data-roundtable-agent="agent.agentId">
          <button type="button" class="rt-new-row" role="checkbox" :aria-checked="chosen.includes(agent.agentId)" :disabled="sending"
            @click="toggle(agent.agentId, !chosen.includes(agent.agentId))">
            <span class="rt-new-face" :style="agentIdentityStyle(agent.agentId)" aria-hidden="true"><img :src="agentAvatarUrl(agent.agentId)" alt="" /></span>
            <span class="rt-new-who"><strong>{{ agent.name }}</strong><small v-if="agent.responsibility">{{ agent.responsibility }}</small></span>
            <span class="rt-new-check" aria-hidden="true"><UiIcon v-if="chosen.includes(agent.agentId)" name="check" :size="14" /></span>
          </button>
        </li>
        <li v-if="!shown.length" class="rt-new-note">{{ t('roundtable.start.noMatch', { query: query.trim() }) }}</li>
      </ul>
      <div v-if="shared.length > 1" class="rt-new-project">
        <Select v-model="projectId">
          <SelectTrigger class="w-auto min-w-48" :aria-label="t('roundtable.start.project')" data-roundtable-project>
            <SelectValue :placeholder="t('roundtable.start.chooseProject')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="id in shared" :key="id" :value="id">{{ projectNames.get(id) ?? id }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <UiNotice v-else-if="chosen.length && !shared.length" tone="warning">{{ t('roundtable.start.noSharedProject') }}</UiNotice>
      <RoundtableComposer :mode="mode" :sending="sending" :error="error" :disabled="!chosen.length || !project"
        @update:mode="value => mode = value" @send="send" />
    </template>
  </section>
</template>

<style scoped>
.rt-new {
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  border-radius: var(--radius-shell); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border);
}
.rt-new-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 10px 24px; }
.rt-new-title { margin: 0; font-size: var(--text-section); font-weight: var(--weight-strong); }
.rt-new-to { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 24px; border-block: 1px solid var(--color-border); }
.rt-new-to-label { color: var(--color-muted); font-size: var(--text-control); }
.rt-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px 0 10px; border: 0; border-radius: var(--radius-pill);
  color: var(--color-on-accent); background: var(--color-accent); font: inherit; font-size: var(--text-control); font-weight: var(--weight-medium); cursor: pointer;
}
.rt-new-search { flex: 1 1 160px; min-width: 120px; height: 28px; border: 0; outline: 0; background: transparent; font: inherit; font-size: var(--text-body); color: var(--color-ink); }
.rt-new-list { flex: 1 1 auto; min-height: 0; max-height: 46vh; margin: 0; padding: 4px 0; overflow-y: auto; list-style: none; }
.rt-new-list > li + li .rt-new-row::before { content: ''; position: absolute; top: 0; right: 0; left: 72px; height: 1px; background: var(--color-border); }
.rt-new-row {
  position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr) 22px; align-items: center; gap: 12px; width: 100%;
  padding: 10px 24px; border: 0; color: var(--color-ink); background: transparent; font: inherit; text-align: left; cursor: pointer; transition: background var(--motion-fast);
}
.rt-new-row:hover { background: var(--color-surface-subtle); }
.rt-new-row:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.rt-new-face { display: grid; width: 36px; height: 36px; overflow: hidden; place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-surface-hover)); }
.rt-new-face img { width: 100%; height: 100%; object-fit: cover; }
.rt-new-who { display: grid; min-width: 0; }
.rt-new-who strong { font-size: var(--text-body); font-weight: var(--weight-medium); }
.rt-new-who small { overflow: hidden; color: var(--color-muted); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
.rt-new-check { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 50%; color: var(--color-on-accent); box-shadow: inset 0 0 0 1.5px var(--color-control-border); }
.rt-new-row[aria-checked="true"] .rt-new-check { background: var(--color-accent); box-shadow: none; }
.rt-new-project { padding: 8px 24px 0; }
.rt-new-note { margin: 0; padding: 16px 24px; color: var(--color-muted); font-size: var(--text-control); }
</style>
