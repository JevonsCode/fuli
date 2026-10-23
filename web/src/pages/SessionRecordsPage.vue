<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { focusReturnTarget } from '@/composables/useFocusReturn'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { useRoutePeek } from '@/composables/useRoutePeek'
import KnowledgeHardDeletedNotice from '@/features/knowledge-hard-delete/KnowledgeHardDeletedNotice.vue'
import type { HardDeletedState } from '@/features/knowledge-hard-delete/model'
import KnowledgeHardDeleteSection from '@/features/knowledge-hard-delete/KnowledgeHardDeleteSection.vue'
import { sessionDeleteTarget, type SourceDeleteTarget } from '@/features/knowledge-hard-delete/source-delete-model'
import SessionRecordPeek from '@/features/session-records/SessionRecordPeek.vue'
import {
  SESSION_GROUPS, clockTime, entryTypeLabel, groupEntries, peekEntry, projectLabel, stretchLabel,
  transcriptRows,
  type SessionEntry, type SessionRecordsView,
} from '@/features/session-records/model'
import { readSessionRecords } from '@/features/session-records/session-records-api'
import { sessionMigrationOffers } from '@/features/session-migration/model'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// 本会话记了什么 (rec#5 C6): everything one host session recorded, in the
// three groups the host numbered, on one canvas. A record opens in a quick
// look kept in the URL (?item=<space>/<key>), so the receipt's link, an
// Agent's answer and a knowledge source's "来自哪个会话" open the same record.
const route = useRoute()
const store = useConsoleStore()
// The receipt's link names only the session: it is read in the active space.
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const requestedClient = computed(() => String(route.query.client ?? ''))
const sessionId = computed(() => String(route.params.sessionId ?? ''))
const client = computed(() => view.value?.session.sourceApplication ?? requestedClient.value)

const view = ref<SessionRecordsView | null>(null)
const sourceDeletion = ref<{ target: SourceDeleteTarget; state: HardDeletedState } | null>(null)
const loading = ref(false)
const error = ref('')
const root = ref<HTMLElement | null>(null)
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !view.value))
let requestVersion = 0

const peek = useRoutePeek()
const peekKey = computed(() => {
  const requested = peek.item.value
  return requested && requested.spaceId === spaceId.value ? requested.id : ''
})
const opened = computed(() => peekEntry(view.value, peekKey.value))
let lastOpened = ''
watch(opened, entry => { if (entry) lastOpened = entry.key })

// rec#20 part 2: while the session holds undecided items, an offer to move
// them into each formal project its turns worked in.
const sessionTarget = computed(() => view.value ? sessionDeleteTarget(view.value.session) : null)
const migrationOffers = computed(() => sessionMigrationOffers(view.value))
const shortSession = computed(() => sessionId.value.length > 12 ? `${sessionId.value.slice(0, 8)}…` : sessionId.value)

async function load() {
  const current = ++requestVersion
  loading.value = true
  error.value = ''
  try {
    const value = await readSessionRecords(spaceId.value, sessionId.value, requestedClient.value)
    if (current === requestVersion) view.value = value
  } catch (cause) {
    if (current === requestVersion) error.value = (cause as Error).message
  } finally {
    if (current === requestVersion) loading.value = false
  }
}

function sourceRemoved(target: SourceDeleteTarget, state: HardDeletedState) {
  ++requestVersion
  loading.value = false
  view.value = null
  sourceDeletion.value = { target, state }
  void peek.close()
}
function reloadAfterSource() {
  sourceDeletion.value = null
  void load()
}

function open(entry: SessionEntry | string) {
  return peek.open({ spaceId: spaceId.value, id: typeof entry === 'string' ? entry : entry.key })
}

function returnFocus(event: Event) {
  event.preventDefault()
  focusReturnTarget(root.value, lastOpened)
}

// Opening focuses the dialog itself, so a keyboard reader starts at the top.
function focusDialog(event: Event) {
  event.preventDefault()
  ;(event.target as HTMLElement | null)?.focus({ preventScroll: true })
}

function peekOpenChange(value: boolean) {
  if (!value) void peek.close()
}

