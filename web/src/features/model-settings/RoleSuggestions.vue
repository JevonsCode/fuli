<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { apiErrorReason, isKnowledgeRecoveryPending } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import AgentName from '@/features/agent-profile/AgentName.vue'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { roleName } from './model'
import {
  VISIBLE_SUGGESTIONS, isSuggestion, logSuggestionView, orderSuggestions, readScoreCard, scoreValue,
  type RoleSuggestion, type ScoreCard, type SuggestionState, type SuggestionView,
} from './suggestions'
import { tonborgSuggestionView, type TonborgSuggestion } from './tonborg-suggestions'

// 建议记录: what Astro, Bole and Jefa showed after asking their own model, as
// recorded then (rec#10 D-30), and the knowledge reviews Tonborg left to the
// person (rec#8), never a to-do. The page reads both with the role settings;
// until something arrives nothing but an inline wait shows, and with none the
// section is not there. An action opens the page where the person decides.
// This section only reads.
const props = withDefaults(defineProps<{
  entries: RoleSuggestion[] | null; loading: boolean; error: string
  reviews?: TonborgSuggestion[] | null; reviewsLoading?: boolean; reviewsError?: string
}>(), { reviews: null, reviewsLoading: false, reviewsError: '' })
const emit = defineEmits<{ retry: []; recoveryPending: [cause: unknown] }>()

const showAll = ref(false)
const opened = ref<string | null>(null)
const scoreCards = ref<Record<string, ScoreCard>>({})
const scoreCardError = ref('')
const scoreCardLoading = ref<string | null>(null)
let scoreCardRequest = 0
function clearScoreCards() {
  ++scoreCardRequest
  opened.value = null
  scoreCards.value = {}
  scoreCardError.value = ''
  scoreCardLoading.value = null
}
watch(() => props.entries, clearScoreCards, { flush: 'sync' })
onBeforeUnmount(clearScoreCards)


// Bole's suggestions name an Agent by id; its name comes from the roster.
const boleEntries = computed(() => (props.entries ?? []).filter(entry => entry.role === 'bole' && entry.subject.agentId))
const agentSpace = computed(() => boleEntries.value[0]?.personalSpaceId ?? '')
const agentIds = computed(() => boleEntries.value.map(entry => entry.subject.agentId!))
const { records: agents } = useAgentRecords(agentSpace, agentIds)
const agentName = (entry: RoleSuggestion) => agents.value[entry.subject.agentId!]?.profile.name ?? entry.subject.agentId!

const TONES: Record<SuggestionState, 'default' | 'secondary' | 'warning' | 'outline'> = {
  suggested: 'default', newer: 'secondary', superseded: 'secondary', fallback: 'outline', stopped: 'warning',
}
const ordered = computed(() => orderSuggestions([...(props.entries ?? []).map(logSuggestionView), ...(props.reviews ?? []).map(tonborgSuggestionView)]))
const views = computed(() => ordered.value.slice(0, showAll.value ? undefined : VISIBLE_SUGGESTIONS).map(view => ({
  ...view, time: formatDateTime(view.at, currentLocale(), DATE_TIME_MINUTE, { missing: '' }),
})))
// Suggestions are cards; the rest say why in one line each.
const cards = computed(() => views.value.filter(view => isSuggestion(view.state)))
const lines = computed(() => views.value.filter(view => !isSuggestion(view.state)))

// The label names what is still being read; the first wait shows only while nothing is there to show.
const pendingLabel = computed(() => {
  if (props.loading && props.reviewsLoading) return t('modelSettings.suggestions.loadingAll')
  if (props.loading) return t('modelSettings.suggestions.loading')
  return props.reviewsLoading ? t('modelSettings.suggestions.loadingTonborg') : ''
})
const waiting = computed(() => !ordered.value.length && ((props.loading && !props.entries) || (props.reviewsLoading && !props.reviews)))
// A read that failed with nothing of it shown says so; the same cause for both is said once.
const failure = computed(() => {
  const log = props.error && !props.entries ? props.error : ''
  const tonborg = props.reviewsError && !props.reviews ? props.reviewsError : ''
  if (log && log === tonborg) return `${t('modelSettings.suggestions.loadFailedAll')} ${log}`
  return [log && `${t('modelSettings.suggestions.loadFailed')} ${log}`,
    tonborg && `${t('modelSettings.suggestions.tonborgLoadFailed')} ${tonborg}`].filter(Boolean).join(' ')
})

