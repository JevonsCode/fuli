<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import AgentName from '@/features/agent-profile/AgentName.vue'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { roleName } from './model'
import {
  readRoleSuggestions, readScoreCard, scoreValue, suggestionAction, suggestionEvidence, suggestionModel, suggestionState,
  suggestionText, suggestionWhy, type RoleSuggestion, type ScoreCard, type SuggestionState,
} from './suggestions'

// 建议: what Astro, Bole and Jefa showed after asking their own model. Each is
// a suggestion only; its action opens the page where the person decides.
// This section only reads.
const entries = ref<RoleSuggestion[] | null>(null)
const loading = ref(true)
const error = ref('')
const opened = ref<number | null>(null)
const scoreCards = ref<Record<number, ScoreCard>>({})
const scoreCardError = ref('')
const scoreCardLoading = ref<number | null>(null)
let reading: AbortController | null = null

// Bole's suggestions name an Agent by id; its name comes from the roster.
const boleEntries = computed(() => (entries.value ?? []).filter(entry => entry.role === 'bole' && entry.subject.agentId))
const agentSpace = computed(() => boleEntries.value[0]?.personalSpaceId ?? '')
const agentIds = computed(() => boleEntries.value.map(entry => entry.subject.agentId!))
const { records: agents } = useAgentRecords(agentSpace, agentIds)
const agentName = (entry: RoleSuggestion) => agents.value[entry.subject.agentId!]?.profile.name ?? entry.subject.agentId!

const TONES: Record<SuggestionState, 'default' | 'secondary' | 'warning' | 'outline'> = {
  suggested: 'default', superseded: 'secondary', stopped: 'warning', fallback: 'outline',
}
const views = computed(() => (entries.value ?? []).map(entry => ({
  entry, state: suggestionState(entry), text: suggestionText(entry), why: suggestionWhy(entry), model: suggestionModel(entry),
  evidence: suggestionEvidence(entry), action: suggestionAction(entry),
  at: formatDateTime(entry.at, currentLocale(), DATE_TIME_MINUTE, { missing: '' }),
})))

async function load() {
  reading?.abort()
  reading = new AbortController()
  loading.value = true
  error.value = ''
  try {
    entries.value = await readRoleSuggestions(reading.signal)
  } catch (cause) {
    if ((cause as Error)?.name !== 'AbortError') error.value = apiErrorReason(cause)
  } finally {
    loading.value = false
  }
}

async function toggleScoreCard(entry: RoleSuggestion) {
  scoreCardError.value = ''
  if (opened.value === entry.id) {
    opened.value = null
    return
  }
  opened.value = entry.id
  if (scoreCards.value[entry.id]) return
  scoreCardLoading.value = entry.id
  try {
    scoreCards.value = { ...scoreCards.value, [entry.id]: await readScoreCard(entry) }
  } catch (cause) {
    if (opened.value === entry.id) scoreCardError.value = apiErrorReason(cause)
  } finally {
    if (scoreCardLoading.value === entry.id) scoreCardLoading.value = null
  }
}

onMounted(load)
onBeforeUnmount(() => reading?.abort())
</script>

