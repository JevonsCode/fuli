<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import UiNotice from '@/ui/UiNotice.vue'
import { projectDisplayName } from '@/features/projects/project-origin'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { listDirectoryAgents, postMessage, type RoundtableDelivery, type RoundtableDirectoryAgent } from './roundtable-api'
import RoundtableComposer from './RoundtableComposer.vue'

// Starts the person's conversation with one FLA, or a group of them, in the
// project they share. The new thread opens once the server recorded the message.
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
  <section class="roundtable-new" :aria-label="t('roundtable.start.title')" data-roundtable-new>
    <header class="roundtable-new-head">
      <strong>{{ t('roundtable.start.title') }}</strong>
      <Button size="sm" variant="ghost" @click="emit('close')">{{ t('roundtable.start.cancel') }}</Button>
    </header>
    <GrowthLoading v-if="state === 'loading'" variant="compact" :label="t('roundtable.start.loading')" />
    <p v-else-if="state === 'failed'" role="alert">
      {{ t('roundtable.start.loadFailed') }} <Button size="sm" variant="ghost" @click="load">{{ t('roundtable.retry') }}</Button>
    </p>
    <p v-else-if="!agents.length" class="ui-meta">{{ t('roundtable.start.none') }}</p>
    <template v-else>
      <fieldset class="roundtable-new-agents">
        <legend>{{ t('roundtable.start.who') }}</legend>
        <label v-for="agent in agents" :key="agent.agentId" class="roundtable-new-agent" :data-roundtable-agent="agent.agentId">
          <Checkbox :model-value="chosen.includes(agent.agentId)" :disabled="sending"
            @update:model-value="value => toggle(agent.agentId, value === true)" />
          <span><strong>{{ agent.name }}</strong><small v-if="agent.responsibility">{{ agent.responsibility }}</small></span>
        </label>
      </fieldset>
      <div v-if="shared.length > 1" class="roundtable-new-project">
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
.roundtable-new { display: grid; gap: 12px; padding: 16px 0 0; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
.roundtable-new > :not(.roundtable-composer) { margin: 0 20px; }
.roundtable-new-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.roundtable-new-agents { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 8px; margin: 0; padding: 0; border: 0; }
.roundtable-new-agents legend { margin-bottom: 8px; color: var(--color-muted); font-size: 12px; }
.roundtable-new-agent { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 10px; cursor: pointer; }
.roundtable-new-agent span { display: grid; min-width: 0; gap: 2px; font-size: 13px; }
.roundtable-new-agent small { overflow: hidden; color: var(--color-faint); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.roundtable-new-project { display: flex; }
</style>
