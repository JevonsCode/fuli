<script setup lang="ts">
import { computed, ref } from 'vue'
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
  VISIBLE_SUGGESTIONS, isSuggestion, orderSuggestions, readScoreCard, scoreValue, suggestionAction, suggestionEvidence, suggestionModel,
  suggestionState, suggestionText, suggestionWhy, type RoleSuggestion, type ScoreCard, type SuggestionState,
} from './suggestions'

// 建议记录: what Astro, Bole and Jefa showed after asking their own model, as
// recorded then (rec#10 D-30), never a to-do. The page reads them with the
// role settings; until they arrive nothing but an inline wait shows, and with
// none the section is not there. An action opens the page where the person
// decides. This section only reads.
const props = defineProps<{ entries: RoleSuggestion[] | null; loading: boolean; error: string }>()
const emit = defineEmits<{ retry: [] }>()

const showAll = ref(false)
const opened = ref<number | null>(null)
const scoreCards = ref<Record<number, ScoreCard>>({})
const scoreCardError = ref('')
const scoreCardLoading = ref<number | null>(null)

// Bole's suggestions name an Agent by id; its name comes from the roster.
const boleEntries = computed(() => (props.entries ?? []).filter(entry => entry.role === 'bole' && entry.subject.agentId))
const agentSpace = computed(() => boleEntries.value[0]?.personalSpaceId ?? '')
const agentIds = computed(() => boleEntries.value.map(entry => entry.subject.agentId!))
const { records: agents } = useAgentRecords(agentSpace, agentIds)
const agentName = (entry: RoleSuggestion) => agents.value[entry.subject.agentId!]?.profile.name ?? entry.subject.agentId!

const TONES: Record<SuggestionState, 'default' | 'secondary' | 'warning' | 'outline'> = {
  suggested: 'default', newer: 'secondary', superseded: 'secondary', fallback: 'outline', stopped: 'warning',
}
const ordered = computed(() => orderSuggestions(props.entries ?? []))
const views = computed(() => ordered.value.slice(0, showAll.value ? undefined : VISIBLE_SUGGESTIONS).map(entry => ({
  entry, state: suggestionState(entry), text: suggestionText(entry), why: suggestionWhy(entry), model: suggestionModel(entry),
  evidence: suggestionEvidence(entry), action: suggestionAction(entry),
  at: formatDateTime(entry.at, currentLocale(), DATE_TIME_MINUTE, { missing: '' }),
})))
// Suggestions are cards; the rest say why in one line each.
const cards = computed(() => views.value.filter(view => isSuggestion(view.state)))
const lines = computed(() => views.value.filter(view => !isSuggestion(view.state)))

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
</script>

