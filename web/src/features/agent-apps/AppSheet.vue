<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { UiDialog } from '@/ui'
import { deleteAppCode, disableApp, readApp, type AgentAppDetail, type AgentAppRow, type AgentAppVersion } from './agent-apps'
import { appStatus, appTypeLabel, formatBytes, historyLabel, versionStateLabel } from './app-labels'

// One app's details: what it is, its versions and recent activity, and the
// person's actions. Deleting starts with the code; the data stays.
const props = defineProps<{ app: AgentAppRow; ownerName: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const name = computed(() => props.app.title ?? props.app.name)
const status = computed(() => appStatus(props.app))
const canDisable = computed(() => props.app.status === 'active')
const canDeleteCode = computed(() => ['active', 'disabled', 'pending'].includes(props.app.status))

const detail = ref<AgentAppDetail | null>(null)
const loadState = ref<'loading' | 'ready' | 'failed'>('loading')
const confirmingDelete = ref(false)
const busy = ref<string | null>(null)
const error = ref('')

async function load() {
  loadState.value = 'loading'
  try {
    detail.value = await readApp(props.app.appId)
    loadState.value = 'ready'
  } catch {
    loadState.value = 'failed'
  }
}
watch(() => props.app.appId, () => { confirmingDelete.value = false; void load() }, { immediate: true })

async function act(label: string, run: () => Promise<unknown>) {
  busy.value = label
  error.value = ''
  try {
    await run()
    confirmingDelete.value = false
    emit('changed')
    await load()
  } catch (cause) {
    error.value = t('agentApps.actions.failed', { reason: apiErrorReason(cause) })
  } finally {
    busy.value = null
  }
}
const disable = () => act(t('agentApps.actions.disabling', { name: name.value }), () => disableApp(props.app.appId))
const removeCode = () => act(t('agentApps.actions.deletingCode', { name: name.value }), () => deleteAppCode(props.app.appId))

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

      <section v-if="confirmingDelete" class="sheet-confirm" data-app-confirm="code">
        <h3>{{ t('agentApps.removeCode.confirm', { name }) }}</h3>
        <p>{{ t('agentApps.removeCode.body') }}</p>
      </section>
      <GrowthLoading v-if="busy" variant="inline" :label="busy" />
    </div>

    <template #footer>
      <template v-if="confirmingDelete">
        <Button variant="ghost" :disabled="Boolean(busy)" @click="confirmingDelete = false">{{ t('agentApps.actions.cancel') }}</Button>
        <Button variant="destructive" :disabled="Boolean(busy)" data-app-delete-code-confirm @click="removeCode">{{ t('agentApps.actions.deleteCode') }}</Button>
      </template>
      <template v-else>
        <Button v-if="canDisable" variant="outline" :disabled="Boolean(busy)" data-app-disable @click="disable">{{ t('agentApps.actions.disable') }}</Button>
        <Button v-if="canDeleteCode" variant="ghost" class="sheet-danger" :disabled="Boolean(busy)" data-app-delete-code @click="confirmingDelete = true">{{ t('agentApps.actions.deleteCode') }}</Button>
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
.sheet-confirm { display: grid; gap: 8px; padding: 14px 16px; border-radius: var(--radius-card); background: var(--color-surface-subtle); }
.sheet-confirm h3 { margin: 0; font-size: var(--text-body); font-weight: var(--weight-strong); }
.sheet-confirm p { margin: 0; color: var(--color-ink-soft); font-size: var(--text-control); line-height: var(--leading-prose); }
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
.sheet-note { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.sheet-danger { color: var(--color-danger); }
</style>
