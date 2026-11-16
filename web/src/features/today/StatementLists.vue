<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { readHabitRows } from '@/features/habit-delivery/habit-delivery-api'
import type { HabitRow } from '@/features/habit-delivery/model'
import { itemEditPath, scopeLabel } from '@/features/knowledge-quick-edit/model'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { useConsoleStore } from '@/stores/console'
import UiDialog from '@/ui/UiDialog.vue'
import UiIcon from '@/ui/UiIcon.vue'
import UiNotice from '@/ui/UiNotice.vue'
import UiSegmented from '@/ui/UiSegmented.vue'
import ClientInitial from './ClientInitial.vue'
import { statementWeek, weekRangeLabel, type StatementWeek } from './statement'
import { carriedRows, firstLearnedList, readCarriedTasks, readLearnedItems, type CarriedRow, type LearnedItems, type LearnedList } from './statement-lists'

// What a statement tile counts, row by row: the conversations that carried
// habits (each opens the habits it was handed), or the items newly learned
// and the ones the person confirmed (each opens its own page). `week` is the
// week the tile's number was read for, so the rows are that number's own
// (null: this week). `list` null: closed. Each opening reads again; a tab's
// items are read when it is first shown, a few at a time, and kept while the
// dialog stays open.
const props = defineProps<{ list: 'carried' | 'learned' | null; week: StatementWeek | null }>()
// How many item views one request round reads.
const ITEM_BATCH = 10
defineEmits<{ close: [] }>()
const spaceId = computed(() => useConsoleStore().activePersonalSpace?.id ?? '')
const carried = ref<{ rows: CarriedRow[]; more: boolean } | null>(null)
const learned = ref<LearnedItems | null>(null)
const tab = ref<LearnedList>('captured')
const items = ref<Partial<Record<LearnedList, HabitRow[]>>>({})
// What is being read now, named for the reading mark; null when nothing is.
const reading = ref<'carried' | 'learned' | LearnedList | null>(null)
const error = ref('')
let readId = 0

const week = computed(() => props.week ?? statementWeek(new Date()))
const title = computed(() => t(`today.lists.${props.list ?? 'carried'}.title`))
const tabs = computed(() => (['captured', 'confirmedByYou'] as const).map(value => ({
  value, label: t(`today.lists.learned.${value}`), count: learned.value?.[value].total,
})))
const shown = computed(() => items.value[tab.value] ?? null)
const total = computed(() => learned.value?.[tab.value].total ?? 0)
const time = (value: string) => formatDateTime(value, currentLocale(),
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, { missing: '', invalid: '' })

async function read() {
  const current = ++readId
  const list = props.list
  if (!list) return
  error.value = ''
  reading.value = list
  try {
    if (list === 'carried') {
      const value = await readCarriedTasks(week.value)
      if (current === readId) carried.value = { rows: carriedRows(value), more: value.more }
    } else {
      const value = await readLearnedItems(week.value)
      if (current !== readId) return
      learned.value = value
      tab.value = firstLearnedList(value)
      await readItems(current)
    }
  } catch (cause) {
    if (current === readId) error.value = (cause as Error).message
  } finally {
    if (current === readId) reading.value = null
  }
}

async function readItems(current: number) {
  const list = tab.value
  if (!learned.value || items.value[list]) return
  reading.value = list
  const listed = learned.value[list].items
  const rows: HabitRow[] = []
  for (let start = 0; start < listed.length && current === readId; start += ITEM_BATCH) {
    rows.push(...await readHabitRows(spaceId.value, { items: listed.slice(start, start + ITEM_BATCH) }))
  }
  if (current === readId) items.value = { ...items.value, [list]: rows }
}

// 重试 reads what failed: a tab's items when the lists are there, else the list itself.
const retry = () => (props.list === 'learned' && learned.value ? choose(tab.value) : read())

async function choose(next: LearnedList) {
  tab.value = next
  const current = ++readId
  error.value = ''
  try {
    await readItems(current)
  } catch (cause) {
    if (current === readId) error.value = (cause as Error).message
  } finally {
    if (current === readId) reading.value = null
  }
}

watch(() => props.list, () => {
  carried.value = null
  learned.value = null
  items.value = {}
  void read()
}, { immediate: true })
</script>

