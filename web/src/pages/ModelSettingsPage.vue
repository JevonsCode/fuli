<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import ModelRoleDialog from '@/features/model-settings/ModelRoleDialog.vue'
import ModelRoleTrust from '@/features/model-settings/ModelRoleTrust.vue'
import ModelUsage from '@/features/model-settings/ModelUsage.vue'
import RoleSuggestions from '@/features/model-settings/RoleSuggestions.vue'
import { useRoleSuggestions } from '@/features/model-settings/useRoleSuggestions'
import {
  formatCount, localBuildText, readModelRoles, roleName, roleSummary, trustStatusText,
  type ConfigConflict, type ModelRoleId, type ModelRoleView, type ModelRolesPayload,
} from '@/features/model-settings/model'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// 模型与用量 (rec#8, rec#38): one centred column of grouped lists. Each
// built-in Agent is one row (name, state, model, one summary line) that opens
// its settings in place at full row width; editing is a centred form. Then
// what Astro, Bole and Jefa suggested with their model, and their usage. A
// save is accepted only at the local process boundary (a loopback request).
const store = useConsoleStore()
const payload = ref<ModelRolesPayload | null>(null)
const loading = ref(true)
const loadError = ref('')
const editing = ref<ModelRoleId | null>(null)
const notice = ref('')
const stale = ref(false)
let reading: AbortController | null = null
// Read together with the role settings, so the section never appears and then goes.
const suggestions = useRoleSuggestions()
const { entries: suggestionEntries, loading: suggestionsLoading, error: suggestionsError } = suggestions
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

type Fact = { key: string; label: string; value: string; code?: boolean; title?: string }

function facts(view: ModelRoleView): Fact[] {
  const answer = view.answeredBy ? t(`modelSettings.answer.${view.answeredBy}`) : t('modelSettings.none')
  if (!view.connection) return [{ key: 'answeredBy', label: t('modelSettings.answeredBy'), value: answer }, ...trustFact(view)]
  const budget = view.budget
  const egress = view.egress
  const window = budget ? t('modelSettings.windowBudgetValue', { hours: count(budget.windowHours), tokens: count(budget.maxTokensPerWindow) })
    + (budget.maxCostPerWindow === null ? '' : ` · ${t('modelSettings.costCap', {
      amount: budget.maxCostPerWindow, currency: payload.value?.connections[view.connection.id]?.pricing?.currency ?? '' })}`) : t('modelSettings.none')
  return [
    { key: 'answeredBy', label: t('modelSettings.answeredBy'), value: answer },
    { key: 'provider', label: t('modelSettings.provider'), value: `${t(`modelSettings.protocols.${view.connection.protocol}`)} · ${view.connection.endpointHost}` },
    { key: 'model', label: t('modelSettings.model'), value: view.connection.model, code: true },
    ...localBuildFact(view),
    { key: 'secretRef', label: t('modelSettings.secretRef'), value: view.connection.secretRef ?? t('modelSettings.none'), code: Boolean(view.connection.secretRef) },
    { key: 'operations', label: t('modelSettings.operations'), value: view.allowedOperations?.join(', ') || t('modelSettings.none'), code: Boolean(view.allowedOperations?.length) },
    { key: 'egress', label: t('modelSettings.egress'), value: egress
      ? [t('modelSettings.egressProjects', { count: egress.approvedProjects.length }), egress.allowUnassigned ? t('modelSettings.egressUnassigned') : ''].filter(Boolean).join(' · ')
      : t('modelSettings.none') },
    { key: 'callBudget', label: t('modelSettings.callBudget'), value: budget ? t('modelSettings.callBudgetValue', {
      input: count(budget.maxInputTokens), output: count(budget.maxOutputTokens), seconds: count(budget.timeoutMs / 1000) }) : t('modelSettings.none') },
    { key: 'windowBudget', label: t('modelSettings.windowBudget'), value: window },
    { key: 'fallback', label: t('modelSettings.fallback'), value: view.fallbackToSession ? t('modelSettings.allowed') : t('modelSettings.notAllowed') },
    ...trustFact(view),
  ]
}

