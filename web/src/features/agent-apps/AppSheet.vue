<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { apiErrorCode, apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDate } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { UiDialog } from '@/ui'
import {
  confirmApp, confirmationStep, deleteAppCode, deleteAppData, disableApp, exportAppData, offerDataDeletion, readApp, restartApp,
  revealAppExport, startApp, stopApp, type AgentAppDetail, type AgentAppRow, type AgentAppVersion, type DataDeletionOffer,
} from './agent-apps'
import { appStatus, appTypeLabel, formatBytes, historyLabel, versionStateLabel } from './app-labels'

// One app's details and the person's actions on it: confirm a version so it
// runs (FULI's confirmation opens in its own window, where the person types
// the app's name), open a page app, start, stop or restart the others,
// disable, and remove it in two steps: the code first (the data stays), then
// the data, after an export offer, confirmed by typing the app id.
const props = defineProps<{ app: AgentAppRow; ownerName: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const name = computed(() => props.app.title ?? props.app.name)
const status = computed(() => appStatus(props.app))
const confirmation = computed(() => confirmationStep(props.app))
const ready = computed(() => props.app.status === 'active' && props.app.run.status === 'ready')
const running = computed(() => ['running', 'sealing'].includes(props.app.instance?.state ?? ''))
const isPage = computed(() => props.app.type === 'page')
const canDisable = computed(() => props.app.status === 'active')
const canDeleteCode = computed(() => ['active', 'disabled', 'pending'].includes(props.app.status))
const codeDeleted = computed(() => props.app.status === 'code_deleted')

const detail = ref<AgentAppDetail | null>(null)
const loadState = ref<'loading' | 'ready' | 'failed'>('loading')
type Step = 'deleteCode' | 'deleteData'
const step = ref<Step | null>(null)
const busy = ref<string | null>(null)
const error = ref('')
const confirmOpened = ref(false)
const exported = ref<{ path: string } | null>(null)
const offer = ref<DataDeletionOffer | null>(null)
const typed = ref('')

// An app that never ran has no data to export yet.
const everRan = computed(() => Boolean(detail.value?.history.some(event => event.action === 'instance_started')))
const canExport = computed(() => props.app.dataBytes > 0 || everRan.value)

async function load() {
  loadState.value = 'loading'
  try {
    detail.value = await readApp(props.app.appId)
    loadState.value = 'ready'
  } catch {
    loadState.value = 'failed'
  }
}
function reset() { step.value = null; offer.value = null; typed.value = ''; exported.value = null; confirmOpened.value = false; error.value = '' }
watch(() => props.app.appId, () => { reset(); void load() }, { immediate: true })

// After the confirmation window opens, coming back to the console reads the app again.
function onFocus() { if (confirmOpened.value) emit('changed') }
onMounted(() => window.addEventListener('focus', onFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onFocus))

const REFUSALS = new Set(['confirmation_required', 'reconfirmation_required', 'challenge_mismatch', 'runner_check_failed'])
function failure(cause: unknown) {
  const code = apiErrorCode(cause)
  return code && REFUSALS.has(code) ? t(`agentApps.refusals.${code}`) : t('agentApps.actions.failed', { reason: apiErrorReason(cause) })
}

async function act(label: string, run: () => Promise<unknown>, after?: () => void) {
  busy.value = label
  error.value = ''
  try {
    await run()
    after?.()
    emit('changed')
    await load()
  } catch (cause) {
    error.value = failure(cause)
  } finally {
    busy.value = null
  }
}
const confirm = () => confirmation.value && act(t('agentApps.actions.confirming', { name: name.value }),
  () => confirmApp(props.app.appId, confirmation.value!.action, confirmation.value!.version), () => { confirmOpened.value = true })
const start = () => act(t('agentApps.actions.starting', { name: name.value }), () => startApp(props.app.appId))
const stop = () => act(t('agentApps.actions.stopping', { name: name.value }), () => stopApp(props.app.appId))
const restart = () => act(t('agentApps.actions.restarting', { name: name.value }), () => restartApp(props.app.appId))
const disable = () => act(t('agentApps.actions.disabling', { name: name.value }), () => disableApp(props.app.appId))
const removeCode = () => act(t('agentApps.actions.deletingCode', { name: name.value }), () => deleteAppCode(props.app.appId), reset)
async function exportData() {
  busy.value = t('agentApps.actions.exporting', { name: name.value })
  error.value = ''
  try {
    exported.value = await exportAppData(props.app.appId)
  } catch (cause) {
    error.value = failure(cause)
  } finally {
    busy.value = null
  }
}
async function reveal() {
  if (!exported.value) return
  try { await revealAppExport(props.app.appId, exported.value.path) } catch (cause) { error.value = failure(cause) }
}
async function prepareData() {
  busy.value = t('agentApps.actions.preparingData', { name: name.value })
  error.value = ''
  try {
    offer.value = await offerDataDeletion(props.app.appId)
    step.value = 'deleteData'
  } catch (cause) {
    error.value = failure(cause)
  } finally {
    busy.value = null
  }
}
const removeData = () => offer.value && act(t('agentApps.actions.deletingData', { name: name.value }),
  () => deleteAppData(props.app.appId, offer.value!.ticket), reset)

function approvalText(version: AgentAppVersion) {
  const approval = version.approval
  if (!approval) return t('agentApps.sheet.notApproved')
  return approval.verification === 'terminal_confirmation' ? t('agentApps.sheet.confirmed') : t('agentApps.sheet.notConfirmed')
}
</script>

<template>
  <UiDialog open size="lg" class="app-sheet" :title="name" :busy="Boolean(busy)" :error="error" @close="emit('close')">
    <div class="sheet" :data-app-sheet="app.appId">
      <p class="sheet-summary">
        <span>{{ appTypeLabel(app.type) }}</span><span aria-hidden="true">·</span><span>{{ t('agentApps.by', { name: ownerName }) }}</span>
        <span aria-hidden="true">·</span><span class="sheet-status" :data-tone="status.tone">{{ status.text }}</span>
      </p>

      <section v-if="confirmation" class="sheet-callout" data-app-confirmation>
        <h3>{{ t(confirmation.action === 'approve' ? 'agentApps.confirm.approveTitle' : 'agentApps.confirm.againTitle', { version: confirmation.version }) }}</h3>
        <p>{{ t('agentApps.confirm.trust') }}</p>
        <p v-if="confirmOpened" class="sheet-callout-next" role="status" data-app-confirm-opened>{{ t('agentApps.confirm.opened', { name: app.name }) }}</p>
        <div class="sheet-callout-actions">
          <Button size="sm" :disabled="Boolean(busy)" data-app-confirm @click="confirm">
            {{ t(confirmOpened ? 'agentApps.confirm.openAgain' : 'agentApps.confirm.open') }}
          </Button>
          <Button v-if="confirmOpened" size="sm" variant="ghost" :disabled="Boolean(busy)" @click="emit('changed')">{{ t('agentApps.confirm.done') }}</Button>
        </div>
      </section>

      <dl class="sheet-facts">
        <div><dt>{{ t('agentApps.sheet.version') }}</dt><dd class="ui-num">{{ app.version ? `v${app.version}` : '—' }}</dd></div>
        <div><dt>{{ t('agentApps.sheet.data') }}</dt><dd class="ui-num">{{ formatBytes(app.dataBytes) }}</dd></div>
        <div><dt>{{ t('agentApps.sheet.lastUsed') }}</dt><dd>{{ app.lastUsedAt ? formatDate(app.lastUsedAt) : t('agentApps.sheet.neverUsed') }}</dd></div>
      </dl>

      <GrowthLoading v-if="loadState === 'loading' && !detail" variant="compact" :label="t('agentApps.sheet.loading', { name })" />
      <p v-else-if="loadState === 'failed' && !detail" class="sheet-note" role="alert">{{ t('agentApps.sheet.loadFailed', { name }) }}</p>
      <template v-if="detail">
        <section class="sheet-section" aria-labelledby="app-sheet-versions">
          <h3 id="app-sheet-versions">{{ t('agentApps.sheet.versions') }}</h3>
          <ol class="sheet-rows">
            <li v-for="version in [...detail.versions].reverse()" :key="version.version" :data-app-version="version.version">
              <span class="ui-num sheet-version">v{{ version.version }}</span>
              <span class="sheet-row-main">
                <span>{{ versionStateLabel(version.state) }}<template v-if="version.state === 'approved'"> · {{ approvalText(version) }}</template></span>
                <span v-if="version.description" class="sheet-row-meta">{{ version.description }}</span>
              </span>
              <span v-if="version.submittedAt" class="sheet-row-time">{{ formatDate(version.submittedAt) }}</span>
            </li>
          </ol>
        </section>
        <section v-if="detail.history.length" class="sheet-section" aria-labelledby="app-sheet-history">
          <h3 id="app-sheet-history">{{ t('agentApps.sheet.history') }}</h3>
          <ol class="sheet-rows is-compact">
            <li v-for="(event, index) in detail.history" :key="index">
              <span class="sheet-row-main">{{ historyLabel(event.action) }}</span>
              <span class="sheet-row-time">{{ formatDate(event.at) }}</span>
            </li>
          </ol>
        </section>
      </template>

      <section v-if="exported" class="sheet-callout" role="status" data-app-exported>
        <h3>{{ t('agentApps.export.done') }}</h3>
        <p class="sheet-path">{{ exported.path }}</p>
        <div class="sheet-callout-actions"><Button size="sm" variant="outline" data-app-reveal @click="reveal">{{ t('agentApps.export.reveal') }}</Button></div>
      </section>
      <section v-if="step === 'deleteCode'" class="sheet-callout" data-app-confirm-step="code">
        <h3>{{ t('agentApps.removeCode.confirm', { name }) }}</h3>
        <p>{{ t('agentApps.removeCode.body') }}</p>
      </section>
      <section v-if="step === 'deleteData' && offer" class="sheet-callout is-danger" data-app-confirm-step="data">
        <h3>{{ t('agentApps.removeData.confirm', { name }) }}</h3>
        <p>{{ t('agentApps.removeData.body', { files: offer.dataFiles, size: formatBytes(offer.dataBytes) }) }}</p>
        <label class="sheet-type">
          <span>{{ t('agentApps.removeData.typeId', { id: app.appId }) }}</span>
          <Input v-model="typed" autocomplete="off" spellcheck="false" data-app-type-id />
        </label>
        <p class="sheet-note">{{ t('agentApps.removeData.expires', { time: formatDate(offer.expiresAt) }) }}</p>
      </section>
      <GrowthLoading v-if="busy" variant="inline" :label="busy" />
    </div>

    <template #footer>
      <template v-if="step === 'deleteCode'">
        <Button variant="ghost" :disabled="Boolean(busy)" @click="step = null">{{ t('agentApps.actions.cancel') }}</Button>
        <Button variant="destructive" :disabled="Boolean(busy)" data-app-delete-code-confirm @click="removeCode">{{ t('agentApps.actions.deleteCode') }}</Button>
      </template>
      <template v-else-if="step === 'deleteData'">
        <Button variant="ghost" :disabled="Boolean(busy)" @click="reset">{{ t('agentApps.actions.cancel') }}</Button>
        <Button variant="destructive" :disabled="Boolean(busy) || typed.trim() !== app.appId" data-app-delete-data-confirm @click="removeData">
          {{ t('agentApps.actions.deleteData') }}
        </Button>
      </template>
      <template v-else-if="codeDeleted">
        <Button variant="outline" :disabled="Boolean(busy) || !canExport" data-app-export @click="exportData">{{ t('agentApps.actions.export') }}</Button>
        <Button variant="ghost" class="sheet-danger" :disabled="Boolean(busy)" data-app-delete-data @click="prepareData">{{ t('agentApps.actions.deleteData') }}</Button>
      </template>
      <template v-else>
        <Button v-if="ready && isPage" as-child>
          <RouterLink :to="`/project-agents/apps/${encodeURIComponent(app.appId)}`" data-app-open>{{ t('agentApps.actions.open') }}</RouterLink>
        </Button>
        <template v-else-if="ready">
          <Button v-if="!running" :disabled="Boolean(busy)" data-app-start @click="start">{{ t('agentApps.actions.start') }}</Button>
          <template v-else>
            <Button variant="outline" :disabled="Boolean(busy)" data-app-restart @click="restart">{{ t('agentApps.actions.restart') }}</Button>
            <Button variant="outline" :disabled="Boolean(busy)" data-app-stop @click="stop">{{ t('agentApps.actions.stop') }}</Button>
          </template>
        </template>
        <Button v-if="canDisable" variant="ghost" :disabled="Boolean(busy)" data-app-disable @click="disable">{{ t('agentApps.actions.disable') }}</Button>
        <Button v-if="canDeleteCode" variant="ghost" class="sheet-danger" :disabled="Boolean(busy)" data-app-delete-code @click="step = 'deleteCode'">{{ t('agentApps.actions.deleteCode') }}</Button>
      </template>
    </template>
  </UiDialog>
</template>

<style scoped>
.sheet { display: grid; gap: 20px; }
.sheet-summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; color: var(--color-muted); font-size: var(--text-control); }
.sheet-status[data-tone="attention"] { color: var(--color-ink); font-weight: var(--weight-medium); }
.sheet-status[data-tone="running"] { color: var(--color-success); }
.sheet-status[data-tone="danger"] { color: var(--color-danger); }
.sheet-callout { display: grid; gap: 8px; padding: 14px 16px; border-radius: var(--radius-card); background: var(--color-surface-subtle); }
.sheet-callout.is-danger { background: var(--color-danger-soft); }
.sheet-callout h3 { margin: 0; font-size: var(--text-body); font-weight: var(--weight-strong); }
.sheet-callout p { margin: 0; color: var(--color-ink-soft); font-size: var(--text-control); line-height: var(--leading-prose); }
.sheet-callout .sheet-callout-next { color: var(--color-ink); }
.sheet-callout-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.sheet-path { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-meta); overflow-wrap: anywhere; }
.sheet-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 0; }
.sheet-facts div { display: grid; gap: 2px; }
.sheet-facts dt { color: var(--color-muted); font-size: var(--text-meta); }
.sheet-facts dd { margin: 0; font-size: var(--text-body); }
.sheet-section { display: grid; gap: 8px; }
.sheet-section h3 { margin: 0; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.sheet-rows { margin: 0; padding: 0; list-style: none; }
.sheet-rows li { display: flex; align-items: baseline; gap: 12px; padding: 10px 0; }
.sheet-rows li + li { border-top: 1px solid var(--color-border); }
.sheet-rows.is-compact li { padding: 6px 0; font-size: var(--text-control); }
.sheet-version { min-width: 52px; color: var(--color-ink-soft); }
.sheet-row-main { display: grid; flex: 1; gap: 2px; min-width: 0; }
.sheet-row-meta { color: var(--color-muted); font-size: var(--text-meta); }
.sheet-row-time { flex: none; color: var(--color-faint); font-size: var(--text-meta); }
.sheet-type { display: grid; gap: 6px; font-size: var(--text-control); }
.sheet-note { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.sheet-danger { color: var(--color-danger); }
</style>