<template>
  <UiDialog :open="list !== null" :title="title" :description="weekRangeLabel(week)" size="md" @close="$emit('close')">
    <div class="statement-list" :data-statement-list="list">
      <UiSegmented v-if="list === 'learned' && learned" :model-value="tab" :options="tabs" :label="t('today.lists.learned.which')" size="sm"
        @update:model-value="choose" />
      <GrowthLoading v-if="reading" variant="compact" :label="t(`today.lists.loading.${reading}`)" />
      <UiNotice v-else-if="error" tone="error">
        {{ t('today.lists.failed', { error }) }}
        <template #actions><Button variant="outline" size="sm" @click="retry">{{ t('common.actions.retry') }}</Button></template>
      </UiNotice>
      <template v-else-if="list === 'carried' && carried">
        <p v-if="!carried.rows.length" class="statement-list-note">{{ t('today.lists.carried.none') }}</p>
        <ul v-else class="statement-list-rows" role="list">
          <li v-for="row in carried.rows" :key="row.id" :data-statement-carried="row.id">
            <component :is="row.to ? RouterLink : 'div'" :to="row.to ?? undefined" class="statement-list-row" :class="{ 'is-link': row.to }">
              <ClientInitial v-if="row.client" :client="row.client" :label="row.clientName" />
              <span v-else class="statement-list-blank" aria-hidden="true" />
              <span class="statement-list-text">
                <span class="statement-list-main">{{ row.clientName }} · {{ time(row.at) }}</span>
                <span class="statement-list-meta">{{ [row.carried, row.model].filter(Boolean).join(' · ') }}</span>
              </span>
              <UiIcon v-if="row.to" name="chevron-right" :size="16" class="statement-list-go" />
            </component>
          </li>
        </ul>
        <p v-if="carried.more" class="statement-list-note" data-statement-list-more>{{ t('today.lists.carried.more', { count: carried.rows.length }) }}</p>
      </template>
      <template v-else-if="list === 'learned' && shown">
        <p v-if="!shown.length" class="statement-list-note">{{ t(`today.lists.learned.none.${tab}`) }}</p>
        <ul v-else class="statement-list-rows" role="list">
          <li v-for="row in shown" :key="`${row.kind}:${row.id}`" :data-statement-learned="row.id">
            <p v-if="row.deleted" class="statement-list-row statement-list-meta">{{ t('habitDelivery.deleted') }}</p>
            <RouterLink v-else :to="itemEditPath(spaceId, row.item)" class="statement-list-row is-link" :title="row.item.content || row.item.title">
              <span class="statement-list-text">
                <span class="statement-list-main is-item">{{ row.item.content || row.item.title }}</span>
                <span class="statement-list-meta">{{ scopeLabel(row.item.scope) }}</span>
              </span>
              <UiIcon name="chevron-right" :size="16" class="statement-list-go" />
            </RouterLink>
          </li>
        </ul>
        <p v-if="total > shown.length" class="statement-list-note" data-statement-list-more>{{ t('today.lists.learned.more', { count: shown.length, total }) }}</p>
      </template>
    </div>
  </UiDialog>
</template>

<style scoped>
.statement-list { display: grid; gap: 12px; justify-items: start; }
.statement-list > * { max-width: 100%; }
.statement-list-rows { display: grid; width: 100%; margin: 0; padding: 0; list-style: none; }
.statement-list-rows li + li { border-top: 1px solid var(--color-border); }
/* One row: the client's mark (or its empty place), two lines of text, and the arrow of a row that opens something. */
.statement-list-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 10px; margin: 0 -8px; padding: 8px; border-radius: var(--radius-control); color: inherit; text-decoration: none; }
.statement-list-row.is-link { user-select: none; transition: background var(--motion-fast); }
.statement-list-row.is-link:hover { background: var(--color-surface-subtle); }
.statement-list-blank { width: 18px; }
.statement-list-text { display: grid; grid-column: 2; gap: 2px; min-width: 0; }
.statement-list-main { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
/* An item's own words may take two lines. */
.statement-list-main.is-item { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; white-space: normal; }
.statement-list-meta { color: var(--color-muted); font-size: var(--text-meta); }
.statement-list-go { grid-column: 3; color: var(--color-muted); }
.statement-list-note { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
</style>
