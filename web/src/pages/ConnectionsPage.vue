<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { deleteJson, getJson, patchJson, postJson } from '@/api/client'
import SearchableMultiSelect from '@/components/SearchableMultiSelect.vue'
import SearchableSelect, { type SearchableSelectOption } from '@/components/SearchableSelect.vue'
import TextField from '@/components/TextField.vue'
import { currentLocale, t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type {
  ExternalKnowledgeBinding,
  ExternalKnowledgeBindingTarget,
  ExternalKnowledgeConnector,
  ExternalKnowledgeMode,
  KnowledgeConflictPolicy,
  PublicProject,
  Subscription,
} from '@/types'

type ConflictMode = KnowledgeConflictPolicy['mode']

const store = useConsoleStore()
const selectedProjectKey = ref('')
const subscriptionBusy = ref(false)
const subscriptionAction = ref('')
const connectors = ref<ExternalKnowledgeConnector[]>([])
const bindings = ref<ExternalKnowledgeBinding[]>([])
const externalBusy = ref(false)
const externalLoading = ref(false)
const externalAction = ref('')
const editingBindingId = ref<string | null>(null)
const editingProjectIds = ref<string[]>([])
const editingTargetModes = ref<Record<string, ExternalKnowledgeMode>>({})
const conflictProjectId = ref('')
const conflictMode = ref<ConflictMode>('ask_human')
const conflictBusy = ref(false)
const conflictLoading = ref(false)
const conflictError = ref(false)
let confirmedConflictMode: ConflictMode = 'ask_human'
let conflictVersion = 0
let conflictController: AbortController | null = null
const form = reactive({
  name: '',
  connectorType: 'mcp',
  mode: 'hybrid' as ExternalKnowledgeMode,
  personalProjectIds: [] as string[],
  mcpTransport: 'http',
  mcpUrl: '',
  mcpCommand: '',
  mcpArgs: '',
  mcpTokenEnv: '',
  mcpResourcePrefix: '',
  notionTokenEnv: '',
  notionPageIds: '',
  notionDataSourceIds: '',
  feishuTokenEnv: '',
  feishuRegion: 'cn',
  feishuSpaceId: '',
  feishuRootNodeToken: '',
  feishuNodeTokens: '',
  feishuWebBaseUrl: '',
  retrievalUrl: '',
  retrievalTokenEnv: '',
  retrievalKnowledgeIds: '',
  retrievalScoreThreshold: '0.5',
  customModule: '',
  customEnvironmentNames: '',
  customSourceJson: '{}',
})

const personalReady = computed(() => store.state?.providers?.personal?.status === 'ready')
const workspaces = computed(() => store.state?.providers?.workspaces ?? [])
const readyWorkspaces = computed(() => workspaces.value.filter(({ status }) => status === 'ready').length)
const publicPurpose = computed(() => {
  const capabilities = store.state?.capabilities
  const labels = [
    capabilities?.browsePublicProjects ? t('pages.connections.publicCapability.discovery') : null,
    capabilities?.subscribeProject ? t('pages.connections.publicCapability.subscription') : null,
    capabilities?.publishProject ? t('pages.connections.publicCapability.publishing') : null,
    capabilities?.submitKnowledge ? t('pages.connections.publicCapability.contribution') : null,
    capabilities?.reviewProposals ? t('pages.connections.publicCapability.review') : null,
  ].filter((label): label is string => Boolean(label))
  return labels.length
    ? new Intl.ListFormat(currentLocale(), { style: 'long', type: 'conjunction' }).format(labels)
    : t('pages.connections.notAvailable')
})
const subscriptions = computed(() => store.state?.subscriptions ?? [])
const personalProjects = computed(() => store.state?.personalProjects ?? [])
const externalKnowledgeHelpUrl = computed(() => readmeHelpUrl('connect-external-knowledge'))
const conflictPolicyHelpUrl = computed(() => readmeHelpUrl('external-knowledge-conflict-policy'))
const subscribedKeys = computed(
  () => new Set(subscriptions.value.map(({ provider_url, project_id }) => `${provider_url}::${project_id}`)),
)
const availableProjects = computed(() =>
  (store.state?.projects ?? []).filter((project) => !subscribedKeys.value.has(projectKey(project))),
)
const availableProjectOptions = computed(() =>
  availableProjects.value.map((project) => ({
    value: projectKey(project),
    label: project.name,
    meta: `#${compactIdentity(project.id, 26)}`,
    search: identitySearchText(project.id),
  })),
)
const connectorOptions = computed<SearchableSelectOption[]>(() =>
  connectors.value.map((connector) => ({
    value: connector.type,
    label: connector.name,
    meta: connector.description,
  })),
)
const personalProjectOptions = computed<SearchableSelectOption[]>(() =>
  personalProjects.value.map((project) => ({
    value: project.project_id,
    label: project.profile.name,
    meta: `#${compactIdentity(project.project_id, 26)}`,
    search: identitySearchText(project.project_id),
  })),
)
const bindingModeOptions = computed<SearchableSelectOption[]>(() => [
  { value: 'hybrid', label: t('pages.connections.mode.hybrid'), disabled: !connectorSupportsMode(form.connectorType, 'hybrid') },
  { value: 'mirror', label: t('pages.connections.mode.mirror'), disabled: !connectorSupportsMode(form.connectorType, 'mirror') },
  { value: 'live', label: t('pages.connections.mode.live'), disabled: !connectorSupportsMode(form.connectorType, 'live') },
])
const mcpTransportOptions = computed<SearchableSelectOption[]>(() => [
  { value: 'http', label: 'Streamable HTTP' },
  { value: 'stdio', label: 'stdio' },
])
const feishuRegionOptions = computed<SearchableSelectOption[]>(() => [
  { value: 'cn', label: 'Feishu' },
  { value: 'global', label: 'Lark' },
])
const conflictModeOptions = computed<SearchableSelectOption[]>(() => [
  { value: 'ask_human', label: t('pages.connections.askHuman') },
  { value: 'agent_decide', label: t('pages.connections.agentDecide') },
])

watch(personalProjects, (projects) => {
  const ids = new Set(projects.map(({ project_id }) => project_id))
  const first = projects[0]?.project_id ?? ''
  form.personalProjectIds = form.personalProjectIds.filter((id) => ids.has(id))
  if (!form.personalProjectIds.length && first) form.personalProjectIds = [first]
  editingProjectIds.value = editingProjectIds.value.filter((id) => ids.has(id))
  if (!ids.has(conflictProjectId.value)) {
    conflictProjectId.value = first
  }
}, { immediate: true })

watch(
  () => [store.activePersonalSpace?.id, conflictProjectId.value],
  () => void loadConflictPolicy(),
  { immediate: true, flush: 'sync' },
)

watch(() => form.connectorType, (type) => {
  if (connectorSupportsMode(type, form.mode)) return
  form.mode = firstSupportedMode(type)
})

onMounted(() => void refreshExternalKnowledge())

onBeforeUnmount(() => {
  conflictVersion += 1
  conflictController?.abort()
})

function projectKey(project: PublicProject) {
  return `${project.providerUrl}::${project.id}`
}

async function subscribe() {
  const personalSpaceId = store.activePersonalSpace?.id
  const project = availableProjects.value.find((item) => projectKey(item) === selectedProjectKey.value)
  if (!personalSpaceId || !project || subscriptionBusy.value) return
  subscriptionBusy.value = true
  subscriptionAction.value = 'pages.connections.subscribing'
  try {
    await postJson('/api/subscriptions', {
      personalSpaceId,
      projectId: project.id,
      providerUrl: project.providerUrl,
      projectName: project.name,
    })
    selectedProjectKey.value = ''
    store.notify(t('pages.connections.subscribed', { name: project.name }))
    subscriptionAction.value = 'pages.connections.loadingSubscriptions'
    await store.refresh()
  } catch (error) {
    store.reportError(error)
  } finally {
    subscriptionBusy.value = false
  }
}

async function unsubscribe(subscription: Subscription) {
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId || subscriptionBusy.value) return
  subscriptionBusy.value = true
  subscriptionAction.value = 'pages.connections.unsubscribing'
  try {
    const query = new URLSearchParams({
      personalSpaceId,
      providerUrl: subscription.provider_url,
    })
    await deleteJson(`/api/subscriptions/${encodeURIComponent(subscription.project_id)}?${query}`)
    store.notify(t('pages.connections.unsubscribed', {
      name: subscription.project_name ?? subscription.project_id,
    }))
    subscriptionAction.value = 'pages.connections.loadingSubscriptions'
    await store.refresh()
  } catch (error) {
    store.reportError(error)
  } finally {
    subscriptionBusy.value = false
  }
}

