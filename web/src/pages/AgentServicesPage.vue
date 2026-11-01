<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiErrorReason, getJson } from '@/api/client'
import ServiceLog from '@/features/agent-services/ServiceLog.vue'
import {
  clearServiceLog, deleteService, listServices, readServiceLog, stopService, type AgentService, type ServiceLog as ServiceLogRecord,
} from '@/features/agent-services/agent-services'
import { readServiceSearch, serviceGroups, serviceSearchLocationQuery, visibleServices } from '@/features/agent-services/service-table'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { normalizeAgent } from '@/features/project-agents/agent-roster-records'
import { agentValues } from '@/features/project-agents/task-evidence'
import { formatDate, sourceLabel } from '@/features/project-agents/task-labels'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ConversationSourceApplication } from '@/types'
import { UiDialog, UiIcon } from '@/ui'

// 服务管理 (rec#11 D-71): every service an FLA started and each Agent's
// workbench, with the state checked live on each read. Rows are grouped by
// that state, one line each under the address; a running web address opens
// from the right, and the owner, PID and command fold under the row with its
// log, stop and delete. Stopping a process shows its exact PID and command first; the
// request carries that PID back.
const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const projects = computed(() => store.state?.personalProjects ?? [])

// FLA names come from the space's roster; an Agent the roster cannot name shows its id.
const agentNames = ref(new Map<string, string>())
async function loadAgentNames() {
  if (!spaceId.value) return
  try {
    const roster = agentValues(await getJson<unknown>(`/api/project-agents?${new URLSearchParams({ personalSpaceId: spaceId.value })}`))
      .map(value => normalizeAgent(value, spaceId.value))
    agentNames.value = new Map(roster.map(agent => [agent.agentId, agent.profile.displayName ?? agent.profile.name]))
  } catch {
    agentNames.value = new Map()
  }
}
const names = {
  agent: (id: string | null) => (id ? agentNames.value.get(id) ?? id : t('agentServices.unknownAgent')),
  project: (id: string | null) => (id ? projects.value.find(project => project.project_id === id)?.profile.name ?? id : t('agentServices.noProject')),
}
const clientLabel = (service: AgentService) => (service.client === 'fuli' ? t('agentServices.fuli')
  : sourceLabel(service.client as ConversationSourceApplication | null))

const services = ref<AgentService[]>([])
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
let readGeneration = 0
async function load() {
  const generation = ++readGeneration
  loading.value = true
  loadError.value = ''
  try {
    const result = await listServices()
    if (generation !== readGeneration) return
    services.value = result.services
    loaded.value = true
  } catch (cause) {
    if (generation === readGeneration) loadError.value = apiErrorReason(cause, t('agentServices.loadFailed'))
  } finally {
    if (generation === readGeneration) loading.value = false
  }
}
onMounted(() => { if (!store.state) void store.refresh(); void load(); void loadAgentNames() })
watch(spaceId, () => { void loadAgentNames() })