function localBuildFact(view: ModelRoleView): Fact[] {
  const build = localBuildText(view.localBuild, locale.value)
  return build ? [{ key: 'localBuild', label: t('modelSettings.localBuild.label'), value: build.text, code: build.code, title: build.title }] : []
}

// A role its own model does not answer only suggests; one it answers shows its trust section instead.
const showsTrust = (view: ModelRoleView) => Boolean(view.trust) && view.answeredBy === 'model_api'

function trustFact(view: ModelRoleView): Fact[] {
  if (!view.trust || showsTrust(view)) return []
  return [{ key: 'execution', label: t('modelSettings.trust.label'), value: trustStatusText(view.trust, null) }]
}

function trustSaved(next: ModelRolesPayload) {
  payload.value = next
}

// Rows open on demand; a role that waits for the person (a warning not yet
// read, a configuration that does not validate) opens by itself, once.
const openRoles = ref<string[]>([])
const needsPerson = (view: ModelRoleView) => view.state === 'invalid_config' || Boolean(view.trust && showsTrust(view) && !view.trust.warningSeen)
const announced = new Set<ModelRoleId>()
watch(payload, (next) => {
  const waiting = (next?.roles ?? []).filter(view => needsPerson(view) && !announced.has(view.role)).map(view => view.role)
  waiting.forEach(role => announced.add(role))
  if (waiting.length) openRoles.value = [...new Set([...openRoles.value, ...waiting])]
})

const stateTone = (state: ModelRoleView['state']) =>
  state === 'enabled' ? 'success' : state === 'invalid_config' ? 'warning' : 'secondary'

onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
  void load()
  void suggestions.load()
})
// The top bar's refresh reads the console again; the suggestions with it.
watch(() => store.runtimeStatus, (status) => { if (status === 'loading' && !suggestionsLoading.value) void suggestions.load() })
onBeforeUnmount(() => {
  reading?.abort()
  suggestions.stop()
})
</script>

<template>
  <section class="view model-settings-view" :aria-label="t('modelSettings.title')">
    <div class="model-settings-column">
      <BackLink to="/settings" :from="openedFromSettings">{{ t('modelSettings.back') }}</BackLink>

      <GrowthLoading v-if="loading && !payload" :label="t('modelSettings.loading')" />
      <div v-else-if="loadError && !payload" class="ui-empty rounded-lg border bg-card" role="alert">
        <p class="m-0 text-destructive">{{ t('modelSettings.loadFailed') }} {{ loadError }}</p>
        <Button class="mt-3" size="sm" variant="outline" @click="load">{{ t('modelSettings.retry') }}</Button>
      </div>

      <template v-else-if="payload">
        <section class="ui-section" aria-labelledby="model-roles-title">
          <div class="ui-section-label">
            <h2 id="model-roles-title" class="list-title">{{ t('modelSettings.rolesTitle') }}</h2>
            <GrowthLoading v-if="loading" variant="inline" :label="t('modelSettings.loading')" />
          </div>
          <p v-if="payload.state === 'invalid'" class="model-settings-notice" role="alert" data-model-config-invalid>
            {{ t('modelSettings.invalid', { error: payload.error ?? '' }) }}
          </p>
          <p v-if="stale" class="model-settings-notice" role="alert" data-model-stale>{{ t('modelSettings.changed') }}</p>
          <p v-if="notice" class="model-settings-saved" role="status">{{ notice }}</p>

          <Accordion v-model="openRoles" type="multiple" :unmount-on-hide="false" class="model-role-list">
            <AccordionItem v-for="view in payload.roles" :key="view.role" :value="view.role"
              class="model-role-row" :class="{ 'model-role-row--editing shadow-md': editing === view.role }"
              :data-model-role="view.role">
              <AccordionTrigger class="model-role-summary">
                <span class="model-role-heading">
                  <span class="model-role-title">
                    <strong :id="`model-role-${view.role}`" data-model-role-name>{{ roleName(view.role) }}</strong>
                    <Badge :variant="stateTone(view.state)" data-model-role-state>{{ t(`modelSettings.states.${view.state}`) }}</Badge>
                  </span>
                  <span class="model-role-line" data-model-role-summary>
                    <code v-if="view.connection">{{ view.connection.model }}</code>
                    <span>{{ roleSummary(view) }}</span>
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent class="model-role-detail">
                <dl class="model-role-facts" :aria-labelledby="`model-role-${view.role}`">
                  <div v-for="fact in facts(view)" :key="fact.key" :data-model-fact="fact.key">
                    <dt>{{ fact.label }}</dt>
                    <dd :title="fact.title"><code v-if="fact.code">{{ fact.value }}</code><template v-else>{{ fact.value }}</template></dd>
                  </div>
                </dl>
                <ModelRoleTrust v-if="view.trust && showsTrust(view)" :role="view.role" :trust="view.trust"
                  :model="view.connection?.model ?? null" @saved="trustSaved" @changed="load" />
                <footer class="model-role-actions">
                  <Button variant="outline" size="sm" :disabled="payload.state === 'invalid'" data-model-role-edit
                    :aria-label="`${t('modelSettings.edit')} ${roleName(view.role)}`" @click="edit(view.role)">
                    {{ t('modelSettings.edit') }}
                  </Button>
                </footer>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>

        <RoleSuggestions :entries="suggestionEntries" :loading="suggestionsLoading" :error="suggestionsError" @retry="suggestions.load" @recovery-pending="suggestions.blockForRecovery" />

        <ModelUsage />

        <ModelRoleDialog :role="editing" :payload="payload" :projects="projects"
          @close="editing = null" @saved="saved" @conflict="conflict" />
      </template>
    </div>
  </section>