async function refreshExternalKnowledge() {
  externalLoading.value = true
  try {
    const [available, configured] = await Promise.all([
      getJson<ExternalKnowledgeConnector[]>('/api/external-knowledge/connectors'),
      getJson<ExternalKnowledgeBinding[]>('/api/external-knowledge/bindings'),
    ])
    connectors.value = available
    bindings.value = configured
  } catch (error) {
    store.reportError(error)
  } finally {
    externalLoading.value = false
  }
}

async function createBinding() {
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId || !form.personalProjectIds.length || externalBusy.value) return
  externalBusy.value = true
  externalAction.value = 'pages.connections.creatingBinding'
  try {
    const { connectorConfig, source } = bindingConnectorInput()
    await postJson('/api/external-knowledge/bindings', {
      name: form.name.trim(),
      connectorType: form.connectorType,
      connectorConfig,
      source,
      targets: form.personalProjectIds.map((personalProjectId) => ({
        personalSpaceId,
        personalProjectId,
        mode: form.mode,
      })),
    })
    store.notify(t('pages.connections.externalCreated', { name: form.name.trim() }))
    form.name = ''
    await refreshExternalKnowledge()
  } catch (error) {
    store.reportError(error)
  } finally {
    externalBusy.value = false
  }
}

function bindingConnectorInput(): {
  connectorConfig: Record<string, unknown>
  source: Record<string, unknown>
} {
  if (form.connectorType === 'notion') {
    return {
      connectorConfig: { tokenEnv: required(form.notionTokenEnv, 'Notion token env') },
      source: {
        pageIds: commaList(form.notionPageIds),
        dataSourceIds: commaList(form.notionDataSourceIds),
      },
    }
  }
  if (form.connectorType === 'feishu') {
    return {
      connectorConfig: {
        accessTokenEnv: required(form.feishuTokenEnv, 'Feishu token env'),
        region: form.feishuRegion,
      },
      source: compactObject({
        spaceId: form.feishuSpaceId.trim(),
        rootNodeToken: form.feishuRootNodeToken.trim(),
        nodeTokens: commaList(form.feishuNodeTokens),
        webBaseUrl: form.feishuWebBaseUrl.trim(),
      }),
    }
  }
  if (form.connectorType === 'retrieval_api') {
    const scoreThreshold = Number(form.retrievalScoreThreshold)
    if (!Number.isFinite(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 1) {
      throw new TypeError(t('pages.connections.scoreThresholdInvalid'))
    }
    return {
      connectorConfig: compactObject({
        url: required(form.retrievalUrl, 'Retrieval API URL'),
        tokenEnv: form.retrievalTokenEnv.trim(),
        scoreThreshold,
      }),
      source: {
        knowledgeIds: requiredList(form.retrievalKnowledgeIds, 'Knowledge IDs'),
      },
    }
  }
  if (form.connectorType === 'custom') {
    const source = JSON.parse(form.customSourceJson) as unknown
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new TypeError(t('pages.connections.customSourceObject'))
    }
    return {
      connectorConfig: {
        module: required(form.customModule, 'Custom connector module'),
        environmentNames: commaList(form.customEnvironmentNames),
      },
      source: source as Record<string, unknown>,
    }
  }
  const connectorConfig = form.mcpTransport === 'stdio'
    ? compactObject({
        transport: 'stdio',
        command: form.mcpCommand.trim(),
        args: commaList(form.mcpArgs),
      })
    : compactObject({
        transport: 'http',
        url: required(form.mcpUrl, 'MCP URL'),
        tokenEnv: form.mcpTokenEnv.trim(),
      })
  return {
    connectorConfig,
    source: compactObject({ resourceUriPrefix: form.mcpResourcePrefix.trim() }),
  }
}

