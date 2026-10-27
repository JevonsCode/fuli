<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { apiErrorReason, getJson } from '@/api/client'
import ServiceLog from '@/features/agent-services/ServiceLog.vue'
import {
  clearServiceLog, deleteService, listServices, readServiceLog, stopService, type AgentService, type ServiceLog as ServiceLogRecord,
} from '@/features/agent-services/agent-services'
import { liveStateTone } from '@/features/agent-services/service-labels'
import {
  readServiceTableQuery, SERVICE_KIND_FILTERS, SERVICE_STATE_FILTERS, serviceOwners, serviceTableLocationQuery, visibleServices,
  type ServiceTableQuery,
} from '@/features/agent-services/service-table'
import { normalizeAgent } from '@/features/project-agents/agent-roster-records'
import { agentValues } from '@/features/project-agents/task-evidence'
import { formatDate, sourceLabel } from '@/features/project-agents/task-labels'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ConversationSourceApplication } from '@/types'
import { UiDialog, UiIcon, UiSelect } from '@/ui'

// 服务管理 (rec#11 D-71): every service an FLA started and each Agent's
// workbench, with the state checked live on each read. Stopping a process
// shows its exact PID and command first; the request carries that PID back.
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

// Search and filters live in the URL.
const tableQuery = computed(() => readServiceTableQuery(route.query))
function setTableQuery(change: Partial<ServiceTableQuery>) {
  void router.replace({ query: serviceTableLocationQuery(route.query, { ...tableQuery.value, ...change }) })
}
const rows = computed(() => visibleServices(services.value, tableQuery.value, names, currentLocale()))
const owners = computed(() => serviceOwners(services.value))
const agentOptions = computed(() => [{ value: 'all', label: t('agentServices.filter.allAgents') },
  ...owners.value.agents.map(id => ({ value: id, label: names.agent(id) }))])
const projectOptions = computed(() => [{ value: 'all', label: t('agentServices.filter.allProjects') },
  ...owners.value.projects.map(id => ({ value: id, label: names.project(id) }))])
const kindOptions = computed(() => SERVICE_KIND_FILTERS.map(value => ({ value,
  label: value === 'all' ? t('agentServices.filter.allKinds') : t(`agentServices.kind.${value}`) })))