async function toggleScoreCard(view: SuggestionView) {
  const entry = view.bole!
  const current = ++scoreCardRequest
  scoreCardError.value = ''
  if (opened.value === view.key) {
    opened.value = null
    return
  }
  opened.value = view.key
  if (scoreCards.value[view.key]) return
  scoreCardLoading.value = view.key
  try {
    const value = await readScoreCard(entry)
    if (current === scoreCardRequest) scoreCards.value = { ...scoreCards.value, [view.key]: value }
  } catch (cause) {
    if (current !== scoreCardRequest) return
    if (isKnowledgeRecoveryPending(cause)) { clearScoreCards(); emit('recoveryPending', cause) }
    else if (opened.value === view.key) scoreCardError.value = apiErrorReason(cause)
  } finally {
    if (current === scoreCardRequest) scoreCardLoading.value = null
  }
}
</script>

<template>
  <GrowthLoading v-if="waiting" variant="inline" :label="pendingLabel" />
  <section v-else-if="ordered.length" class="ui-section role-suggestions" aria-labelledby="role-suggestions-title" data-role-suggestions>
    <div class="ui-section-label">
      <h2 id="role-suggestions-title" class="list-title">{{ t('modelSettings.suggestions.title') }}</h2>
      <GrowthLoading v-if="pendingLabel" variant="inline" :label="pendingLabel" />
    </div>
    <p class="role-suggestions-note" data-role-suggestions-note>{{ t('modelSettings.suggestions.note') }}</p>
    <p v-if="failure" class="role-suggestions-error" role="alert">
      {{ failure }}
      <Button variant="outline" size="sm" @click="emit('retry')">{{ t('modelSettings.retry') }}</Button>
    </p>
    <ul v-if="cards.length" class="role-suggestions-list">
      <li v-for="view in cards" :key="view.key">
        <article class="role-suggestion" :class="{ 'role-suggestion-open shadow-md': opened === view.key }" :data-role-suggestion="view.role" :data-suggestion-state="view.state"
          :aria-labelledby="`role-suggestion-${view.key}`">
          <div class="role-suggestion-main">
            <header>
              <strong :id="`role-suggestion-${view.key}`">{{ roleName(view.role) }}</strong>
              <Badge :variant="TONES[view.state]" data-suggestion-status>{{ t(`modelSettings.suggestions.states.${view.state}`) }}</Badge>
            </header>
            <p class="role-suggestion-text" data-suggestion-text>
              <template v-if="view.bole">
                <AgentName :space-id="view.bole.personalSpaceId" :agent-id="view.bole.subject.agentId!" :name="agentName(view.bole)" /> ·
              </template>{{ view.text }}
            </p>
            <p v-if="view.reason" class="role-suggestion-reason">{{ view.reason }}</p>
            <dl>
              <div>
                <dt>{{ t('modelSettings.model') }}</dt>
                <dd :title="view.evidence.title"><code>{{ view.model ?? t('modelSettings.none') }}</code></dd>
              </div>
              <div>
                <dt>{{ t('modelSettings.suggestions.time') }}</dt>
                <dd><time :datetime="view.at">{{ view.time }}</time></dd>
              </div>
              <div v-if="view.evidence.dimensions.length" data-suggestion-evidence>
                <dt>{{ t('modelSettings.suggestions.evidence') }}</dt>
                <dd>{{ view.evidence.dimensions.join(' · ') }}</dd>
              </div>
              <div v-if="view.heldBy" data-suggestion-held>
                <dt>{{ t('modelSettings.suggestions.heldBy') }}</dt>
                <dd>{{ view.heldBy }}</dd>
              </div>
            </dl>
          </div>
          <footer v-if="view.action">
            <Button v-if="view.action.kind === 'link'" as-child size="sm" variant="outline">
              <RouterLink :to="view.action.to" data-suggestion-action>{{ view.action.label }}</RouterLink>
            </Button>
            <Button v-else size="sm" variant="outline" :aria-expanded="opened === view.key" data-suggestion-action @click="toggleScoreCard(view)">
              {{ opened === view.key ? t('modelSettings.suggestions.closeScoreCard') : view.action.label }}
            </Button>
          </footer>
          <div v-if="opened === view.key && view.bole" class="role-suggestion-detail">
            <GrowthLoading v-if="scoreCardLoading === view.key" variant="inline"
              :label="t('modelSettings.suggestions.scoreCardLoading', { name: agentName(view.bole) })" />
            <p v-else-if="scoreCardError" class="role-suggestion-failed" role="alert">{{ t('modelSettings.suggestions.scoreCardFailed') }} {{ scoreCardError }}</p>
            <dl v-else-if="scoreCards[view.key]" class="role-suggestion-score" data-suggestion-score-card>
              <div v-for="(dimension, name) in scoreCards[view.key]!.dimensions" :key="name">
                <dt>{{ t(`modelSettings.suggestions.dimensions.${name}`) }}</dt>
                <dd>{{ scoreValue(dimension) }}</dd>
              </div>
            </dl>
          </div>
        </article>
      </li>
    </ul>
    <ul v-if="lines.length" class="role-suggestions-list">
      <li v-for="view in lines" :key="view.key" class="role-suggestion-line"
        :data-role-suggestion="view.role" :data-suggestion-state="view.state">
        <strong>{{ roleName(view.role) }}</strong>
        <Badge :variant="TONES[view.state]" data-suggestion-status>{{ t(`modelSettings.suggestions.states.${view.state}`) }}</Badge>
        <span class="role-suggestion-why" data-suggestion-why>{{ view.why }}</span>
        <span class="role-suggestion-meta"><code :title="view.evidence.title">{{ view.model ?? t('modelSettings.none') }}</code> · {{ t('modelSettings.suggestions.time') }} <time :datetime="view.at">{{ view.time }}</time></span>
        <Button v-if="view.action?.kind === 'link'" as-child size="sm" variant="ghost">
          <RouterLink :to="view.action.to" data-suggestion-action>{{ view.action.label }}</RouterLink>
        </Button>
      </li>
    </ul>
    <Button v-if="!showAll && ordered.length > VISIBLE_SUGGESTIONS" class="justify-self-start" size="sm" variant="outline"
      data-suggestions-show-all @click="showAll = true">
      {{ t('modelSettings.suggestions.showAll', { count: ordered.length }) }}
    </Button>
  </section>
  <p v-else-if="failure" class="role-suggestions-error" role="alert">
    {{ failure }}
    <Button variant="outline" size="sm" @click="emit('retry')">{{ t('modelSettings.retry') }}</Button>
  </p>