async function checkBinding(binding: ExternalKnowledgeBinding) {
  await bindingAction(binding, 'check')
}

async function syncBinding(binding: ExternalKnowledgeBinding) {
  await bindingAction(binding, 'sync')
}

async function bindingAction(binding: ExternalKnowledgeBinding, action: 'check' | 'sync') {
  if (externalBusy.value) return
  externalBusy.value = true
  externalAction.value = action === 'sync' ? 'pages.connections.syncingBinding' : 'pages.connections.checkingBinding'
  try {
    const result = await postJson<{ skippedCredentials?: number }>(
      `/api/external-knowledge/bindings/${encodeURIComponent(binding.id)}/${action}`,
      {},
    )
    store.notify(t(
      action === 'sync' && result.skippedCredentials
        ? 'pages.connections.externalSyncedWithSkipped'
        : action === 'sync'
          ? 'pages.connections.externalSynced'
          : 'pages.connections.externalChecked',
      { name: binding.name, count: result.skippedCredentials ?? 0 },
    ))
    await refreshExternalKnowledge()
  } catch (error) {
    store.reportError(error)
  } finally {
    externalBusy.value = false
  }
}

async function deleteBinding(binding: ExternalKnowledgeBinding) {
  if (externalBusy.value) return
  externalBusy.value = true
  externalAction.value = 'pages.connections.disconnectingBinding'
  try {
    await deleteJson(`/api/external-knowledge/bindings/${encodeURIComponent(binding.id)}`)
    store.notify(t('pages.connections.externalDeleted', { name: binding.name }))
    await refreshExternalKnowledge()
  } catch (error) {
    store.reportError(error)
  } finally {
    externalBusy.value = false
  }
}