<template>
  <GrowthLoading v-if="loading && !entries" variant="inline" :label="t('modelSettings.suggestions.loading')" />
  <p v-else-if="error && !entries" class="role-suggestions-error" role="alert">
    {{ t('modelSettings.suggestions.loadFailed') }} {{ error }}
    <Button variant="outline" size="sm" @click="emit('retry')">{{ t('modelSettings.retry') }}</Button>
  </p>
  <section v-else-if="entries?.length" class="role-suggestions" aria-labelledby="role-suggestions-title" data-role-suggestions>
    <div class="role-suggestions-bar">
      <h2 id="role-suggestions-title">{{ t('modelSettings.suggestions.title') }}</h2>
      <GrowthLoading v-if="loading" variant="inline" :label="t('modelSettings.suggestions.loading')" />
    </div>
    <p class="role-suggestions-note" data-role-suggestions-note>{{ t('modelSettings.suggestions.note') }}</p>
    <ul v-if="cards.length" class="role-suggestions-grid">
      <li v-for="{ entry, state, text, model, evidence, action, at } in cards" :key="entry.id">
        <article class="role-suggestion border transition-[border-color,box-shadow]"
          :class="opened === entry.id ? 'border-border-strong shadow-md' : 'border-border'"
          :data-role-suggestion="entry.role" :data-suggestion-state="state" :aria-labelledby="`role-suggestion-${entry.id}`">
          <header>
            <strong :id="`role-suggestion-${entry.id}`">{{ roleName(entry.role) }}</strong>
            <Badge :variant="TONES[state]" data-suggestion-status>{{ t(`modelSettings.suggestions.states.${state}`) }}</Badge>
          </header>
          <p class="role-suggestion-text" data-suggestion-text>
            <template v-if="entry.role === 'bole'">
              <AgentName :space-id="entry.personalSpaceId" :agent-id="entry.subject.agentId!" :name="agentName(entry)" /> ·
            </template>{{ text }}
          </p>
          <p v-if="entry.suggestion?.reason" class="role-suggestion-reason">{{ entry.suggestion.reason }}</p>
          <dl>
            <div>
              <dt>{{ t('modelSettings.model') }}</dt>
              <dd :title="evidence.title"><code>{{ model ?? t('modelSettings.none') }}</code></dd>
            </div>
            <div>
              <dt>{{ t('modelSettings.suggestions.time') }}</dt>
              <dd><time :datetime="entry.at">{{ at }}</time></dd>
            </div>
            <div v-if="evidence.dimensions.length" class="role-suggestion-evidence" data-suggestion-evidence>
              <dt>{{ t('modelSettings.suggestions.evidence') }}</dt>
              <dd>{{ evidence.dimensions.join(' · ') }}</dd>
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
            <p v-else-if="scoreCardError" class="role-suggestion-failed" role="alert">{{ t('modelSettings.suggestions.scoreCardFailed') }} {{ scoreCardError }}</p>
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
    <ul v-if="lines.length" class="role-suggestions-lines">
      <li v-for="{ entry, state, why, model, evidence, action, at } in lines" :key="entry.id" class="role-suggestion-line"
        :data-role-suggestion="entry.role" :data-suggestion-state="state" :title="evidence.title">
        <strong>{{ roleName(entry.role) }}</strong>
        <Badge :variant="TONES[state]" data-suggestion-status>{{ t(`modelSettings.suggestions.states.${state}`) }}</Badge>
        <span class="role-suggestion-why" data-suggestion-why>{{ why }}</span>
        <span class="role-suggestion-meta"><code>{{ model ?? t('modelSettings.none') }}</code> · {{ t('modelSettings.suggestions.time') }} <time :datetime="entry.at">{{ at }}</time></span>
        <Button v-if="action?.kind === 'link'" as-child size="sm" variant="ghost">
          <RouterLink :to="action.to" data-suggestion-action>{{ action.label }}</RouterLink>
        </Button>
      </li>
    </ul>
    <Button v-if="!showAll && entries.length > VISIBLE_SUGGESTIONS" class="justify-self-start" size="sm" variant="outline"
      data-suggestions-show-all @click="showAll = true">
      {{ t('modelSettings.suggestions.showAll', { count: entries.length }) }}
    </Button>
  </section>
</template>

<style scoped>
.role-suggestions { container-type: inline-size; display: grid; gap: 12px; min-width: 0; }
.role-suggestions-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.role-suggestions h2 { margin: 0; font-size: 16px; font-weight: 600; }
.role-suggestions-note { margin: -4px 0 0; color: var(--color-muted); font-size: 14px; }
.role-suggestions-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin: 0; padding: 0; list-style: none; }
@container (min-width: 620px) { .role-suggestions-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 960px) { .role-suggestions-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (min-width: 1400px) { .role-suggestions-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.role-suggestion { display: grid; align-content: start; gap: 10px; height: 100%; min-width: 0; padding: 16px;
  border-radius: var(--radius-card); background: var(--color-surface); }
.role-suggestion header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.role-suggestion p { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.role-suggestion-reason { color: var(--color-muted); }
.role-suggestion dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 0; }
.role-suggestion-evidence { grid-column: 1 / -1; }
.role-suggestion dt { color: var(--color-muted); font-size: 12px; }
.role-suggestion dd { margin: 2px 0 0; font-size: 14px; overflow-wrap: anywhere; }
.role-suggestion code, .role-suggestion-line code { font-family: var(--font-mono); font-size: 12.5px; }
.role-suggestion footer { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; border-top: 1px solid var(--color-border); }
.role-suggestion-score { padding-top: 10px; border-top: 1px solid var(--color-border); }
.role-suggestion-failed { color: var(--color-danger); }
.role-suggestions-lines { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-border);
  border-radius: var(--radius-card); background: var(--color-surface); }
.role-suggestion-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; padding: 8px 16px; font-size: 14px; }
.role-suggestion-line + .role-suggestion-line { border-top: 1px solid var(--color-border); }
.role-suggestion-why { flex: 1 1 16rem; min-width: 0; overflow-wrap: anywhere; }
.role-suggestion-meta { color: var(--color-muted); font-size: 12.5px; overflow-wrap: anywhere; }
.role-suggestions-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; color: var(--color-danger); font-size: 14px; }
</style>