</template>

<style scoped>
.model-settings-view { padding-top: clamp(16px, 3vw, 32px); padding-bottom: 96px; color: var(--color-ink); }
/* One centred column; sections keep one rhythm (rec#38). */
.model-settings-column { display: grid; gap: var(--space-8); width: 100%; max-width: var(--form-max); margin-inline: auto; }
.model-settings-column > :first-child { justify-self: start; margin-bottom: calc(var(--space-4) - var(--space-8)); }
.model-role-list { min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
.model-role-row { position: relative; min-width: 0; background: var(--color-surface); transition: box-shadow var(--motion-fast); }
.model-role-row:first-child { border-start-start-radius: inherit; border-start-end-radius: inherit; }
.model-role-row:last-child { border-end-start-radius: inherit; border-end-end-radius: inherit; }
/* The row being edited lifts as a card above its neighbours. */
.model-role-row--editing { z-index: 1; border-radius: var(--radius-card); outline: 1px solid var(--color-border-strong); }
.model-role-row :deep(.model-role-summary) { padding: 14px 16px; border-radius: inherit; color: var(--color-ink); font-size: 14px; font-weight: 400; }
.model-role-row :deep(.model-role-summary:hover) { color: var(--color-ink); background: var(--color-surface-hover); }
.model-role-heading { display: grid; gap: 4px; min-width: 0; }
.model-role-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.model-role-title strong { font-size: 15px; font-weight: 600; }
.model-role-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; color: var(--color-muted); font-size: 13px; line-height: 1.5; }
.model-role-line > span { min-width: 0; overflow-wrap: anywhere; }
.model-role-line code, .model-role-facts code { color: var(--color-ink); font-family: var(--font-mono); font-size: 12.5px; overflow-wrap: anywhere; }
.model-role-row :deep(.model-role-detail) { display: grid; gap: 14px; margin: 0 16px; padding: 14px 0 16px; border-top: 1px solid var(--color-border); }
/* Inside a row the facts are one uniform two-column list: label, then value. */
.model-role-facts { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: 8px 20px; margin: 0; font-size: 14px; }
.model-role-facts div { display: contents; }
.model-role-facts dt { color: var(--color-muted); }
.model-role-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.model-role-actions { display: flex; justify-content: flex-end; }
.model-settings-notice, .model-settings-saved { margin: 0; padding: 12px 16px; border: 1px solid var(--color-border);
  border-radius: var(--radius-card); background: var(--color-surface); font-size: 14px; }
.model-settings-notice { color: var(--color-danger); }
@media (max-width: 520px) {
  .model-role-facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .model-role-facts div + div dt { margin-top: 10px; }
}
</style>