function startEditingTargets(binding: ExternalKnowledgeBinding) {
  const targets = bindingTargets(binding)
  editingBindingId.value = binding.id
  editingProjectIds.value = targets.map(({ personalProjectId }) => personalProjectId)
  editingTargetModes.value = Object.fromEntries(
    targets.map(({ personalProjectId, mode }) => [personalProjectId, mode]),
  )
}

function cancelEditingTargets() {
  editingBindingId.value = null
  editingProjectIds.value = []
  editingTargetModes.value = {}
}

function updateEditingProjects(projectIds: string[]) {
  const binding = bindings.value.find(({ id }) => id === editingBindingId.value)
  if (!binding) return
  const previous = editingTargetModes.value
  const fallbackMode = firstSupportedMode(binding.connectorType)
  editingTargetModes.value = Object.fromEntries(projectIds.map((projectId) => [
    projectId,
    previous[projectId] ?? binding.mode ?? fallbackMode,
  ]))
}

function setEditingTargetMode(projectId: string, mode: string) {
  editingTargetModes.value = {
    ...editingTargetModes.value,
    [projectId]: mode as ExternalKnowledgeMode,
  }
}

async function saveBindingTargets(binding: ExternalKnowledgeBinding) {
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId || !editingProjectIds.value.length || externalBusy.value) return
  externalBusy.value = true
  externalAction.value = 'pages.connections.savingBindingTargets'
  try {
    await patchJson(
      `/api/external-knowledge/bindings/${encodeURIComponent(binding.id)}/targets`,
      {
        expectedTargetsVersion: binding.targetsVersion,
        targets: editingProjectIds.value.map((personalProjectId) => ({
          personalSpaceId,
          personalProjectId,
          mode: editingTargetModes.value[personalProjectId] ?? binding.mode,
        })),
      },
    )
    store.notify(t('pages.connections.projectsUpdated', { name: binding.name }))
    cancelEditingTargets()
    await refreshExternalKnowledge()
  } catch (error) {
    store.reportError(error)
  } finally {
    externalBusy.value = false
  }
}

async function loadConflictPolicy() {
  const version = ++conflictVersion
  conflictController?.abort()
  conflictController = null
  conflictMode.value = 'ask_human'
  conflictError.value = false
  conflictLoading.value = false
  if (!store.activePersonalSpace?.id || !conflictProjectId.value) return
  const controller = new AbortController()
  conflictController = controller
  conflictLoading.value = true
  try {
    const query = new URLSearchParams({ personalProjectId: conflictProjectId.value })
    const policy = await getJson<KnowledgeConflictPolicy>(
      `/api/external-knowledge/conflict-policy?${query}`,
      { signal: controller.signal },
    )
    if (version !== conflictVersion) return
    conflictMode.value = policy.mode
    confirmedConflictMode = policy.mode
  } catch (error) {
    if (version !== conflictVersion) return
    conflictError.value = true
  } finally {
    if (version === conflictVersion) {
      conflictLoading.value = false
      conflictController = null
    }
  }
}