<template>
  <section v-if="loading || error || entries?.length" class="role-suggestions" aria-labelledby="role-suggestions-title" data-role-suggestions>
    <h2 id="role-suggestions-title">{{ t('modelSettings.suggestions.title') }}</h2>
    <GrowthLoading v-if="loading && !entries" variant="compact" :label="t('modelSettings.suggestions.loading')" />
    <div v-else-if="error && !entries" class="role-suggestions-error" role="alert">
      <p>{{ t('modelSettings.suggestions.loadFailed') }} {{ error }}</p>
      <Button variant="outline" size="sm" @click="load">{{ t('modelSettings.retry') }}</Button>
    </div>
    <ul v-else class="role-suggestions-grid">
      <li v-for="{ entry, state, text, why, model, evidence, action, at } in views" :key="entry.id">
        <article class="role-suggestion border transition-[border-color,box-shadow]"
          :class="opened === entry.id ? 'border-border-strong shadow-md' : 'border-border'"
          :data-role-suggestion="entry.role" :data-suggestion-state="state" :aria-labelledby="`role-suggestion-${entry.id}`">
          <header>
            <strong :id="`role-suggestion-${entry.id}`">{{ roleName(entry.role) }}</strong>
            <Badge :variant="TONES[state]" data-suggestion-status>
              {{ t(`modelSettings.suggestions.states.${state}`) }}
            </Badge>
            <Badge variant="outline" data-suggestion-gate>{{ t('modelSettings.gates.suggestion_only') }}</Badge>
          </header>
          <p v-if="text" class="role-suggestion-text" data-suggestion-text>
            <template v-if="entry.role === 'bole'">
              <AgentName :space-id="entry.personalSpaceId" :agent-id="entry.subject.agentId!" :name="agentName(entry)" /> ·
            </template>{{ text }}
          </p>
          <p v-if="entry.suggestion?.reason" class="role-suggestion-reason">{{ entry.suggestion.reason }}</p>
          <p v-if="why" class="role-suggestion-why" data-suggestion-why>{{ why }}</p>
          <dl>
            <div>
              <dt>{{ t('modelSettings.model') }}</dt>
              <dd><code>{{ model ?? t('modelSettings.none') }}</code></dd>
            </div>
            <div>
              <dt>{{ t('modelSettings.suggestions.time') }}</dt>
              <dd><time :datetime="entry.at">{{ at }}</time></dd>
            </div>
            <div class="role-suggestion-evidence" data-suggestion-evidence>
              <dt>{{ t('modelSettings.suggestions.evidence') }}</dt>
              <dd :title="evidence.title">
                <span v-for="name in evidence.dimensions" :key="name">{{ name }} · </span><code>{{ evidence.version }}…</code>
              </dd>
            </div>
          </dl>
          <footer v-if="action">
            <Button v-if="action.kind === 'link'" as-child size="sm" variant="outline">
              <RouterLink :to="action.to" data-suggestion-action>{{ action.label }}</RouterLink>
            </Button>
            <Button v-else size="sm" variant="outline" :aria-expanded="opened === entry.id" data-suggestion-action @click="toggleScoreCard(entry)">
              {{ opened === entry.id ? t('modelSettings.suggestions.closeScoreCard') : action.label }}
            </Button>
          </footer>
          <template v-if="opened === entry.id">
            <GrowthLoading v-if="scoreCardLoading === entry.id" variant="inline"
              :label="t('modelSettings.suggestions.scoreCardLoading', { name: agentName(entry) })" />
            <p v-else-if="scoreCardError" class="role-suggestion-why" role="alert">{{ t('modelSettings.suggestions.scoreCardFailed') }} {{ scoreCardError }}</p>
            <dl v-else-if="scoreCards[entry.id]" class="role-suggestion-score" data-suggestion-score-card>
              <div v-for="(dimension, name) in scoreCards[entry.id].dimensions" :key="name">
                <dt>{{ t(`modelSettings.suggestions.dimensions.${name}`) }}</dt>
                <dd>{{ scoreValue(dimension) }}</dd>
              </div>
            </dl>
          </template>
        </article>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.role-suggestions { container-type: inline-size; display: grid; gap: 12px; min-width: 0; }
.role-suggestions h2 { margin: 0; font-size: 16px; font-weight: 600; }
.role-suggestions-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin: 0; padding: 0; list-style: none; }
@container (min-width: 620px) { .role-suggestions-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 960px) { .role-suggestions-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (min-width: 1400px) { .role-suggestions-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.role-suggestion { display: grid; align-content: start; gap: 10px; height: 100%; min-width: 0; padding: 16px;
  border-radius: var(--radius-card); background: var(--color-surface); }
.role-suggestion header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.role-suggestion p { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.role-suggestion-reason { color: var(--color-muted); }
.role-suggestion-why { color: var(--color-ink); }
.role-suggestion dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 0; }
.role-suggestion-evidence { grid-column: 1 / -1; }
.role-suggestion dt { color: var(--color-muted); font-size: 12px; }
.role-suggestion dd { margin: 2px 0 0; font-size: 14px; overflow-wrap: anywhere; }
.role-suggestion code { font-family: var(--font-mono); font-size: 12.5px; }
.role-suggestion footer { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; border-top: 1px solid var(--color-border); }
.role-suggestion-score { padding-top: 10px; border-top: 1px solid var(--color-border); }
.role-suggestions-error { display: grid; justify-items: start; gap: 8px; padding: 16px; border: 1px dashed var(--color-border);
  border-radius: var(--radius-card); color: var(--color-danger); font-size: 14px; }
.role-suggestions-error p { margin: 0; }
</style>
