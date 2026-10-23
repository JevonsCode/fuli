<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import ModelRoleDialog from '@/features/model-settings/ModelRoleDialog.vue'
import ModelUsage from '@/features/model-settings/ModelUsage.vue'
import {
  formatCount, readModelRoles, roleName, type ConfigConflict, type ModelRoleId, type ModelRoleView, type ModelRolesPayload,
} from '@/features/model-settings/model'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// 模型与用量 (rec#8): the four built-in Agents' model settings as one card
// collection, each edited in a centred form, and their usage below. A save
// is accepted only at the local process boundary (a loopback request).
const store = useConsoleStore()
const payload = ref<ModelRolesPayload | null>(null)
const loading = ref(true)
const loadError = ref('')
const editing = ref<ModelRoleId | null>(null)
const notice = ref('')
const stale = ref(false)
let reading: AbortController | null = null
const openedFromSettings = /^\/settings(?:[?#]|$)/

const projects = computed(() => store.state?.personalProjects ?? [])
const locale = computed(() => currentLocale())

async function load() {
  reading?.abort()
  reading = new AbortController()
  loading.value = true
  loadError.value = ''
  try {
    payload.value = await readModelRoles(reading.signal)
  } catch (cause) {
    if ((cause as Error)?.name !== 'AbortError') loadError.value = apiErrorReason(cause)
  } finally {
    loading.value = false
  }
}

function edit(role: ModelRoleId) {
  notice.value = ''
  stale.value = false
  editing.value = role
}

function saved(next: ModelRolesPayload) {
  notice.value = t('modelSettings.saved', { name: roleName(editing.value!) })
  payload.value = next
  editing.value = null
}

// A changed file closes the form; one that stopped validating keeps it open,
// read again and locked, until the file is repaired.
async function conflict(code: ConfigConflict) {
  if (code === 'model_config_changed') {
    editing.value = null
    stale.value = true
  }
  await load()
}

const count = (value: number) => formatCount(value, locale.value)

function facts(view: ModelRoleView) {
  const answer = view.answeredBy ? t(`modelSettings.answer.${view.answeredBy}`) : t('modelSettings.none')
  if (!view.connection) return [{ key: 'answeredBy', label: t('modelSettings.answeredBy'), value: answer }]
  const budget = view.budget
  const egress = view.egress
  const window = budget ? t('modelSettings.windowBudgetValue', { hours: count(budget.windowHours), tokens: count(budget.maxTokensPerWindow) })
    + (budget.maxCostPerWindow === null ? '' : ` · ${t('modelSettings.costCap', {
      amount: budget.maxCostPerWindow, currency: payload.value?.connections[view.connection.id]?.pricing?.currency ?? '' })}`) : t('modelSettings.none')
  return [
    { key: 'answeredBy', label: t('modelSettings.answeredBy'), value: answer },
    { key: 'provider', label: t('modelSettings.provider'), value: `${t(`modelSettings.protocols.${view.connection.protocol}`)} · ${view.connection.endpointHost}` },
    { key: 'model', label: t('modelSettings.model'), value: view.connection.model, code: true },
    { key: 'secretRef', label: t('modelSettings.secretRef'), value: view.connection.secretRef ?? t('modelSettings.none'), code: Boolean(view.connection.secretRef) },
    { key: 'operations', label: t('modelSettings.operations'), value: view.allowedOperations?.join(', ') || t('modelSettings.none'), code: Boolean(view.allowedOperations?.length) },
    { key: 'egress', label: t('modelSettings.egress'), value: egress
      ? [t('modelSettings.egressProjects', { count: egress.approvedProjects.length }), egress.allowUnassigned ? t('modelSettings.egressUnassigned') : ''].filter(Boolean).join(' · ')
      : t('modelSettings.none') },
    { key: 'callBudget', label: t('modelSettings.callBudget'), value: budget ? t('modelSettings.callBudgetValue', {
      input: count(budget.maxInputTokens), output: count(budget.maxOutputTokens), seconds: count(budget.timeoutMs / 1000) }) : t('modelSettings.none') },
    { key: 'windowBudget', label: t('modelSettings.windowBudget'), value: window },
    { key: 'fallback', label: t('modelSettings.fallback'), value: view.fallbackToSession ? t('modelSettings.allowed') : t('modelSettings.notAllowed') },
    ...(view.reviewGate ? [{ key: 'gate', label: t('modelSettings.gate'), value: t(`modelSettings.gates.${view.reviewGate.status}`) }] : []),
  ]
}

const stateTone = (state: ModelRoleView['state']) =>
  state === 'enabled' ? 'success' : state === 'invalid_config' ? 'warning' : 'secondary'

onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
  void load()
})
onBeforeUnmount(() => reading?.abort())
</script>