// A link straight to a record brings its row into view behind the quick look.
watch([opened, view], async ([entry]) => {
  if (!entry) return
  await nextTick()
  root.value?.querySelector(`[data-return-focus="${entry.key.replace(/["\\]/g, '\\$&')}"]`)?.scrollIntoView?.({ block: 'nearest' })
})

watch([spaceId, requestedClient, sessionId], () => {
  sourceDeletion.value = null
  view.value = null
  if (spaceId.value) void load()
}, { immediate: true })
</script>

<template>
  <section class="view [scrollbar-gutter:stable]">
    <div ref="root" class="@container mx-auto flex w-full max-w-(--canvas-max) flex-col gap-6" data-session-records>
      <GrowthLoading v-if="showLoading" :label="t('sessionRecords.loading')" />
      <section v-else-if="sourceDeletion" class="grid gap-3" data-source-deleted-page>
        <KnowledgeHardDeletedNotice :state="sourceDeletion.state" :space-id="spaceId" :item-kind="sourceDeletion.target.item_kind" :item-id="sourceDeletion.target.item_id"
          @changed="sourceRemoved(sourceDeletion!.target, $event)" @present="reloadAfterSource" />
        <Button v-if="sourceDeletion.state.outcome === 'complete' || sourceDeletion.state.outcome === 'gone'" variant="outline" @click="reloadAfterSource">{{ t('knowledgeHardDelete.source.reload') }}</Button>
      </section>
      <div v-else-if="error && !view" role="alert" class="ui-empty grid justify-items-start gap-2 rounded-lg border bg-card">
        <p class="m-0 text-destructive [overflow-wrap:anywhere]">{{ t('sessionRecords.loadFailed', { error }) }}</p>
        <Button variant="outline" size="sm" @click="load">{{ t('sessionRecords.retry') }}</Button>
      </div>
      <template v-else-if="view">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p class="page-lede m-0 min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]" :title="sessionId">
            {{ t('sessionRecords.lede', { client, session: shortSession }) }}
          </p>
          <Badge variant="secondary" data-session-total>{{ t('sessionRecords.total', { count: view.total }) }}</Badge>
          <GrowthLoading v-if="loading" variant="inline" :label="t('sessionRecords.loading')" />
        </div>
        <p v-if="error" role="alert" class="m-0 text-sm text-destructive">{{ t('sessionRecords.loadFailed', { error }) }}</p>
        <div v-if="migrationOffers.length" class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-4 py-3"
          data-session-migration-offer>
          <p class="m-0 min-w-0 flex-[1_1_16rem] text-sm">{{ t('sessionMigration.offer') }}</p>
          <span class="flex flex-wrap gap-2">
            <Button v-for="offer in migrationOffers" :key="offer.project.id" size="sm" as-child>
              <RouterLink :to="offer.path">{{ t('sessionMigration.offerAction', { project: projectLabel(offer.project) }) }}</RouterLink>
            </Button>
          </span>
        </div>
        <div v-if="view.clients?.length" class="ui-empty grid justify-items-start gap-2 rounded-lg border bg-card" data-session-clients>
          <p class="m-0 text-sm">{{ t('sessionRecords.chooseClient') }}</p>
          <div class="flex flex-wrap gap-2">
            <Button v-for="name in view.clients" :key="name" variant="outline" size="sm" as-child>
              <RouterLink :to="{ query: { ...route.query, client: name } }">{{ name }}</RouterLink>
            </Button>
          </div>
        </div>
        <p v-if="view.truncated" class="m-0 text-sm text-muted-foreground" data-session-truncated>{{ t('sessionRecords.truncated') }}</p>
        <p v-if="!view.total && !view.stretches.length && !view.clients?.length" class="ui-empty m-0 rounded-lg border border-dashed bg-card" data-session-empty>
          {{ t('sessionRecords.empty') }}
        </p>

        <section v-for="group in view.clients?.length ? [] : SESSION_GROUPS" :key="group" class="grid gap-3" :data-session-group="group"
          :aria-labelledby="`session-group-${group}`">
          <h2 :id="`session-group-${group}`" class="m-0 flex items-baseline gap-2 text-base font-semibold">
            {{ t(`sessionRecords.groups.${group}`) }}
            <span class="text-sm font-normal text-muted-foreground">{{ groupEntries(view, group).length }}</span>
          </h2>
          <ol v-if="group === 'transcript' ? transcriptRows(view).length : groupEntries(view, group).length"
            class="m-0 grid list-none grid-cols-1 p-0"
            :class="group === 'transcript' ? 'gap-2' : 'gap-3 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[1400px]:grid-cols-4'">
            <template v-for="row in group === 'transcript' ? transcriptRows(view) : groupEntries(view, group).map(entry => ({ kind: 'entry' as const, entry }))"
              :key="row.kind === 'entry' ? row.entry.key : `stretch:${row.stretch.from}`">
              <li v-if="row.kind === 'stretch'" class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-dashed px-4 py-3 text-sm"
                data-session-stretch>
                <span class="font-medium">{{ stretchLabel(row.stretch) }}</span>
                <span class="text-muted-foreground">{{ t('sessionRecords.stretch.empty') }}</span>
              </li>
              <li v-else class="min-w-0">
                <article class="flex h-full min-w-0 flex-col rounded-lg border bg-card transition-[border-color,box-shadow] hover:border-border-strong"
                  :class="{ 'border-border-strong shadow-md': opened?.key === row.entry.key }"
                  :data-session-entry="row.entry.key" :data-return-focus="row.entry.key">
                  <!-- A saved turn is one compact row; knowledge and evidence are cards. -->
                  <Button v-if="group === 'transcript'" variant="ghost" aria-haspopup="dialog"
                    class="h-auto w-full min-w-0 flex-wrap items-baseline justify-start gap-x-3 gap-y-1 rounded-lg px-4 py-3 text-left text-sm font-normal whitespace-normal"
                    :aria-label="t('sessionRecords.open', { number: row.entry.number })" @click="open(row.entry)">
                    <span class="font-semibold tabular-nums">#{{ row.entry.number }}</span>
                    <span class="tabular-nums text-muted-foreground">{{ clockTime(row.entry.at) }}</span>
                    <span class="min-w-0 flex-[1_1_16rem] truncate">{{ row.entry.summary }}</span>
                    <span class="text-xs text-muted-foreground [overflow-wrap:anywhere]">{{ projectLabel(row.entry.project) }}</span>
                  </Button>
                  <Button v-else variant="ghost" aria-haspopup="dialog"
                    class="h-full w-full min-w-0 flex-col items-stretch justify-start gap-2 rounded-lg p-4 text-left font-normal whitespace-normal"
                    :aria-label="t('sessionRecords.open', { number: row.entry.number })" @click="open(row.entry)">
                    <span class="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                      <span class="font-semibold tabular-nums">#{{ row.entry.number }}</span>
                      <span class="font-medium">{{ entryTypeLabel(row.entry) }}</span>
                      <Badge v-if="row.entry.status" :variant="row.entry.status === 'pending' ? 'warning' : 'success'">
                        {{ t(`knowledgeQuickEdit.confirmation.${row.entry.status}`) }}
                      </Badge>
                    </span>
                    <span class="line-clamp-2 text-sm leading-relaxed [overflow-wrap:anywhere]">{{ row.entry.summary }}</span>
                    <span class="mt-auto flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
                      <span class="tabular-nums">{{ clockTime(row.entry.at) }}</span>
                      <span aria-hidden="true">·</span>
                      <span class="min-w-0 [overflow-wrap:anywhere]">{{ projectLabel(row.entry.project) }}</span>
                    </span>
                  </Button>
                </article>
              </li>
            </template>
          </ol>
          <p v-else class="m-0 text-sm text-muted-foreground">{{ t(`sessionRecords.groupEmpty.${group}`) }}</p>
        </section>
        <KnowledgeHardDeleteSection v-if="sessionTarget" :space-id="spaceId" :item="sessionTarget" @deleted="sourceRemoved(sessionTarget!, $event)" />
      </template>
    </div>

    <Dialog :open="Boolean(view && peekKey && !view.clients?.length)" @update:open="peekOpenChange">
      <DialogContent v-if="view && peekKey && !view.clients?.length" size="lg" data-session-peek @open-auto-focus="focusDialog" @close-auto-focus="returnFocus">
        <SessionRecordPeek :entry="opened" :view="view" :space-id="spaceId" @open="open" @close="peek.close()" @source-deleted="sourceRemoved" />
      </DialogContent>
    </Dialog>
  </section>
</template>
