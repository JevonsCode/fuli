<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import TextField from '@/components/TextField.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { focusReturnTarget, useFocusReturn } from '@/composables/useFocusReturn'
import { useRoutePeek } from '@/composables/useRoutePeek'
import OccupationPeek from '@/features/occupations/OccupationPeek.vue'
import {
  occupationDescription, occupationName, useOccupationCatalog, type OccupationEntry,
} from '@/features/occupations/occupation-catalog'
import { occupationPeekState } from '@/features/occupations/occupation-peek'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiDialog, UiStatRow, type UiStat } from '@/ui'

// 职业: the space's occupation catalog as one canvas of cards. A card's name
// opens its quick look (?item=<space>/<key>), which a refresh or a shared link
// reopens. Built-in occupations can be archived, never deleted; custom ones
// need their duties.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const catalog = useOccupationCatalog(spaceId)
const filter = ref<'all' | 'active' | 'archived' | 'custom'>('all')
const query = ref('')
type QuickChange = 'archive' | 'restore' | 'remove'
const busy = ref<{ key: string; action: QuickChange } | null>(null)
const actionError = ref('')

const entries = computed(() => catalog.entries.value)
const counts = computed(() => ({
  all: entries.value.length,
  active: entries.value.filter(entry => entry.status === 'active').length,
  archived: entries.value.filter(entry => entry.status === 'archived').length,
  custom: entries.value.filter(entry => !entry.builtin).length,
}))
const stats = computed<UiStat[]>(() => (['all', 'active', 'archived', 'custom'] as const).map(key => ({
  key, label: t(`occupations.stats.${key}`), value: counts.value[key], pressed: filter.value === key,
  tone: key === 'active' ? 'success' : key === 'custom' ? 'accent' : 'neutral',
})))
const visible = computed(() => {
  const text = query.value.trim().toLowerCase()
  return entries.value.filter(entry => (filter.value === 'all' || (filter.value === 'custom' ? !entry.builtin : entry.status === filter.value))
    && (!text || [entry.name_zh, entry.name_en, entry.description_zh, entry.description_en].some(value => value.toLowerCase().includes(text))))
})
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
  try {
    await catalog[action](entry)
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
    <div class="@container mx-auto flex w-full max-w-(--canvas-max) flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
        <UiStatRow :items="stats" :label="t('occupations.statsAria')" @select="key => filter = key as typeof filter" />
        <p class="page-lede m-0 text-sm text-muted-foreground">{{ t('occupations.lede') }}</p>
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
        <ul v-else class="m-0 grid list-none grid-cols-1 gap-3 p-0 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[1400px]:grid-cols-4">
          <li v-for="entry in visible" :key="entry.key" class="min-w-0">
            <article class="occupation-card flex h-full min-w-0 flex-col gap-2 rounded-lg border bg-card p-4 transition-[border-color,box-shadow] hover:border-border-strong"
              :class="{ 'is-archived': entry.status === 'archived', 'is-selected border-border-strong shadow-md': peekKey === entry.key }"
              :data-occupation-row="entry.key" :data-return-focus="entry.key">
              <h2 class="m-0 text-base leading-snug font-semibold">
                <Button variant="link" class="occupation-name h-auto min-h-0 justify-start p-0 text-left text-base font-semibold whitespace-normal text-foreground underline-offset-4 hover:text-primary hover:underline"
                  aria-haspopup="dialog" data-occupation-open @click="openPeek(entry)">
                  <span class="line-clamp-2 [overflow-wrap:anywhere]">{{ occupationName(entry) }}</span>
                </Button>
              </h2>
              <p class="occupation-duties m-0 line-clamp-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">{{ occupationDescription(entry) || t('occupations.noDescription') }}</p>
              <div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge v-if="entry.builtin" variant="secondary">{{ t('occupations.builtin') }}</Badge>
                <Badge v-if="entry.status === 'archived'" variant="warning">{{ t('occupations.archived') }}</Badge>
                <span>{{ t('occupations.agentCount', { count: entry.agent_count }) }}</span>
              </div>
              <footer class="mt-auto flex flex-wrap items-center gap-1 border-t pt-3">
                <Button variant="ghost" size="sm" :disabled="Boolean(busyOn(entry))" data-occupation-edit @click="openDialog(entry)">{{ t('occupations.edit') }}</Button>
                <Button v-if="entry.status === 'active'" variant="ghost" size="sm" :disabled="Boolean(busyOn(entry))" :loading="busyOn(entry) === 'archive'"
                  :loading-label="t('occupations.archiving')" data-occupation-archive @click="act(entry, 'archive')">{{ t('occupations.archive') }}</Button>
                <Button v-else variant="ghost" size="sm" :disabled="Boolean(busyOn(entry))" :loading="busyOn(entry) === 'restore'"
                  :loading-label="t('occupations.restoring')" data-occupation-restore @click="act(entry, 'restore')">{{ t('occupations.restore') }}</Button>
                <Button v-if="!entry.builtin" variant="ghost" size="sm" class="ml-auto text-destructive" :disabled="Boolean(busyOn(entry)) || entry.agent_count > 0"
                  :loading="busyOn(entry) === 'remove'" :loading-label="t('occupations.removing')"
                  :title="entry.agent_count > 0 ? t('occupations.inUse') : undefined" data-occupation-remove @click="act(entry, 'remove')">
                  {{ t('occupations.remove') }}
                </Button>
              </footer>
            </article>
          </li>
        </ul>
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
.occupation-card.is-archived :is(.occupation-name, .occupation-duties) { color: var(--color-muted); }
.occupation-name:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.occupations-form { display: grid; gap: 12px; }
.occupations-form small { color: var(--color-muted); font-size: 12px; }
</style>
