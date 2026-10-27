<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import TextField from '@/components/TextField.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { focusReturnTarget, useFocusReturn } from '@/composables/useFocusReturn'
import { useRoutePeek } from '@/composables/useRoutePeek'
import OccupationPeek from '@/features/occupations/OccupationPeek.vue'
import {
  occupationDescription, occupationName, useOccupationCatalog, type OccupationEntry,
} from '@/features/occupations/occupation-catalog'
import { occupationPeekState } from '@/features/occupations/occupation-peek'
import {
  DEFAULT_OCCUPATION_SORT, nextOccupationSort, OCCUPATION_FILTERS, OCCUPATION_SORT_KEYS, occupationCounts, visibleOccupations,
  type OccupationFilter, type OccupationSort, type OccupationSortKey,
} from '@/features/occupations/occupation-table'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { useConsoleStore } from '@/stores/console'
import { UiDialog, UiIcon, UiStatRow, type UiStat } from '@/ui'

// 职业: the space's occupation table, read from the graph and seeded with the
// built-in rows. Only active (在用) rows show until the status filter asks for
// archived ones. A name opens its quick look (?item=<space>/<key>), which a
// refresh or a shared link reopens. Built-in occupations can be archived and
// restored, never deleted; custom ones need their duties.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const catalog = useOccupationCatalog(spaceId)
const filter = ref<OccupationFilter>('active')
const query = ref('')
const sort = ref<OccupationSort>(DEFAULT_OCCUPATION_SORT)
type QuickChange = 'archive' | 'restore' | 'remove'
const busy = ref<{ key: string; action: QuickChange } | null>(null)
const actionError = ref('')
// The last archive, said in one line with its undo: the row leaves the active view.
const archivedNow = ref<OccupationEntry | null>(null)

const entries = computed(() => catalog.entries.value)
const counts = computed(() => occupationCounts(entries.value))
const FILTER_TERMS: Partial<Record<OccupationFilter, string>> = { active: 'occupation.active', archived: 'occupation.archived' }
const stats = computed<UiStat[]>(() => OCCUPATION_FILTERS.map(key => ({
  key, label: t(`occupations.stats.${key}`), value: counts.value[key], pressed: filter.value === key,
  tone: key === 'active' ? 'success' : key === 'custom' ? 'accent' : 'neutral', term: FILTER_TERMS[key],
})))
const visible = computed(() => visibleOccupations(entries.value, { filter: filter.value, query: query.value, sort: sort.value }))
const ariaSort = (key: OccupationSortKey) => (sort.value.key === key ? (sort.value.direction === 'asc' ? 'ascending' : 'descending') : 'none')
const updated = (entry: OccupationEntry) => formatDateTime(entry.updated_at, currentLocale(), DATE_TIME_MINUTE, { missing: '' })
// A failed first read says so in place of the cards; a failed refresh keeps them.
const firstReadFailed = computed(() => Boolean(catalog.error.value) && !catalog.loaded.value)

