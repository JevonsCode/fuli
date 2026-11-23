<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import ClientInitial from '@/features/today/ClientInitial.vue'
import { sourceApplication, sourceApplicationName } from '@/features/knowledge/source-adapters'
import { t } from '@/i18n'
import FlaSessionActions from './FlaSessionActions.vue'
import { modelReasonText, modelText, readWorkLocations, type WorkLocations, type WorkRow, type WorkSegment } from './work-locations'

// Widget 'fla-work-locations' (rec issue 147): where this FLA has worked — which
// clients, which models, how many segments of work each — and, per segment,
// the way back to the session that produced it.
//
// Self-contained: it reads its own data from the FLA's id alone, so a page can
// place it anywhere without wiring. An FLA with no recorded segment shows
// nothing at all.
const props = defineProps<{ spaceId: string; agentId: string; agentName?: string }>()
const SHOWN = 3

const located = ref<WorkLocations | null>(null)
const loading = ref(true)
const expanded = ref(false)
let controller: AbortController | null = null

async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  try {
    const result = await readWorkLocations(props.spaceId, props.agentId, current.signal)
    if (controller === current) located.value = result
  } catch (cause) {
    if (controller !== current || (cause instanceof DOMException && cause.name === 'AbortError')) return
    located.value = null
  } finally {
    if (controller === current) loading.value = false
  }
}
watch(() => [props.spaceId, props.agentId], () => { if (props.spaceId && props.agentId) void load() }, { immediate: true })
onBeforeUnmount(() => controller?.abort())

const rows = computed(() => located.value?.rows ?? [])
const segments = computed(() => located.value?.recent ?? [])
const clientOf = (row: { client: string }) => sourceApplication({ source_application: row.client })
const clientName = (row: { client: string }) =>
  row.client === 'other' ? t('flaPage.worked.otherClient') : sourceApplicationName(clientOf(row))
// `-` with its reason, never 0 and never a default model name.
const reason = (row: WorkRow | WorkSegment) => modelReasonText(row, clientName(row))
const counts = (row: WorkRow) => t('flaPage.worked.counts', { segments: row.segments, conversations: row.conversations })
const day = (value: string | null) => value ? new Date(value).toLocaleDateString() : ''
const segmentLine = (segment: WorkSegment) => [clientName(segment), modelText(segment), day(segment.when)]
  .filter(Boolean).join(' · ')
</script>

<template>
  <section v-if="loading || rows.length" class="worked" aria-labelledby="fla-worked-heading" data-widget="fla-work-locations">
    <h2 id="fla-worked-heading" class="worked-label">
      {{ t('flaPage.worked.title') }}
      <span v-if="located" class="ui-num">{{ t('flaPage.worked.total', { count: located.segments }) }}</span>
    </h2>
    <Card class="worked-card">
      <ul v-if="rows.length" class="worked-list">
        <li v-for="row in (expanded ? rows : rows.slice(0, SHOWN))" :key="`${row.client}:${row.model ?? ''}`" class="worked-row">
          <ClientInitial :client="clientOf(row)" :label="clientName(row)" />
          <div class="worked-main">
            <span class="worked-where">
              {{ clientName(row) }} · <span :class="{ 'worked-unreported': !row.model }">{{ modelText(row) }}</span>
              <span v-if="reason(row)" class="worked-reason">{{ reason(row) }}</span>
            </span>
            <span class="worked-counts">{{ counts(row) }}</span>
          </div>
        </li>
      </ul>
      <Button v-if="rows.length > SHOWN" size="sm" variant="link" class="worked-more" @click="expanded = !expanded">
        {{ expanded ? t('flaPage.worked.less') : t('flaPage.worked.more', { count: rows.length }) }}
      </Button>

      <template v-if="expanded && segments.length">
        <h3 class="worked-subhead">{{ t('flaPage.worked.recent') }}</h3>
        <ul class="worked-list" data-worked-segments>
          <li v-for="segment in segments" :key="`${segment.client}:${segment.session_id ?? segment.conversation_id}`" class="worked-segment">
            <div class="worked-main">
              <span class="worked-where">{{ segment.title || t('flaPage.worked.untitled') }}</span>
              <span class="worked-counts">{{ segmentLine(segment) }}</span>
            </div>
            <FlaSessionActions :client="segment.client" :session-id="segment.session_id" :client-name="clientName(segment)" />
          </li>
        </ul>
      </template>

      <p v-if="located?.partial" class="worked-hint">{{ t('flaPage.worked.partial', { count: located.conversations_read }) }}</p>
    </Card>
  </section>
</template>

<style scoped>
.worked { display: grid; gap: 12px; }
.worked-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.worked-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.worked-card { gap: 8px; padding: 12px 24px; }
.worked-subhead { margin: 4px 0 0; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.worked-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.worked-row, .worked-segment { display: flex; align-items: center; gap: 10px; min-height: var(--control-height); }
.worked-segment { justify-content: space-between; }
.worked-main { display: grid; min-width: 0; }
.worked-where { overflow: hidden; color: var(--color-ink); font-size: var(--text-body); text-overflow: ellipsis; white-space: nowrap; }
.worked-unreported { color: var(--color-muted); }
.worked-reason { margin-left: 6px; color: var(--color-faint); font-size: var(--text-meta); }
.worked-counts { color: var(--color-muted); font-size: var(--text-meta); }
.worked-hint { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.worked-more { justify-self: start; user-select: none; }
</style>
