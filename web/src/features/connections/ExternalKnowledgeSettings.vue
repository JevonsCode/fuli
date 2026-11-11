<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { deleteJson, getJson, patchJson, postJson } from '@/api/client'
import type { SelectOption } from '@/components/ui/select'
import TextField from '@/components/TextField.vue'
import { t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import { docsHelpUrl } from './docs-help'
import type {
  ExternalKnowledgeBinding,
  ExternalKnowledgeBindingTarget,
  ExternalKnowledgeConnector,
  ExternalKnowledgeMode,
} from '@/types'
import { OptionSelect } from '@/components/ui/select'
import { OptionCombobox } from '@/components/ui/combobox'
import { usePageRefresh } from '@/layouts/page-refresh'

// Settings › 连接's external knowledge: the bindings, each one's projects and
// modes, and connecting a new source.
const store = useConsoleStore()
const connectors = ref<ExternalKnowledgeConnector[]>([])
const bindings = ref<ExternalKnowledgeBinding[]>([])
const externalBusy = ref(false)
const externalLoading = ref(false)
// 添加连接 asked for while connections exist; with none yet the form shows anyway.
const connectOpen = ref(false)
const externalAction = ref('')
const editingBindingId = ref<string | null>(null)
const editingProjectIds = ref<string[]>([])
const editingTargetModes = ref<Record<string, ExternalKnowledgeMode>>({})
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

const personalProjects = computed(() => store.state?.personalProjects ?? [])
const externalKnowledgeHelpUrl = computed(() => docsHelpUrl('external-knowledge', 'connect-external-knowledge'))
const connectorOptions = computed<SelectOption[]>(() =>
  connectors.value.map((connector) => ({
    value: connector.type,
    label: connector.name,
    meta: connector.description,
  })),
)
const personalProjectOptions = computed<SelectOption[]>(() =>
  personalProjects.value.map((project) => ({
    value: project.project_id,
    label: project.profile.name,
    meta: `#${compactIdentity(project.project_id, 26)}`,
    search: identitySearchText(project.project_id),
  })),
)
const bindingModeOptions = computed<SelectOption[]>(() => [
  { value: 'hybrid', label: t('pages.connections.mode.hybrid'), disabled: !connectorSupportsMode(form.connectorType, 'hybrid') },
  { value: 'mirror', label: t('pages.connections.mode.mirror'), disabled: !connectorSupportsMode(form.connectorType, 'mirror') },
  { value: 'live', label: t('pages.connections.mode.live'), disabled: !connectorSupportsMode(form.connectorType, 'live') },
])
const mcpTransportOptions = computed<SelectOption[]>(() => [
  { value: 'http', label: 'Streamable HTTP' },
  { value: 'stdio', label: 'stdio' },
])
const feishuRegionOptions = computed<SelectOption[]>(() => [
  { value: 'cn', label: 'Feishu' },
  { value: 'global', label: 'Lark' },
])

watch(personalProjects, (projects) => {
  const ids = new Set(projects.map(({ project_id }) => project_id))
  const first = projects[0]?.project_id ?? ''
  form.personalProjectIds = form.personalProjectIds.filter((id) => ids.has(id))
  if (!form.personalProjectIds.length && first) form.personalProjectIds = [first]
  editingProjectIds.value = editingProjectIds.value.filter((id) => ids.has(id))
}, { immediate: true })

watch(() => form.connectorType, (type) => {
  if (connectorSupportsMode(type, form.mode)) return
  form.mode = firstSupportedMode(type)
})

onMounted(() => void refreshExternalKnowledge())

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
    connectOpen.value = false
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

function targetModeOptions(connectorType: string): SelectOption[] {
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
// The top bar's 刷新 reads the external knowledge connections again.
usePageRefresh(refreshExternalKnowledge)
</script>

<template>
  <Card as="section" id="external-knowledge" class="settings-card external-knowledge-section" aria-labelledby="external-knowledge-title">
    <div class="flex flex-wrap items-center gap-2 px-5">
      <CardTitle id="external-knowledge-title" as="h2" class="text-base">{{ t('pages.connections.externalTitle') }}<AiHelpButton term="task.connections" /></CardTitle>
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
      <!-- Settings cards stay open, never a disclosure: the form shows under the list when asked for, or when there is none yet. -->
      <Button v-if="bindings.length && !connectOpen" size="sm" variant="outline" class="ml-auto" data-external-connect-open
        @click="connectOpen = true">{{ t('pages.connections.connect') }}</Button>
    </div>
    <div class="grid gap-3 px-5">
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
          <Button size="sm" variant="ghost" :disabled="externalBusy" @click="checkBinding(binding)">{{ t('pages.connections.check') }}</Button>
          <Button size="sm" variant="ghost" class="external-sync-action" :disabled="externalBusy || !bindingCanSync(binding)" @click="syncBinding(binding)">{{ t('pages.connections.sync') }}</Button>
          <Button size="sm" variant="ghost" :disabled="externalBusy" @click="startEditingTargets(binding)">{{ t('pages.connections.manageProjects') }}</Button>
          <Button size="sm" variant="destructive" :disabled="externalBusy" @click="deleteBinding(binding)">{{ t('pages.connections.disconnect') }}</Button>
        </div>
        <div v-if="editingBindingId === binding.id" class="external-binding-editor">
          <label>
            <span>{{ t('pages.connections.targetProjects') }}</span>
            <OptionCombobox multiple
              v-model="editingProjectIds"
              :control-id="`external-projects-${binding.id}`"
              :label="t('pages.connections.targetProjects')"
              :options="personalProjectOptions"
              :disabled="externalBusy"
              required
              @update:model-value="updateEditingProjects"
 />
          </label>
          <div class="external-target-mode-list">
            <div
              v-for="projectId in editingProjectIds"
              :key="projectId"
              class="external-target-mode-row"
            >
              <span>{{ projectName(projectId) }}</span>
              <OptionSelect
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
            <Button variant="ghost" :disabled="externalBusy" @click="cancelEditingTargets">{{ t('common.actions.cancel') }}</Button>
            <Button :disabled="externalBusy || !editingProjectIds.length" @click="saveBindingTargets(binding)">{{ t('pages.connections.saveProjects') }}</Button>
          </div>
        </div>
      </article>
      <div v-if="!externalLoading && !bindings.length" class="py-4 text-xs text-muted-foreground">{{ t('pages.connections.noExternalBindings') }}</div>
    </div>

    <form v-show="connectOpen || !bindings.length" class="external-binding-form" data-external-connect-form @submit.prevent="createBinding">
      <TextField v-model="form.name" :label="t('pages.connections.bindingName')" data-testid="external-name" required />
      <label>
        <span>{{ t('pages.connections.connector') }}</span>
        <OptionSelect
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
        <OptionCombobox multiple
          v-model="form.personalProjectIds"
          control-id="external-projects"
          :label="t('pages.connections.targetProjects')"
          :options="personalProjectOptions"
          :disabled="externalBusy"
          required
 />
      </label>
      <label>
        <span>{{ t('pages.connections.bindingMode') }}</span>
        <OptionSelect
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
          <OptionSelect
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
          <OptionSelect
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
      <Button
        class="external-create-action"
        type="submit"
        :disabled="externalBusy || !personalProjects.length || !form.personalProjectIds.length"
      >
        <span class="external-create-action-icon" aria-hidden="true" />
        <span>{{ t('pages.connections.connect') }}</span>
      </Button>
    </form>
    </div>
  </Card>
</template>