// The search lives in the URL.
const search = computed(() => readServiceSearch(route.query))
function setSearch(value: string) {
  void router.replace({ query: serviceSearchLocationQuery(route.query, value) })
}
const rows = computed(() => visibleServices(services.value, search.value, names, currentLocale()))
const groups = computed(() => serviceGroups(rows.value))
const KIND_ICONS = { workbench: 'grid', agent_service: 'power' } as const
const webAddress = (service: AgentService) => (service.address && /^https?:\/\//i.test(service.address) ? service.address : null)
const openable = (service: AgentService) => service.live.state === 'running' && Boolean(webAddress(service))
// One column for the right-hand action, kept for every row once any has one, so the chevrons line up.
const actionSlot = computed(() => stopping.value || rows.value.some(openable))
const ownerLine = (service: AgentService) => [names.agent(service.agentId), service.projectId ? names.project(service.projectId) : '',
  [clientLabel(service), sessionShort(service.sessionId)].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
const openRow = ref('')
const toggle = (id: string) => { openRow.value = openRow.value === id ? '' : id }
const liveTitle = (service: AgentService) => [service.live.process && t(`agentServices.process.${service.live.process}`),
  service.address && t(`agentServices.port.${service.live.port}`)].filter(Boolean).join(' · ')
const sessionShort = (id: string | null) => (id ? t('agentServices.sessionShort', { id: id.slice(0, 8) }) : '')

// The log opens in a dialog; the person can clear it there.
const logTarget = ref<AgentService | null>(null)
const log = ref<ServiceLogRecord | null>(null)
const logLoading = ref(false)
const logError = ref('')
const clearing = ref(false)
const confirmClear = ref(false)
async function openLog(service: AgentService) {
  logTarget.value = service
  log.value = null
  confirmClear.value = false
  await refreshLog()
}
async function refreshLog() {
  const target = logTarget.value
  if (!target) return
  logLoading.value = true
  logError.value = ''
  try {
    const result = await readServiceLog(target.serviceId)
    if (logTarget.value === target) log.value = result
  } catch (cause) {
    if (logTarget.value === target) logError.value = apiErrorReason(cause, t('agentServices.log.loadFailed'))
  } finally {
    logLoading.value = false
  }
}
async function clearLog() {
  if (!logTarget.value) return
  clearing.value = true
  try {
    await clearServiceLog(logTarget.value.serviceId)
    confirmClear.value = false
    await refreshLog()
  } catch (cause) {
    logError.value = apiErrorReason(cause)
  } finally {
    clearing.value = false
  }
}

// Stop: the dialog shows the exact PID, executable and command line; a
// workbench is stopped through its app runner instead.
const stopTarget = ref<AgentService | null>(null)
const stopping = ref(false)
const stopError = ref('')
const notice = ref('')
function askStop(service: AgentService) {
  stopTarget.value = service
  stopError.value = ''
}
async function confirmStop() {
  const target = stopTarget.value
  if (!target) return
  stopping.value = true
  stopError.value = ''
  try {
    const result = await stopService(target)
    notice.value = result.status === 'still_running' ? t('agentServices.stop.stillRunning')
      : result.status === 'already_stopped' ? t('agentServices.stop.alreadyStopped') : ''
    stopTarget.value = null
    await load()
  } catch (cause) {
    stopError.value = apiErrorReason(cause)
  } finally {
    stopping.value = false
  }
}

const deleteTarget = ref<AgentService | null>(null)
const deleting = ref(false)
const deleteError = ref('')
async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  deleteError.value = ''
  try {
    await deleteService(target.serviceId)
    deleteTarget.value = null
    services.value = services.value.filter(service => service.serviceId !== target.serviceId)
  } catch (cause) {
    deleteError.value = apiErrorReason(cause)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <section class="view agent-services-view">
    <div class="services">
      <header v-if="services.length" class="services-bar">
        <Input type="search" maxlength="120" class="services-search" :model-value="search" :placeholder="t('agentServices.search')"
          :aria-label="t('agentServices.search')" data-service-search @update:model-value="setSearch(String($event))" />
        <GrowthLoading v-if="loading" variant="inline" :label="t('agentServices.loading')" />
        <Button variant="ghost" :disabled="loading" data-service-refresh @click="load">
          <UiIcon name="refresh" :size="14" />{{ t('agentServices.refresh') }}
        </Button>
      </header>
      <p v-if="notice" role="status" class="services-notice">{{ notice }}</p>
      <p v-if="loadError && services.length" role="alert" class="inline-error services-notice">
        {{ loadError }} <Button size="sm" variant="ghost" @click="load">{{ t('agentServices.retry') }}</Button>
      </p>

      <GrowthLoading v-if="loading && !services.length" :label="t('agentServices.loading')" />
      <div v-else-if="loadError && !services.length" class="services-empty" role="alert">
        <p>{{ loadError }}</p>
        <Button size="sm" variant="outline" @click="load">{{ t('agentServices.retry') }}</Button>
      </div>
      <p v-else-if="loaded && !services.length" class="services-empty" data-service-empty>{{ t('agentServices.empty') }}</p>
      <p v-else-if="services.length && !rows.length" class="services-empty">{{ t('agentServices.noMatch') }}</p>

      <section v-for="group in groups" :key="group.key" class="services-group" :aria-labelledby="`services-group-${group.key}`" :data-service-group="group.key">
        <h2 :id="`services-group-${group.key}`" class="services-group-label">{{ t(`agentServices.state.${group.key}`) }} <span class="ui-num">{{ group.rows.length }}</span></h2>
        <ul class="services-list">
          <li v-for="service in group.rows" :key="service.serviceId" class="service" :class="{ 'is-open': openRow === service.serviceId }" :data-service-row="service.serviceId">
            <div class="service-head">
              <Button variant="ghost" class="service-toggle" :aria-expanded="openRow === service.serviceId" :aria-controls="`service-detail-${service.serviceId}`"
                data-service-toggle @click="toggle(service.serviceId)">
                <span class="service-icon" aria-hidden="true"><UiIcon :name="KIND_ICONS[service.kind] ?? 'power'" :size="18" /></span>
                <span class="service-text">
                  <span class="service-title" :title="service.purpose">{{ service.purpose }}</span>
                  <span class="service-meta">{{ service.address ?? t(`agentServices.kind.${service.kind}`) }}</span>
                </span>
                <span class="service-face" :class="{ 'is-none': !service.agentId }" :style="service.agentId ? agentIdentityStyle(service.agentId) : undefined" :title="names.agent(service.agentId)">
                  <img v-if="service.agentId" :src="agentAvatarUrl(service.agentId)" alt="" />
                  <span class="ui-sr-only">{{ names.agent(service.agentId) }}</span>
                </span>
                <UiIcon name="chevron-down" :size="16" class="service-chevron" />
              </Button>
              <span v-if="actionSlot" class="service-action">
                <GrowthLoading v-if="stopping && stopTarget?.serviceId === service.serviceId" variant="inline"
                  :label="t('agentServices.stop.stopping', { name: service.purpose })" />
                <Button v-else-if="openable(service)" as="a" variant="outline" size="sm"
                  :href="webAddress(service)!" target="_blank" rel="noreferrer" data-service-open>
                  {{ t('agentServices.open') }}<UiIcon name="external" :size="14" />
                </Button>
              </span>
            </div>
            <div v-if="openRow === service.serviceId" :id="`service-detail-${service.serviceId}`" class="service-detail" data-service-detail>
              <dl class="service-facts">
                <dt>{{ t('agentServices.facts.owner') }}</dt><dd :title="service.sessionId ?? undefined">{{ ownerLine(service) }}</dd>
                <dt>{{ t('agentServices.facts.started') }}</dt><dd class="tabular-nums">
                  {{ formatDate(service.startedAt) }}<template v-if="service.stoppedAt"> · {{ t('agentServices.stoppedAt', { time: formatDate(service.stoppedAt) }) }}</template>
                </dd>
                <template v-if="liveTitle(service)"><dt>{{ t('agentServices.facts.state') }}</dt><dd data-service-state>{{ liveTitle(service) }}</dd></template>
                <template v-if="service.pid"><dt>PID</dt><dd class="tabular-nums">{{ service.pid }}</dd></template>
                <template v-if="service.command ?? service.commandLine"><dt>{{ t('agentServices.facts.command') }}</dt><dd><code>{{ service.commandLine ?? service.command }}</code></dd></template>
              </dl>
              <div class="service-actions">
                <Button variant="ghost" size="sm" data-service-delete @click="deleteTarget = service; deleteError = ''">{{ t('agentServices.actions.delete') }}</Button>
                <Button variant="outline" size="sm" data-service-log-open @click="openLog(service)">{{ t('agentServices.actions.log') }}</Button>
                <Button v-if="service.live.state !== 'stopped'" variant="outline" size="sm" data-service-stop @click="askStop(service)">{{ t('agentServices.actions.stop') }}</Button>
              </div>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <UiDialog :open="Boolean(logTarget)" size="lg" :title="t('agentServices.log.title', { name: logTarget?.purpose ?? '' })" :busy="clearing" @close="logTarget = null">
      <ServiceLog :log="log" :loading="logLoading" :error="logError" :name="logTarget?.purpose ?? ''" />
      <template #footer>
        <GrowthLoading v-if="clearing" variant="inline" :label="t('agentServices.log.clearing', { name: logTarget?.purpose ?? '' })" />
        <Button v-else-if="confirmClear" variant="destructive" data-service-log-clear-confirm @click="clearLog">{{ t('agentServices.log.clearConfirm') }}</Button>
        <Button v-else variant="outline" :disabled="!log?.entries.length" data-service-log-clear @click="confirmClear = true">{{ t('agentServices.log.clear') }}</Button>
        <Button variant="ghost" :disabled="clearing" @click="logTarget = null">{{ t('agentServices.log.close') }}</Button>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(stopTarget)" size="md" :title="t('agentServices.stop.title')" :busy="stopping" :error="stopError" @close="stopTarget = null">
      <template v-if="stopTarget">
        <p class="m-0 font-semibold">{{ stopTarget.purpose }}</p>
        <p v-if="stopTarget.kind === 'workbench'" class="m-0">{{ t('agentServices.stop.workbench') }}</p>
        <p v-else-if="!stopTarget.pid" class="m-0">{{ t('agentServices.stop.noPid') }}</p>
        <template v-else>
          <p class="m-0">{{ t('agentServices.stop.body') }}</p>
          <dl class="agent-services-identity" data-service-stop-identity>
            <dt>{{ t('agentServices.stop.pidLabel') }}</dt><dd class="tabular-nums">{{ stopTarget.pid }}</dd>
            <dt>{{ t('agentServices.stop.executableLabel') }}</dt><dd><code>{{ stopTarget.executable }}</code></dd>
            <dt>{{ t('agentServices.stop.commandLabel') }}</dt><dd><code>{{ stopTarget.commandLine }}</code></dd>
          </dl>
        </template>
      </template>
      <template #footer>
        <Button variant="ghost" :disabled="stopping" @click="stopTarget = null">{{ t('agentServices.cancel') }}</Button>
        <Button v-if="stopTarget && (stopTarget.kind === 'workbench' || stopTarget.pid)" variant="destructive" :loading="stopping"
          :loading-label="t('agentServices.stop.stopping', { name: stopTarget.purpose })" data-service-stop-confirm @click="confirmStop">
          {{ stopTarget.kind === 'workbench' ? t('agentServices.stop.confirmWorkbench') : t('agentServices.stop.confirm') }}
        </Button>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(deleteTarget)" size="sm" :title="t('agentServices.delete.title')" :busy="deleting" :error="deleteError" @close="deleteTarget = null">
      <p class="m-0 font-semibold">{{ deleteTarget?.purpose }}</p>
      <p class="m-0">{{ t('agentServices.delete.body') }}</p>
      <template #footer>
        <Button variant="ghost" :disabled="deleting" @click="deleteTarget = null">{{ t('agentServices.cancel') }}</Button>
        <Button variant="destructive" :loading="deleting" :loading-label="t('agentServices.delete.deleting', { name: deleteTarget?.purpose ?? '' })"
          data-service-delete-confirm @click="confirmDelete">{{ t('agentServices.delete.confirm') }}</Button>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
/* The page is the one scroll container; the list grows with its rows. */
.agent-services-view { padding-bottom: 16px; }
.services { display: flex; flex-direction: column; gap: 28px; width: 100%; }
.services-bar { display: flex; align-items: center; gap: 12px; min-height: var(--control-height-md); }
.services-bar :deep(.services-search) { flex: 0 1 320px; margin-right: auto; }
.services-notice { margin: 0; font-size: var(--text-control); }
.services-empty { display: grid; justify-items: center; gap: 10px; margin: 0; padding: 48px 16px; border-radius: var(--radius-card); color: var(--color-muted); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); text-align: center; }
.services-empty p { margin: 0; }
.services-group { display: grid; gap: 8px; }
.services-group-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 18px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.services-group-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
/* An inset grouped list: one white surface, rows split by hairlines that start after the icon. */
.services-list { margin: 0; padding: 0; overflow: hidden; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); list-style: none; }
.service { position: relative; }
.service + .service::before { content: ''; position: absolute; top: 0; right: 0; left: 64px; height: 1px; background: var(--color-border); }
/* The whole head lights on hover, action column included. */
.service-head { display: flex; align-items: center; gap: 12px; padding-right: 16px; transition: background-color var(--motion-fast) ease; }
.service-head:hover, .service.is-open .service-head { background: var(--color-surface-hover); }
.service-head .service-toggle:hover { background: transparent; }
.service-toggle {
  display: grid; flex: 1; grid-template-columns: 36px minmax(0, 1fr) auto 16px; align-items: center; gap: 14px; min-width: 0;
  height: auto; padding: 12px 16px; border-radius: 0; color: var(--color-ink); font-weight: var(--weight-regular); text-align: left; white-space: normal;
}
.service-icon { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 10px; color: var(--color-ink-soft); background: var(--color-surface-hover); }
.service-text { display: grid; gap: 2px; min-width: 0; }
.service-title { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.service-meta { overflow: hidden; color: var(--color-muted); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
.service-face { display: grid; width: 24px; height: 24px; overflow: hidden; place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-surface-hover)); }
.service-face.is-none { background: none; }
.service-action { display: flex; flex: 0 0 auto; justify-content: flex-end; min-width: 76px; }
.service-face img { width: 100%; height: 100%; object-fit: cover; }
.service-chevron { color: var(--color-faint); transition: transform var(--motion-fast) ease; }
.service.is-open .service-chevron { transform: rotate(180deg); }
.service-detail { display: grid; gap: 12px; padding: 0 16px 16px 66px; }
.service-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 0; font-size: var(--text-control); }
.service-facts dt { color: var(--color-muted); }
.service-facts dd { margin: 0; overflow-wrap: anywhere; }
.service-facts code { font-size: 12px; }
.service-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 640px) {
  .service-toggle { grid-template-columns: 36px minmax(0, 1fr) 16px; }
  .service-face { display: none; }
  .service-detail { padding-left: 16px; }
}
@media (prefers-reduced-motion: reduce) { .service-chevron, .service-head { transition: none; } }
:root[data-motion="reduced"] .service-chevron, :root[data-motion="reduced"] .service-head { transition: none; }
.agent-services-identity { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 13px; }
.agent-services-identity dt { color: var(--color-muted); }
.agent-services-identity dd { margin: 0; overflow-wrap: anywhere; }
</style>