const stateOptions = computed(() => SERVICE_STATE_FILTERS.map(value => ({ value,
  label: value === 'all' ? t('agentServices.filter.allStates') : t(`agentServices.state.${value}`) })))
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
    <div class="mx-auto flex min-h-0 w-full max-w-(--layout-max) flex-1 flex-col gap-3">
      <p class="page-lede m-0 text-sm text-muted-foreground">{{ t('agentServices.lede') }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <label class="agent-services-search">
          <span class="ui-sr-only">{{ t('agentServices.search') }}</span>
          <input type="search" maxlength="120" :value="tableQuery.search" :placeholder="t('agentServices.search')"
            data-service-search @input="setTableQuery({ search: ($event.target as HTMLInputElement).value })" />
        </label>
        <UiSelect class="agent-services-select" :model-value="tableQuery.agent" :options="agentOptions" :label="t('agentServices.filter.agent')"
          data-service-agent-filter @update:model-value="setTableQuery({ agent: String($event) })" />
        <UiSelect class="agent-services-select" :model-value="tableQuery.project" :options="projectOptions" :label="t('agentServices.filter.project')"
          data-service-project-filter @update:model-value="setTableQuery({ project: String($event) })" />
        <UiSelect class="agent-services-select" :model-value="tableQuery.kind" :options="kindOptions" :label="t('agentServices.filter.kind')"
          data-service-kind-filter @update:model-value="setTableQuery({ kind: $event as ServiceTableQuery['kind'] })" />
        <UiSelect class="agent-services-select" :model-value="tableQuery.state" :options="stateOptions" :label="t('agentServices.filter.state')"
          data-service-state-filter @update:model-value="setTableQuery({ state: $event as ServiceTableQuery['state'] })" />
        <div class="ml-auto flex items-center gap-2">
          <GrowthLoading v-if="loading && services.length" variant="inline" :label="t('agentServices.loading')" />
          <Button variant="ghost" size="sm" :disabled="loading" data-service-refresh @click="load">{{ t('agentServices.refresh') }}</Button>
        </div>
      </div>
      <p v-if="notice" role="status" class="m-0 text-sm">{{ notice }}</p>
      <p v-if="loadError && services.length" role="alert" class="inline-error m-0">
        {{ loadError }} <Button size="sm" variant="ghost" @click="load">{{ t('agentServices.retry') }}</Button>
      </p>

      <div class="flex min-h-0 flex-1 flex-col">
        <GrowthLoading v-if="loading && !services.length" variant="compact" :label="t('agentServices.loading')" />
        <div v-else-if="loadError && !services.length" class="ui-empty rounded-lg border bg-card text-destructive" role="alert">
          <p class="m-0">{{ loadError }}</p>
          <Button class="mt-3" size="sm" variant="outline" @click="load">{{ t('agentServices.retry') }}</Button>
        </div>
        <div v-else-if="loaded && !services.length" class="ui-empty rounded-lg border bg-card" data-service-empty>
          <p class="m-0">{{ t('agentServices.empty') }}</p>
        </div>
        <Table v-else-if="services.length" class="min-w-[880px]" container-class="min-h-0 shrink rounded-lg border bg-card">
          <TableHeader class="sticky top-0 z-[1] bg-card shadow-[0_1px_0_var(--border)] [&_tr]:border-b-0">
            <TableRow class="hover:bg-transparent">
              <TableHead class="min-w-[220px] pl-4">{{ t('agentServices.columns.purpose') }}</TableHead>
              <TableHead>{{ t('agentServices.columns.address') }}</TableHead>
              <TableHead>{{ t('agentServices.columns.owner') }}</TableHead>
              <TableHead>{{ t('agentServices.columns.started') }}</TableHead>
              <TableHead>{{ t('agentServices.columns.state') }}</TableHead>
              <TableHead>{{ t('agentServices.columns.command') }}</TableHead>
              <TableHead class="w-12 pr-4 text-right"><span class="sr-only">{{ t('agentServices.columns.actions') }}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="service in rows" :key="service.serviceId" :data-service-row="service.serviceId">
              <TableCell class="pl-4">
                <span class="line-clamp-2 font-semibold [overflow-wrap:anywhere]" :title="service.purpose">{{ service.purpose }}</span>
                <span class="block text-xs text-muted-foreground">{{ t(`agentServices.kind.${service.kind}`) }}</span>
              </TableCell>
              <TableCell class="max-w-[220px] [overflow-wrap:anywhere]">
                <a v-if="service.address && /^https?:\/\//i.test(service.address)" :href="service.address" target="_blank" rel="noreferrer">{{ service.address }}</a>
                <span v-else-if="service.address">{{ service.address }}</span>
                <span v-else class="text-muted-foreground">{{ t('agentServices.noAddress') }}</span>
              </TableCell>
              <TableCell class="max-w-[240px]">
                <span class="block font-medium">{{ names.agent(service.agentId) }}</span>
                <span class="block text-xs text-muted-foreground">{{ names.project(service.projectId) }}</span>
                <span class="block text-xs text-muted-foreground" :title="service.sessionId ?? undefined">
                  {{ clientLabel(service) }}<template v-if="service.sessionId"> · {{ sessionShort(service.sessionId) }}</template>
                </span>
              </TableCell>
              <TableCell class="whitespace-nowrap tabular-nums">
                {{ formatDate(service.startedAt) }}
                <span v-if="service.stoppedAt" class="block text-xs text-muted-foreground">{{ t('agentServices.stoppedAt', { time: formatDate(service.stoppedAt) }) }}</span>
              </TableCell>
              <TableCell class="whitespace-nowrap">
                <GrowthLoading v-if="stopping && stopTarget?.serviceId === service.serviceId" variant="inline"
                  :label="t('agentServices.stop.stopping', { name: service.purpose })" />
                <Badge v-else :variant="liveStateTone(service.live.state)" :title="liveTitle(service) || undefined" data-service-state>
                  {{ t(`agentServices.state.${service.live.state}`) }}
                </Badge>
                <span v-if="service.pid" class="block text-xs tabular-nums text-muted-foreground">{{ t('agentServices.pid', { pid: service.pid }) }}</span>
              </TableCell>
              <TableCell class="max-w-[260px]">
                <code class="line-clamp-2 text-xs [overflow-wrap:anywhere]" :title="service.commandLine ?? service.command ?? undefined">{{ service.command ?? service.commandLine }}</code>
              </TableCell>
              <TableCell class="pr-4 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="icon-sm" :aria-label="t('agentServices.rowActions', { name: service.purpose })" data-service-actions>
                      <UiIcon name="more" :size="16" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem data-service-log-open @select="openLog(service)">{{ t('agentServices.actions.log') }}</DropdownMenuItem>
                    <DropdownMenuItem v-if="service.live.state !== 'stopped'" data-service-stop @select="askStop(service)">{{ t('agentServices.actions.stop') }}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem data-service-delete @select="deleteTarget = service; deleteError = ''">{{ t('agentServices.actions.delete') }}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
            <TableEmpty v-if="!rows.length" :colspan="7">{{ t('agentServices.noMatch') }}</TableEmpty>
          </TableBody>
        </Table>
      </div>
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
.agent-services-view { display: flex; flex-direction: column; overflow: hidden; padding-bottom: 16px; }
.agent-services-search { flex: 1 1 220px; max-width: 320px; }
.agent-services-search input { box-sizing: border-box; width: 100%; }
.agent-services-view :deep(.agent-services-select) { flex: 0 0 160px; min-width: 0; }
.agent-services-identity { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 13px; }
.agent-services-identity dt { color: var(--color-muted); }
.agent-services-identity dd { margin: 0; overflow-wrap: anywhere; }
</style>