</template>

<style scoped>
.role-suggestions { container-type: inline-size; }
.role-suggestions-note { margin: -4px 0 0; padding-inline: 4px; color: var(--color-muted); font-size: 13px; line-height: 1.6; }
/* One grouped list; a row whose score card is open lifts as a card. */
.role-suggestions-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-border);
  border-radius: var(--radius-card); background: var(--card); }
.role-suggestions-list > li { min-width: 0; border-radius: inherit; }
.role-suggestions-list > li + li { border-top: 1px solid var(--color-border); }
.role-suggestions-list > li:first-child { border-start-start-radius: inherit; border-start-end-radius: inherit; }
.role-suggestions-list > li:last-child { border-end-start-radius: inherit; border-end-end-radius: inherit; }
.role-suggestion-open { position: relative; z-index: 1; border-radius: var(--radius-card); outline: 1px solid var(--color-border-strong); background: var(--color-surface); }
.role-suggestion { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; min-width: 0; padding: 14px 16px; border-radius: inherit; transition: box-shadow var(--motion-fast); }
.role-suggestion-main { display: grid; gap: 6px; min-width: 0; }
.role-suggestion header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.role-suggestion header strong { font-size: 15px; font-weight: 600; }
.role-suggestion p { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.role-suggestion-reason { color: var(--color-muted); }
/* Model, time and evidence read as one quiet line of label-value pairs. */
.role-suggestion-main dl { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 0; font-size: 13px; }
.role-suggestion-main dl > div { display: flex; gap: 6px; min-width: 0; }
.role-suggestion dt { flex: none; color: var(--color-muted); }
.role-suggestion dd { margin: 0; overflow-wrap: anywhere; }
.role-suggestion code, .role-suggestion-line code { font-family: var(--font-mono); font-size: 12.5px; }
.role-suggestion footer { display: flex; align-self: start; flex-wrap: wrap; gap: 8px; }
.role-suggestion-detail { grid-column: 1 / -1; padding-top: 12px; border-top: 1px solid var(--color-border); }
.role-suggestion-score { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: 6px 20px; margin: 0; font-size: 14px; }
.role-suggestion-score div { display: contents; }
.role-suggestion-failed { color: var(--color-danger); }
.role-suggestion-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; padding: 10px 16px; font-size: 14px; }
.role-suggestion-why { flex: 1 1 16rem; min-width: 0; overflow-wrap: anywhere; }
.role-suggestion-meta { color: var(--color-muted); font-size: 12.5px; overflow-wrap: anywhere; }
/* A phone-width section: actions go under the text and are at least 44px tall to tap. */
@container (max-width: 619px) {
  .role-suggestion { grid-template-columns: minmax(0, 1fr); }
  [data-suggestion-action], [data-suggestions-show-all] { min-block-size: 44px; }
}
.role-suggestions-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; color: var(--color-danger); font-size: 14px; }
</style>