async function updateConflictPolicy() {
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId || !conflictProjectId.value || conflictBusy.value
    || conflictLoading.value || conflictError.value) return
  const version = conflictVersion
  conflictBusy.value = true
  try {
    const query = new URLSearchParams({ personalProjectId: conflictProjectId.value })
    const policy = await patchJson<KnowledgeConflictPolicy>(
      `/api/external-knowledge/conflict-policy?${query}`,
      {
        personalSpaceId,
        personalProjectId: conflictProjectId.value,
        mode: conflictMode.value,
      },
    )
    if (version !== conflictVersion) return
    conflictMode.value = policy.mode
    confirmedConflictMode = policy.mode
    store.notify(t('pages.connections.conflictSaved'))
  } catch (error) {
    if (version !== conflictVersion) return
    conflictMode.value = confirmedConflictMode
    store.reportError(error)
  } finally {
    conflictBusy.value = false
  }
}

function connectorName(type: string) {
  return connectors.value.find((connector) => connector.type === type)?.name ?? type
}

function connectorSupportsMode(type: string, mode: ExternalKnowledgeMode) {
  const capabilities = connectors.value.find((connector) => connector.type === type)?.capabilities
  if (!capabilities?.length) return true
  return (mode === 'live' || mode === 'hybrid' ? capabilities.includes('retrieve') : true)
    && (mode === 'mirror' || mode === 'hybrid' ? capabilities.includes('sync') : true)
}

function firstSupportedMode(type: string): ExternalKnowledgeMode {
  return (['hybrid', 'mirror', 'live'] as ExternalKnowledgeMode[])
    .find((mode) => connectorSupportsMode(type, mode)) ?? 'live'
}

function targetModeOptions(connectorType: string): SearchableSelectOption[] {
  return (['hybrid', 'mirror', 'live'] as ExternalKnowledgeMode[]).map((mode) => ({
    value: mode,
    label: t(`pages.connections.mode.${mode}`),
    disabled: !connectorSupportsMode(connectorType, mode),
  }))
}

function bindingTargets(binding: ExternalKnowledgeBinding): ExternalKnowledgeBindingTarget[] {
  if (binding.targets?.length) return binding.targets
  return [{
    id: binding.id,
    ...binding.target,
    mode: binding.mode,
    status: binding.status,
    sync: binding.sync,
  }]
}

function bindingCanSync(binding: ExternalKnowledgeBinding) {
  return bindingTargets(binding).some(({ mode }) => mode !== 'live')
}

function projectName(projectId: string) {
  return personalProjects.value.find(({ project_id }) => project_id === projectId)?.profile.name
    ?? projectId
}

function bindingError(binding: ExternalKnowledgeBinding) {
  return bindingTargets(binding).find(({ sync }) => sync?.error)?.sync?.error ?? binding.sync?.error
}

function bindingSkippedCredentials(binding: ExternalKnowledgeBinding) {
  return bindingTargets(binding).reduce(
    (count, target) => count + (target.sync?.skippedCredentials ?? 0),
    0,
  )
}

function commaList(value: string) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}

function requiredList(value: string, label: string) {
  const items = commaList(value)
  if (!items.length) throw new TypeError(`${label} is required`)
  return items
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) =>
    item !== '' && (!Array.isArray(item) || item.length > 0)
  ))
}

function required(value: string, label: string) {
  if (!value.trim()) throw new TypeError(`${label} is required`)
  return value.trim()
}

function readmeHelpUrl(fragment: string) {
  const file = currentLocale() === 'zh-CN' ? 'README.zh-CN.md' : 'README.md'
  return `https://github.com/JevonsCode/fuli/blob/main/${file}#${fragment}`
}
</script>