// Create and edit share one dialog.
const editing = ref<OccupationEntry | null>(null)
const dialogOpen = ref(false)
const name = ref('')
const duties = ref('')
const saving = ref(false)
const dialogError = ref('')
function openDialog(entry: OccupationEntry | null) {
  editing.value = entry
  name.value = entry ? occupationName(entry) : ''
  duties.value = entry ? occupationDescription(entry) : ''
  dialogError.value = ''
  dialogOpen.value = true
}
async function save() {
  if (!name.value.trim()) { dialogError.value = t('occupations.dialog.nameRequired'); return }
  if (duties.value.trim().length < 8) { dialogError.value = t('occupations.dialog.tooShort'); return }
  saving.value = true
  dialogError.value = ''
  try {
    const draft = { name: name.value, description: duties.value }
    if (editing.value) await catalog.update(editing.value, draft)
    else await catalog.create(draft)
    dialogOpen.value = false
  } catch (cause) {
    dialogError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
async function act(entry: OccupationEntry, action: QuickChange) {
  busy.value = { key: entry.key, action }
  actionError.value = ''
  archivedNow.value = null
  try {
    await catalog[action](entry)
    if (action === 'archive') archivedNow.value = catalog.entries.value.find(item => item.key === entry.key) ?? null
    // A deleted occupation has nothing left to look at.
    if (action === 'remove' && peek.item.value?.id === entry.key) void peek.close()
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause)
  } finally { busy.value = null }
}
const busyOn = (entry: OccupationEntry) => (busy.value?.key === entry.key ? busy.value.action : '')

// The quick look: the exact key from the URL, looked up in this space's whole catalog.
const grid = ref<HTMLElement | null>(null)
const peek = useRoutePeek()
const peekState = computed(() => peek.item.value && occupationPeekState({
  item: peek.item.value, spaceId: spaceId.value, entries: entries.value,
  loaded: catalog.loaded.value, loading: catalog.loading.value, error: catalog.error.value,
}))
const peekKey = computed(() => (peekState.value?.kind === 'ready' ? peekState.value.entry.key : ''))
const focusReturn = useFocusReturn(grid, 'occupations', computed(() => visible.value.length > 0))
let peekOpener: HTMLElement | null = null
let lastPeekKey = ''
// While the quick look hands over to the edit dialog, that dialog keeps focus.
let handingOver = false
function openPeek(entry: OccupationEntry) {
  const active = document.activeElement
  peekOpener = active instanceof HTMLElement && active !== document.body ? active : null
  void peek.open({ spaceId: spaceId.value, id: entry.key })
}
function peekOpenChange(open: boolean) { if (!open) void peek.close() }
function returnFocusFromPeek(event: Event) {
  event.preventDefault()
  const opener = peekOpener
  peekOpener = null
  if (handingOver) { handingOver = false; return }
  if (opener?.isConnected) opener.focus({ preventScroll: true })
  else focusReturnTarget(grid.value, lastPeekKey)
}
function handOver(entry: OccupationEntry) {
  handingOver = true
  void peek.close()
  openDialog(entry)
}
function retryRead() { void catalog.load({ force: true }) }
// A shared link scrolls its card into view once, after the card is on the page.
let scrolledFor = ''
watch(peekKey, async (key) => {
  if (!key) { if (!peek.item.value) scrolledFor = ''; return }
  lastPeekKey = key
  focusReturn.remember(key)
  if (scrolledFor === key) return
  scrolledFor = key
  await nextTick()
  grid.value?.querySelector(`[data-return-focus="${key.replace(/["\\]/g, '\\$&')}"]`)?.scrollIntoView?.({ block: 'nearest' })
}, { immediate: true })
</script>

<template>
  <section class="view occupations-view">
    <div class="@container mx-auto flex w-full max-w-(--layout-max) flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
        <UiStatRow :items="stats" :label="t('occupations.statsAria')" data-occupation-status-filter @select="key => filter = key as OccupationFilter" />
        <p class="page-lede m-0 text-sm text-muted-foreground" data-term="occupation.catalog">{{ t('occupations.lede') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="occupations-search">
          <span class="ui-sr-only">{{ t('occupations.search') }}</span>
          <input v-model="query" type="search" :placeholder="t('occupations.search')" />
        </label>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <GrowthLoading v-if="catalog.loading.value && entries.length" variant="inline" :label="t('occupations.loading')" />
          <Button size="sm" data-occupation-new @click="openDialog(null)">{{ t('occupations.new') }}</Button>
        </div>
      </div>
      <p v-if="archivedNow && !peek.item.value" class="m-0 flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="status" data-occupation-archived-notice>
        {{ t('occupations.archivedNotice', { name: occupationName(archivedNow) }) }}
        <Button size="sm" variant="outline" :loading="busyOn(archivedNow) === 'restore'" :loading-label="t('occupations.restoring')"
          data-term="occupation.archived" data-occupation-undo-archive @click="act(archivedNow, 'restore')">{{ t('occupations.restore') }}</Button>
      </p>
      <p v-if="actionError && !peek.item.value" class="m-0 text-sm text-destructive" role="alert">{{ actionError }}</p>
      <p v-if="catalog.error.value && !firstReadFailed" class="m-0 text-sm text-destructive" role="alert">
        {{ catalog.error.value }} <Button size="sm" variant="ghost" @click="retryRead">{{ t('occupations.retry') }}</Button>
      </p>

      <div ref="grid">
        <GrowthLoading v-if="catalog.loading.value && !entries.length" variant="compact" :label="t('occupations.loading')" />
        <div v-else-if="firstReadFailed" class="ui-empty rounded-lg border bg-card text-destructive" role="alert" data-occupations-load-error>
          <p class="m-0 text-destructive [overflow-wrap:anywhere]">{{ catalog.error.value }}</p>
          <Button class="mt-3" size="sm" variant="outline" @click="retryRead">{{ t('occupations.retry') }}</Button>
        </div>
        <p v-else-if="!visible.length" class="ui-empty m-0 rounded-lg border border-dashed bg-card" data-occupations-empty>{{ t('occupations.empty') }}</p>
        <Table v-else class="occupations-table min-w-[820px]" container-class="rounded-lg border bg-card">
          <TableHeader class="sticky top-0 z-[1] bg-card shadow-[0_1px_0_var(--border)] [&_tr]:border-b-0">
            <TableRow class="hover:bg-transparent">
              <TableHead v-for="key in OCCUPATION_SORT_KEYS" :key="key" :aria-sort="ariaSort(key)"
                :class="{ 'pl-4': key === 'name', 'text-right': key === 'agents' }"
                :data-term="key === 'agents' ? 'occupation.agentCount' : undefined" :data-occupation-column="key">
                <Button variant="ghost" size="sm" class="occupations-sort -mx-2 h-auto min-h-0 gap-1 px-2 py-1 text-xs font-semibold"
                  :class="{ 'is-sorted': sort.key === key }" @click="sort = nextOccupationSort(sort, key)">
                  {{ t(`occupations.columns.${key}`) }}
                  <UiIcon v-if="sort.key === key" :name="sort.direction === 'asc' ? 'chevron-up' : 'chevron-down'" :size="14" />
                </Button>
              </TableHead>
              <TableHead class="pr-4 text-right"><span class="sr-only">{{ t('occupations.columns.actions') }}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="entry in visible" :key="entry.key" class="occupation-row"
              :class="{ 'is-archived': entry.status === 'archived', 'is-selected': peekKey === entry.key }"
              :data-state="peekKey === entry.key ? 'selected' : undefined"
              :data-occupation-row="entry.key" :data-return-focus="entry.key">
              <TableCell class="min-w-[180px] pl-4">
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Button variant="link" class="occupation-name h-auto min-h-0 justify-start p-0 text-left text-sm font-semibold whitespace-normal text-foreground underline-offset-4 hover:text-primary hover:underline"
                    aria-haspopup="dialog" data-occupation-open @click="openPeek(entry)">
                    <span class="[overflow-wrap:anywhere]">{{ occupationName(entry) }}</span>
                  </Button>
                  <Badge :variant="entry.builtin ? 'secondary' : 'outline'" :data-occupation-kind="entry.builtin ? 'builtin' : 'custom'">
                    {{ t(entry.builtin ? 'occupations.builtin' : 'occupations.stats.custom') }}
                  </Badge>
                </div>
              </TableCell>
              <TableCell class="occupation-duties max-w-[420px] text-muted-foreground">
                <span class="line-clamp-2 [overflow-wrap:anywhere]">{{ occupationDescription(entry) || t('occupations.noDescription') }}</span>
              </TableCell>
              <TableCell class="text-right tabular-nums" data-occupation-agents>{{ entry.agent_count }}</TableCell>
              <TableCell class="whitespace-nowrap">
                <Badge :variant="entry.status === 'active' ? 'success' : 'warning'">{{ t(`occupations.stats.${entry.status}`) }}</Badge>
              </TableCell>
              <TableCell class="whitespace-nowrap tabular-nums text-muted-foreground">{{ updated(entry) }}</TableCell>
              <TableCell class="pr-4">
                <div class="flex flex-nowrap items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" :disabled="Boolean(busyOn(entry))" data-occupation-edit @click="openDialog(entry)">{{ t('occupations.edit') }}</Button>
                  <Button v-if="entry.status === 'active'" variant="ghost" size="sm" :disabled="Boolean(busyOn(entry))" :loading="busyOn(entry) === 'archive'"
                    :loading-label="t('occupations.archiving')" :title="t('occupations.archiveHint')" data-term="occupation.archived"
                    data-occupation-archive @click="act(entry, 'archive')">{{ t('occupations.archive') }}</Button>
                  <Button v-else variant="ghost" size="sm" :disabled="Boolean(busyOn(entry))" :loading="busyOn(entry) === 'restore'"
                    :loading-label="t('occupations.restoring')" data-term="occupation.archived"
                    data-occupation-restore @click="act(entry, 'restore')">{{ t('occupations.restore') }}</Button>
                  <Button v-if="!entry.builtin" variant="ghost" size="sm" class="text-destructive" :disabled="Boolean(busyOn(entry)) || entry.agent_count > 0"
                    :loading="busyOn(entry) === 'remove'" :loading-label="t('occupations.removing')"
                    :title="entry.agent_count > 0 ? t('occupations.inUse') : undefined" data-occupation-remove @click="act(entry, 'remove')">
                    {{ t('occupations.remove') }}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>

    <Dialog :open="Boolean(peekState)" @update:open="peekOpenChange">
      <DialogContent v-if="peekState" data-occupation-peek @close-auto-focus="returnFocusFromPeek">
        <OccupationPeek :state="peekState" :busy="busy && busy.key === peekKey ? busy.action : ''" :action-error="actionError"
          @edit="peekState.kind === 'ready' && handOver(peekState.entry)"
          @archive="peekState.kind === 'ready' && act(peekState.entry, 'archive')"
          @restore="peekState.kind === 'ready' && act(peekState.entry, 'restore')"
          @remove="peekState.kind === 'ready' && act(peekState.entry, 'remove')"
          @retry="retryRead" @close="peek.close()" />
      </DialogContent>
    </Dialog>

    <UiDialog :open="dialogOpen" form :busy="saving" :error="dialogError" size="sm"
      :title="t(editing ? 'occupations.dialog.editTitle' : 'occupations.dialog.createTitle')"
      :description="t('occupations.dialog.description')" @close="dialogOpen = false" @submit="save">
      <div class="occupations-form">
        <TextField v-model="name" :label="t('occupations.dialog.name')" required data-occupation-name />
        <TextField v-model="duties" :label="t('occupations.dialog.duties')" multiline :rows="4" required data-occupation-duties />
        <small>{{ t('occupations.dialog.dutiesHint') }}</small>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="saving" @click="dialogOpen = false">{{ t('occupations.dialog.cancel') }}</Button>
        <Button type="submit" :loading="saving" :loading-label="t('occupations.dialog.saving')" data-occupation-save>{{ t('occupations.dialog.save') }}</Button>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.occupations-search { flex: 1 1 260px; max-width: 420px; }
.occupations-search input {
  box-sizing: border-box; width: 100%; height: var(--control-height-sm); padding: 0 12px; border: 1px solid var(--color-control-border);
  border-radius: var(--radius-control); color: var(--color-ink); background: var(--color-surface); font: inherit; font-size: 13px;
}
.occupation-row.is-archived :is(.occupation-name, .occupation-duties) { color: var(--color-muted); }
/* The open row lifts; it never gets a side bar. */
.occupation-row.is-selected { box-shadow: var(--shadow-md); }
.occupations-sort { color: var(--color-muted); }
.occupations-sort.is-sorted { color: var(--color-ink); }
.occupation-name:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.occupations-form { display: grid; gap: 12px; }
.occupations-form small { color: var(--color-muted); font-size: 12px; }
</style>
