<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import ClientInitial from '@/features/today/ClientInitial.vue'
import { sourceApplication, sourceApplicationName } from '@/features/knowledge/source-adapters'
import { t } from '@/i18n'
import FlaSessionActions from './FlaSessionActions.vue'
import { gapText, modelNote, modelText, useWorkLocations, whenText, type WorkRow, type WorkSegment } from './work-locations'

// Widget 'fla-work-locations' (rec issue 147): where this FLA has worked —
// which clients, which models, how many segments of work each. Click a row to
// see the segments it counts, each with the way back to its own session.
//
// Self-contained: it reads its own data from the FLA's id alone, so a page can
// place it anywhere without wiring. It shows nothing only when FULI read
// everything and found no work; a read that failed or stopped short says so.
const props = defineProps<{ spaceId: string; agentId: string; agentName?: string; projectName?: (id: string) => string }>()
const SHOWN = 3

const { located, state } = useWorkLocations(toRef(props, 'spaceId'), toRef(props, 'agentId'))
const showAll = ref(false)
const opened = ref<string | null>(null)

const rows = computed(() => located.value?.rows ?? [])
const gaps = computed(() => [...(located.value?.unavailable ?? []), ...(located.value?.truncated ?? [])])
const visible = computed(() => state.value === 'loading' || state.value === 'failed' || rows.value.length > 0 || gaps.value.length > 0)
const project = (id: string) => props.projectName?.(id) ?? id
const keyOf = (row: WorkRow) => `${row.client ?? ''}:${row.model ?? ''}`
const clientOf = (row: { client: string | null }) => sourceApplication({ source_application: row.client ?? 'other' })
const clientName = (row: { client: string | null }) =>
  !row.client || row.client === 'other' ? t('flaPage.worked.otherClient') : sourceApplicationName(clientOf(row))
const counts = (row: WorkRow) => t('flaPage.worked.counts', { segments: row.segments, conversations: row.conversations })
// The work statuses a checkpoint can report (task-entry-definitions.js); any
// other recorded value is shown as it is rather than dropped.
const STATUSES = new Set(['reported', 'completed', 'incomplete', 'failed', 'no_change'])
const status = (value: string | null) => !value ? '' : STATUSES.has(value) ? t(`flaPage.worked.status.${value}`) : value
const segmentLine = (segment: WorkSegment) => [segment.personal_project_id ? project(segment.personal_project_id) : '',
  whenText(segment.when), status(segment.status)].filter(Boolean).join(' · ')
const toggle = (row: WorkRow) => { opened.value = opened.value === keyOf(row) ? null : keyOf(row) }
</script>

<template>
  <section v-if="visible" class="worked" aria-labelledby="fla-worked-heading" data-widget="fla-work-locations">
    <h2 id="fla-worked-heading" class="worked-label">
      {{ t('flaPage.worked.title') }}
      <span v-if="located" class="ui-num">{{ t('flaPage.worked.total', { count: located.segments }) }}</span>
    </h2>
    <GrowthLoading v-if="state === 'loading'" variant="compact" :label="t('flaPage.worked.loading', { name: agentName ?? '' })" />
    <Card v-else class="worked-card">
      <p v-if="state === 'failed'" class="worked-hint" role="status" data-worked-failed>{{ t('flaPage.worked.failed') }}</p>
      <ul v-if="rows.length" class="worked-list">
        <li v-for="row in (showAll ? rows : rows.slice(0, SHOWN))" :key="keyOf(row)" class="worked-item">
          <Button variant="ghost" class="worked-row" :aria-expanded="opened === keyOf(row)" data-worked-row @click="toggle(row)">
            <ClientInitial :client="clientOf(row)" :label="clientName(row)" />
            <span class="worked-main">
              <span class="worked-where">
                {{ clientName(row) }} · <span :class="{ 'worked-unreported': !row.model }">{{ modelText(row) }}</span>
                <span v-if="modelNote(row)" class="worked-note">{{ modelNote(row) }}</span>
              </span>
              <span class="worked-counts">{{ counts(row) }}</span>
            </span>
          </Button>
          <ul v-if="opened === keyOf(row)" class="worked-segments" data-worked-segments>
            <li v-for="segment in row.recent" :key="`${segment.conversation_id}:${segment.session_id}`" class="worked-segment">
              <span class="worked-main">
                <span class="worked-where">{{ segment.title || t('flaPage.worked.untitled') }}</span>
                <span class="worked-counts">{{ segmentLine(segment) }}</span>
              </span>
              <FlaSessionActions :client="segment.client" :session-id="segment.session_id"
                :on-this-computer="segment.on_this_computer ?? null" />
            </li>
            <li v-if="row.recent_more" class="worked-hint">{{ t('flaPage.worked.moreSegments', { count: row.recent_more }) }}</li>
          </ul>
        </li>
      </ul>
      <Button v-if="rows.length > SHOWN" size="sm" variant="link" class="worked-more" @click="showAll = !showAll">
        {{ showAll ? t('flaPage.worked.less') : t('flaPage.worked.more', { count: rows.length }) }}
      </Button>
      <ul v-if="gaps.length" class="worked-gaps" role="status" data-worked-gaps>
        <li v-for="(gap, index) in gaps" :key="index">{{ gapText(gap, project) }}</li>
      </ul>
    </Card>
  </section>
</template>

<style scoped>
.worked { display: grid; gap: 12px; }
.worked-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.worked-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.worked-card { gap: 8px; padding: 12px 24px; }
.worked-list, .worked-segments, .worked-gaps { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.worked-row { justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-height: var(--control-height); padding: 2px 4px; text-align: left; }
.worked-row:hover .worked-where { text-decoration: underline; }
.worked-segments { margin: 2px 0 6px 34px; }
.worked-segment { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: var(--control-height); }
.worked-main { display: grid; min-width: 0; }
.worked-where { overflow: hidden; color: var(--color-ink); font-size: var(--text-body); text-overflow: ellipsis; white-space: nowrap; }
.worked-unreported { color: var(--color-muted); }
.worked-note { margin-left: 6px; color: var(--color-faint); font-size: var(--text-meta); }
.worked-counts, .worked-hint, .worked-gaps { color: var(--color-muted); font-size: var(--text-meta); }
.worked-hint { margin: 0; }
.worked-more { justify-self: start; user-select: none; }
</style>