<template>
  <section class="view connections-view">
    <div class="connection-intro">
      <h3>{{ t('pages.connections.title') }}</h3>
    </div>

    <div class="service-connection-grid" :aria-label="t('pages.connections.statusAria')">
      <article class="service-connection-card" :data-status="personalReady ? 'ready' : 'error'">
        <header>
          <span class="service-connection-icon local" aria-hidden="true"><span class="nav-icon nav-icon-personal-project" /></span>
          <div><h3>{{ t('pages.connections.localGraphiti') }}</h3></div>
          <span class="service-state">{{ personalReady ? t('common.status.connected') : t('common.status.connectionError') }}</span>
        </header>
        <dl><div><dt>{{ t('pages.connections.storage') }}</dt><dd>Neo4j</dd></div><div><dt>{{ t('pages.connections.purpose') }}</dt><dd>{{ t('pages.connections.localPurpose') }}</dd></div></dl>
      </article>

      <article class="service-connection-card" :data-status="store.publicRuntimeStatus">
        <header>
          <span class="service-connection-icon public" aria-hidden="true"><span class="nav-icon nav-icon-public-project" /></span>
          <div class="connection-title-row"><h3>{{ t('pages.connections.publicService') }}</h3><span class="feature-badge beta">BETA</span></div>
          <span class="service-state">{{ store.publicRuntimeStatus === 'ready' ? t('common.status.connected') : store.publicRuntimeStatus === 'error' ? t('common.status.connectionError') : t('common.status.notConnected') }}</span>
        </header>
        <dl>
          <div><dt>{{ t('pages.connections.currentStatus') }}</dt><dd>{{ store.publicRuntimeStatus === 'ready' ? t('pages.connections.sharedServicesReady', { count: readyWorkspaces || workspaces.length }) : t('pages.connections.notAvailable') }}</dd></div>
          <div><dt>{{ t('pages.connections.purpose') }}</dt><dd>{{ publicPurpose }}</dd></div>
        </dl>
      </article>
    </div>

    <section class="external-knowledge-section">
      <div class="section-title section-title-with-help">
        <h3>{{ t('pages.connections.externalTitle') }}</h3>
        <a
          class="section-help-link"
          data-testid="external-knowledge-help"
          :href="externalKnowledgeHelpUrl"
          :aria-label="t('pages.connections.externalHelp')"
          :title="t('pages.connections.externalHelp')"
          target="_blank"
          rel="noreferrer"
        >?</a>
        <span class="external-binding-count">{{ t('pages.connections.bindingCount', { count: bindings.length }) }}</span>
      </div>
      <GrowthLoading v-if="externalLoading || externalBusy" variant="compact" :label="t(externalLoading ? 'pages.connections.loadingBindings' : externalAction)" />
      <div class="external-binding-list">
        <article v-for="binding in bindings" :key="binding.id" class="external-binding-row" :data-status="binding.status">
          <i aria-hidden="true" />
          <div class="external-binding-copy">
            <strong>{{ binding.name }}</strong>
            <span>{{ connectorName(binding.connectorType) }}</span>
            <div class="external-binding-targets">
              <b>{{ t('pages.connections.boundTo') }}</b>
              <span
                v-for="target in bindingTargets(binding)"
                :key="target.id"
                class="external-binding-target-chip"
                :data-status="target.status"
              >{{ projectName(target.personalProjectId) }} · {{ t(`pages.connections.mode.${target.mode}`) }}</span>
            </div>
            <small v-if="bindingError(binding)">{{ bindingError(binding) }}</small>
            <small v-else-if="bindingSkippedCredentials(binding)">{{ t('pages.connections.credentialsSkipped', { count: bindingSkippedCredentials(binding) }) }}</small>
          </div>
          <div class="external-binding-actions">
            <button class="quiet-button" type="button" :disabled="externalBusy" @click="checkBinding(binding)">{{ t('pages.connections.check') }}</button>
            <button class="quiet-button external-sync-action" type="button" :disabled="externalBusy || !bindingCanSync(binding)" @click="syncBinding(binding)">{{ t('pages.connections.sync') }}</button>
            <button class="quiet-button" type="button" :disabled="externalBusy" @click="startEditingTargets(binding)">{{ t('pages.connections.manageProjects') }}</button>
            <button class="quiet-button danger" type="button" :disabled="externalBusy" @click="deleteBinding(binding)">{{ t('pages.connections.disconnect') }}</button>
          </div>
          <div v-if="editingBindingId === binding.id" class="external-binding-editor">
            <label>
              <span>{{ t('pages.connections.targetProjects') }}</span>
              <SearchableMultiSelect
                v-model="editingProjectIds"
                :control-id="`external-projects-${binding.id}`"
                :label="t('pages.connections.targetProjects')"
                :options="personalProjectOptions"
                :disabled="externalBusy"
                required
                searchable
                @change="updateEditingProjects"
              />
            </label>
            <div class="external-target-mode-list">
              <div
                v-for="projectId in editingProjectIds"
                :key="projectId"
                class="external-target-mode-row"
              >
                <span>{{ projectName(projectId) }}</span>
                <SearchableSelect
                  :model-value="editingTargetModes[projectId] ?? binding.mode"
                  :control-id="`external-target-mode-${binding.id}-${projectId}`"
                  :label="t('pages.connections.bindingMode')"
                  :options="targetModeOptions(binding.connectorType)"
                  :disabled="externalBusy"
                  @update:model-value="setEditingTargetMode(projectId, $event)"
                />
              </div>
            </div>
            <div class="external-binding-editor-actions">
              <button class="quiet-button" type="button" :disabled="externalBusy" @click="cancelEditingTargets">{{ t('common.actions.cancel') }}</button>
              <button class="primary-action" type="button" :disabled="externalBusy || !editingProjectIds.length" @click="saveBindingTargets(binding)">{{ t('pages.connections.saveProjects') }}</button>
            </div>
          </div>
        </article>
        <div v-if="!externalLoading && !bindings.length" class="compact-empty">{{ t('pages.connections.noExternalBindings') }}</div>
      </div>

      <form class="external-binding-form" @submit.prevent="createBinding">
        <TextField v-model="form.name" :label="t('pages.connections.bindingName')" data-testid="external-name" required />
        <label>
          <span>{{ t('pages.connections.connector') }}</span>
          <SearchableSelect
            v-model="form.connectorType"
            control-id="external-connector"
            :label="t('pages.connections.connector')"
            :options="connectorOptions"
            :disabled="externalBusy"
            required
          />
        </label>
        <label>
          <span>{{ t('pages.connections.targetProjects') }}</span>
          <SearchableMultiSelect
            v-model="form.personalProjectIds"
            control-id="external-projects"
            :label="t('pages.connections.targetProjects')"
            :options="personalProjectOptions"
            :disabled="externalBusy"
            required
            searchable
          />
        </label>
        <label>
          <span>{{ t('pages.connections.bindingMode') }}</span>
          <SearchableSelect
            v-model="form.mode"
            control-id="external-binding-mode"
            :label="t('pages.connections.bindingMode')"
            :options="bindingModeOptions"
            :disabled="externalBusy"
            required
          />
        </label>

        <template v-if="form.connectorType === 'mcp'">
          <label>
            <span>{{ t('pages.connections.transport') }}</span>
            <SearchableSelect
              v-model="form.mcpTransport"
              control-id="external-mcp-transport"
              :label="t('pages.connections.transport')"
              :options="mcpTransportOptions"
              :disabled="externalBusy"
              required
            />
          </label>
          <TextField v-if="form.mcpTransport === 'http'" v-model="form.mcpUrl" label="MCP URL" data-testid="mcp-url" type="url" required />
          <TextField v-else v-model="form.mcpCommand" :label="t('pages.connections.command')" required />
          <TextField v-if="form.mcpTransport === 'stdio'" v-model="form.mcpArgs" :label="t('pages.connections.arguments')" />
          <TextField v-else v-model="form.mcpTokenEnv" :label="t('pages.connections.tokenEnv')" data-testid="mcp-token-env" />
          <TextField v-model="form.mcpResourcePrefix" :label="t('pages.connections.resourcePrefix')" data-testid="mcp-resource-prefix" />
        </template>

        <template v-else-if="form.connectorType === 'notion'">
          <TextField v-model="form.notionTokenEnv" :label="t('pages.connections.tokenEnv')" required />
          <TextField v-model="form.notionPageIds" label="Page IDs" />
          <TextField v-model="form.notionDataSourceIds" label="Data Source IDs" />
        </template>

        <template v-else-if="form.connectorType === 'feishu'">
          <TextField v-model="form.feishuTokenEnv" :label="t('pages.connections.tokenEnv')" required />
          <label>
            <span>{{ t('pages.connections.region') }}</span>
            <SearchableSelect
              v-model="form.feishuRegion"
              control-id="external-feishu-region"
              :label="t('pages.connections.region')"
              :options="feishuRegionOptions"
              :disabled="externalBusy"
              required
            />
          </label>
          <TextField v-model="form.feishuSpaceId" label="Space ID" />
          <TextField v-model="form.feishuRootNodeToken" label="Root Node Token" />
          <TextField v-model="form.feishuNodeTokens" label="Node Tokens" />
          <TextField v-model="form.feishuWebBaseUrl" label="Web URL" type="url" />
        </template>

        <template v-else-if="form.connectorType === 'retrieval_api'">
          <TextField v-model="form.retrievalUrl" :label="t('pages.connections.retrievalUrl')" type="url" required />
          <TextField v-model="form.retrievalTokenEnv" :label="t('pages.connections.tokenEnv')" />
          <TextField v-model="form.retrievalKnowledgeIds" :label="t('pages.connections.knowledgeIds')" required />
          <TextField v-model="form.retrievalScoreThreshold" :label="t('pages.connections.scoreThreshold')" inputmode="decimal" required />
        </template>

        <template v-else>
          <TextField v-model="form.customModule" :label="t('pages.connections.module')" required />
          <TextField v-model="form.customEnvironmentNames" :label="t('pages.connections.environmentNames')" />
          <div class="wide-field">
            <TextField v-model="form.customSourceJson" :label="t('pages.connections.sourceJson')" multiline required />
          </div>
          <span class="trusted-code-badge">{{ t('pages.connections.trustedCode') }}</span>
        </template>
        <button
          class="primary-action external-create-action"
          type="submit"
          :disabled="externalBusy || !personalProjects.length || !form.personalProjectIds.length"
        >
          <span class="external-create-action-icon" aria-hidden="true" />
          <span>{{ t('pages.connections.connect') }}</span>
        </button>
      </form>
    </section>

    <section v-if="personalProjects.length" class="conflict-policy-section">
      <div class="section-title section-title-with-help">
        <h3>{{ t('pages.connections.conflictTitle') }}</h3>
        <a
          class="section-help-link"
          data-testid="conflict-policy-help"
          :href="conflictPolicyHelpUrl"
          :aria-label="t('pages.connections.conflictHelp')"
          :title="t('pages.connections.conflictHelp')"
          target="_blank"
          rel="noreferrer"
        >?</a>
      </div>
      <div class="conflict-policy-controls">
        <label>
          <span>{{ t('pages.connections.targetProject') }}</span>
          <SearchableSelect
            v-model="conflictProjectId"
            control-id="external-conflict-project"
            :label="t('pages.connections.targetProject')"
            :options="personalProjectOptions"
            :disabled="conflictBusy"
            required
          />
        </label>
        <label>
          <span>{{ t('pages.connections.conflictAction') }}</span>
          <SearchableSelect
            v-model="conflictMode"
            control-id="external-conflict-mode"
            :label="t('pages.connections.conflictAction')"
            :options="conflictModeOptions"
            :disabled="conflictBusy || conflictLoading || conflictError || !conflictProjectId"
            required
            @change="updateConflictPolicy"
          />
        </label>
      </div>
      <GrowthLoading v-if="conflictLoading" variant="compact" :label="t('pages.connections.loadingConflictPolicy')" />
      <GrowthLoading v-if="conflictBusy" variant="inline" :label="t('pages.connections.savingConflictPolicy')" />
      <div v-else-if="conflictError" role="alert">
        <p>{{ t('common.errors.loadFailed') }}</p>
        <button class="secondary-action" type="button" @click="loadConflictPolicy">{{ t('common.actions.retry') }}</button>
      </div>
    </section>

    <section v-if="store.state?.capabilities?.subscribeProject" class="connection-subscriptions">
      <div class="section-title"><h3>{{ t('pages.connections.subscriptionsTitle') }} <span class="feature-badge beta">BETA</span></h3></div>
      <GrowthLoading v-if="subscriptionBusy" variant="inline" :label="t(subscriptionAction)" />
      <div class="subscription-list">
        <div v-for="subscription in subscriptions" :key="`${subscription.provider_url}:${subscription.project_id}`" class="subscription-row">
          <span>↗</span>
          <div><strong>{{ subscription.project_name ?? subscription.project_id }}</strong><span>{{ t('pages.connections.sharedProject') }}</span></div>
          <button class="secondary-action subscription-action" type="button" :disabled="subscriptionBusy" @click="unsubscribe(subscription)">{{ t('pages.connections.unsubscribe') }}</button>
        </div>
        <div v-if="!subscriptions.length" class="empty-state">{{ t('pages.connections.noSubscriptions') }}</div>
      </div>
      <form class="subscription-form" @submit.prevent="subscribe">
        <SearchableSelect
          v-model="selectedProjectKey"
          :options="availableProjectOptions"
          :label="t('pages.connections.sharedProjectLabel')"
          :placeholder="t('pages.connections.choosePublicProject')"
          searchable
          required
          :disabled="subscriptionBusy"
        />
        <button type="submit" :disabled="subscriptionBusy || !selectedProjectKey || !store.activePersonalSpace">{{ t('pages.connections.subscribe') }}</button>
      </form>
    </section>
  </section>
</template>
