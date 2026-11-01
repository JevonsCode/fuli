<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { apiErrorCode, apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiIcon } from '@/ui'
import type { IconName } from '@/ui/icons'
import AppSheet from './AppSheet.vue'
import { listApps, type AgentAppRow } from './agent-apps'
import { appGroup, appStatus, appTypeLabel, type AppGroup } from './app-labels'

// 应用: every app the space's FLAs built, grouped by what it needs from the
// person. A row opens the app's details, where it is confirmed, disabled or removed.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')

const apps = ref<AgentAppRow[]>([])
const state = ref<'loading' | 'ready' | 'failed' | 'unavailable'>('loading')
const error = ref('')
const refreshing = ref(false)
let generation = 0
async function load() {
  if (!spaceId.value) return
  const current = ++generation
  if (state.value === 'ready') refreshing.value = true
  else state.value = 'loading'
  try {
    const result = await listApps(spaceId.value)
    if (current !== generation) return
    apps.value = result.apps
    state.value = 'ready'
  } catch (cause) {
    if (current !== generation) return
    if (state.value !== 'ready') state.value = apiErrorCode(cause) === 'agent_apps_unavailable' ? 'unavailable' : 'failed'
    error.value = apiErrorReason(cause, t('agentApps.loadFailed'))
  } finally {
    if (current === generation) refreshing.value = false
  }
}
onMounted(() => { if (!store.state) void store.refresh() })
watch(spaceId, () => void load(), { immediate: true })

const owners = useAgentRecords(spaceId, computed(() => [...new Set(apps.value.map(app => app.agentId))]))
const ownerName = (agentId: string) => {
  const record = owners.records.value[agentId]
  return record ? agentDisplayName(record) : t('agentApps.unknownAgent')
}

const ORDER: AppGroup[] = ['attention', 'running', 'ready', 'removed']
const TYPE_ICONS: Record<string, IconName> = { page: 'grid', tool: 'list', service: 'power' }
const groups = computed(() => ORDER
  .map(key => ({ key, rows: apps.value.filter(app => appGroup(app) === key).sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name)) }))
  .filter(group => group.rows.length))

const opened = ref<AgentAppRow | null>(null)
function changed() { void load() }
</script>

<template>
  <section class="view apps-view" :aria-label="t('agentApps.title')">
    <div class="apps">
      <header class="apps-bar">
        <span class="apps-count" role="status">
          <GrowthLoading v-if="refreshing" variant="inline" :label="t('agentApps.refreshing')" />
          <template v-else-if="apps.length">{{ t('agentApps.count', { count: apps.length }) }}</template>
        </span>
        <Button variant="ghost" size="sm" :disabled="state === 'loading' || refreshing" data-apps-refresh @click="load">
          <UiIcon name="refresh" :size="14" />{{ t('common.actions.refresh') }}
        </Button>
      </header>

      <GrowthLoading v-if="state === 'loading'" :label="t('agentApps.loading')" />
      <p v-else-if="state === 'unavailable'" class="apps-empty">{{ t('agentApps.unavailable') }}</p>
      <div v-else-if="state === 'failed'" class="apps-empty" role="alert">
        <p>{{ error }}</p>
        <Button size="sm" variant="outline" @click="load">{{ t('agentApps.retry') }}</Button>
      </div>
      <p v-else-if="!apps.length" class="apps-empty" data-apps-empty>{{ t('agentApps.empty') }}</p>

      <section v-for="group in groups" :key="group.key" class="apps-group" :aria-labelledby="`apps-group-${group.key}`" :data-apps-group="group.key">
        <h2 :id="`apps-group-${group.key}`" class="apps-group-label">{{ t(`agentApps.groups.${group.key}`) }} <span class="ui-num">{{ group.rows.length }}</span></h2>
        <ul class="apps-list">
          <li v-for="app in group.rows" :key="app.appId">
            <Button variant="ghost" class="app-row" :data-app="app.appId" @click="opened = app">
              <span class="app-icon" aria-hidden="true"><UiIcon :name="TYPE_ICONS[app.type ?? ''] ?? 'grid'" :size="18" /></span>
              <span class="app-text">
                <span class="app-title">{{ app.title ?? app.name }}</span>
                <span class="app-meta">{{ appTypeLabel(app.type) }}<template v-if="app.version"> · v{{ app.version }}</template></span>
              </span>
              <span class="app-owner" :title="t('agentApps.by', { name: ownerName(app.agentId) })">
                <span class="app-face" :style="agentIdentityStyle(app.agentId)" aria-hidden="true"><img :src="agentAvatarUrl(app.agentId)" alt="" /></span>
                <span class="ui-sr-only">{{ t('agentApps.by', { name: ownerName(app.agentId) }) }}</span>
              </span>
              <span class="app-status" :data-tone="appStatus(app).tone">{{ appStatus(app).text }}</span>
              <UiIcon name="chevron-right" :size="16" class="app-chevron" />
            </Button>
          </li>
        </ul>
      </section>
    </div>
    <AppSheet v-if="opened" :app="opened" :owner-name="ownerName(opened.agentId)" @close="opened = null" @changed="changed" />
  </section>
</template>

<style scoped>
.apps { display: flex; flex-direction: column; gap: 28px; width: 100%; max-width: 1120px; margin-inline: auto; }
.apps-bar { display: flex; align-items: center; justify-content: flex-end; gap: 12px; min-height: 36px; }
.apps-count { margin-right: auto; color: var(--color-muted); font-size: var(--text-control); font-variant-numeric: tabular-nums; }
.apps-empty { display: grid; justify-items: center; gap: 10px; margin: 0; padding: 48px 16px; border-radius: var(--radius-card); color: var(--color-muted); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); text-align: center; }
.apps-empty p { margin: 0; }
.apps-group { display: grid; gap: 8px; }
.apps-group-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 18px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.apps-group-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
/* An inset grouped list: one white surface, rows split by hairlines that start after the icon. */
.apps-list { margin: 0; padding: 0; overflow: hidden; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); list-style: none; }
.apps-list li + li .app-row::before { content: ''; position: absolute; top: 0; right: 0; left: 64px; height: 1px; background: var(--color-border); }
.app-row {
  position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr) auto auto 16px; align-items: center; gap: 14px;
  width: 100%; height: auto; padding: 12px 16px; border-radius: 0; color: var(--color-ink); font-weight: var(--weight-regular); text-align: left; white-space: normal;
}
.app-icon { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 10px; color: var(--color-ink-soft); background: var(--color-surface-hover); }
.app-text { display: grid; gap: 2px; min-width: 0; }
.app-title { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.app-meta { color: var(--color-muted); font-size: var(--text-meta); }
.app-face { display: grid; width: 24px; height: 24px; overflow: hidden; place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-surface-hover)); }
.app-face img { width: 100%; height: 100%; object-fit: cover; }
.app-status { color: var(--color-muted); font-size: var(--text-meta); text-align: right; }
.app-status[data-tone="attention"] { color: var(--color-ink); font-weight: var(--weight-medium); }
.app-status[data-tone="running"] { color: var(--color-success); }
.app-status[data-tone="danger"] { color: var(--color-danger); }
.app-chevron { color: var(--color-faint); }
@media (max-width: 640px) {
  .app-row { grid-template-columns: 36px minmax(0, 1fr) 16px; }
  .app-owner { display: none; }
  .app-status { grid-column: 2; text-align: left; }
  .app-chevron { grid-row: 1; grid-column: 3; }
}
</style>