<template>
  <section class="view model-settings-view" :aria-label="t('modelSettings.title')">
    <div class="@container mx-auto grid w-full max-w-(--canvas-max) gap-4">
      <BackLink to="/settings" :from="openedFromSettings">{{ t('modelSettings.back') }}</BackLink>

      <GrowthLoading v-if="loading && !payload" :label="t('modelSettings.loading')" />
      <div v-else-if="loadError && !payload" class="ui-empty rounded-lg border bg-card" role="alert">
        <p class="m-0 text-destructive">{{ t('modelSettings.loadFailed') }} {{ loadError }}</p>
        <Button class="mt-3" size="sm" variant="outline" @click="load">{{ t('modelSettings.retry') }}</Button>
      </div>

      <template v-else-if="payload">
        <p v-if="payload.state === 'invalid'" class="model-settings-notice" role="alert" data-model-config-invalid>
          {{ t('modelSettings.invalid', { error: payload.error ?? '' }) }}
        </p>
        <p v-if="stale" class="model-settings-notice" role="alert" data-model-stale>{{ t('modelSettings.changed') }}</p>
        <p v-if="notice" class="model-settings-saved" role="status">{{ notice }}</p>
        <GrowthLoading v-if="loading" variant="inline" :label="t('modelSettings.loading')" />

        <ul class="m-0 grid list-none grid-cols-1 gap-3 p-0 @min-[620px]:grid-cols-2 @min-[1400px]:grid-cols-4">
          <li v-for="view in payload.roles" :key="view.role" class="min-w-0" :class="{ 'self-start': view.state === 'not_configured' }">
            <article class="model-role-card flex h-full min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 transition-[border-color,box-shadow]"
              :class="{ 'border-border-strong shadow-md': editing === view.role }" :data-model-role="view.role"
              :aria-labelledby="`model-role-${view.role}`">
              <header class="flex flex-wrap items-center gap-2">
                <h2 :id="`model-role-${view.role}`" class="m-0 text-base font-semibold">{{ roleName(view.role) }}</h2>
                <Badge :variant="stateTone(view.state)" data-model-role-state>{{ t(`modelSettings.states.${view.state}`) }}</Badge>
              </header>
              <dl class="model-role-facts">
                <div v-for="fact in facts(view)" :key="fact.key" :data-model-fact="fact.key">
                  <dt>{{ fact.label }}</dt>
                  <dd><code v-if="fact.code">{{ fact.value }}</code><template v-else>{{ fact.value }}</template></dd>
                </div>
              </dl>
              <footer class="mt-auto flex border-t pt-3">
                <Button variant="outline" size="sm" :disabled="payload.state === 'invalid'" data-model-role-edit
                  :aria-label="`${t('modelSettings.edit')} ${roleName(view.role)}`" @click="edit(view.role)">
                  {{ t('modelSettings.edit') }}
                </Button>
              </footer>
            </article>
          </li>
        </ul>

        <ModelUsage />

        <ModelRoleDialog :role="editing" :payload="payload" :projects="projects"
          @close="editing = null" @saved="saved" @conflict="conflict" />
      </template>
    </div>
  </section>
</template>

<style scoped>
.model-settings-view { padding-top: clamp(16px, 3vw, 32px); padding-bottom: 96px; color: var(--color-ink); }
.model-role-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr)); gap: 10px 16px; margin: 0; }
.model-role-facts div { min-width: 0; }
.model-role-facts dt { color: var(--color-muted); font-size: 12px; }
.model-role-facts dd { margin: 2px 0 0; font-size: 14px; overflow-wrap: anywhere; }
.model-role-facts code { font-family: var(--font-mono); font-size: 12.5px; }
.model-settings-notice, .model-settings-saved { margin: 0; padding: 12px 16px; border: 1px solid var(--color-border);
  border-radius: var(--radius-card); background: var(--color-surface); font-size: 14px; }
.model-settings-notice { color: var(--color-danger); }
</style>
