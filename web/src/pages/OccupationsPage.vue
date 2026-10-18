<script setup lang="ts">
import { computed, ref } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import TextField from '@/components/TextField.vue'
import {
  occupationDescription, occupationName, useOccupationCatalog, type OccupationEntry,
} from '@/features/occupations/occupation-catalog'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiButton, UiChip, UiDialog, UiEmpty, UiStatRow, UiToolbar, type UiStat } from '@/ui'

// 职业: the space's occupation catalog on the shared list layout. Built-in
// occupations can be archived, never deleted; custom ones need their duties.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const catalog = useOccupationCatalog(spaceId)
const filter = ref<'all' | 'active' | 'archived' | 'custom'>('all')
const query = ref('')
const busyKey = ref('')
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
async function act(entry: OccupationEntry, action: 'archive' | 'restore' | 'remove') {
  busyKey.value = entry.key
  actionError.value = ''
  try { await catalog[action](entry) } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause)
  } finally { busyKey.value = '' }
}
</script>

<template>
  <section class="view page-stack occupations-view">
    <UiStatRow :items="stats" :label="t('occupations.statsAria')" @select="key => filter = key as typeof filter" />
    <p class="page-lede">{{ t('occupations.lede') }}</p>
    <UiToolbar>
      <label class="occupations-search">
        <span class="ui-sr-only">{{ t('occupations.search') }}</span>
        <input v-model="query" type="search" :placeholder="t('occupations.search')" />
      </label>
      <template #end>
        <GrowthLoading v-if="catalog.loading.value && entries.length" variant="inline" :label="t('occupations.loading')" />
        <UiButton variant="primary" size="sm" data-occupation-new @click="openDialog(null)">{{ t('occupations.new') }}</UiButton>
      </template>
    </UiToolbar>
    <p v-if="actionError || catalog.error.value" class="occupations-error" role="alert">{{ actionError || catalog.error.value }}</p>

    <GrowthLoading v-if="catalog.loading.value && !entries.length" variant="compact" :label="t('occupations.loading')" />
    <UiEmpty v-else-if="!visible.length" class="ui-list" :text="t('occupations.empty')" />
    <div v-else class="ui-list">
      <article v-for="entry in visible" :key="entry.key" class="ui-list-row" :class="{ 'is-archived': entry.status === 'archived' }" :data-occupation-row="entry.key">
        <div class="ui-list-main">
          <strong class="ui-list-heading">{{ occupationName(entry) }}</strong>
          <p class="ui-list-text">{{ occupationDescription(entry) || t('occupations.noDescription') }}</p>
          <div class="ui-list-meta">
            <UiChip v-if="entry.builtin">{{ t('occupations.builtin') }}</UiChip>
            <UiChip v-if="entry.status === 'archived'" tone="warning">{{ t('occupations.archived') }}</UiChip>
            <span>{{ t('occupations.agentCount', { count: entry.agent_count }) }}</span>
          </div>
        </div>
        <div class="ui-list-actions">
          <UiButton variant="ghost" size="sm" :disabled="busyKey === entry.key" data-occupation-edit @click="openDialog(entry)">{{ t('occupations.edit') }}</UiButton>
          <UiButton v-if="entry.status === 'active'" variant="ghost" size="sm" :disabled="busyKey === entry.key" data-occupation-archive
            @click="act(entry, 'archive')">{{ t('occupations.archive') }}</UiButton>
          <UiButton v-else variant="ghost" size="sm" :disabled="busyKey === entry.key" data-occupation-restore
            @click="act(entry, 'restore')">{{ t('occupations.restore') }}</UiButton>
          <UiButton v-if="!entry.builtin" variant="danger" size="sm" :disabled="busyKey === entry.key || entry.agent_count > 0"
            :title="entry.agent_count > 0 ? t('occupations.inUse') : undefined" data-occupation-remove @click="act(entry, 'remove')">
            {{ t('occupations.remove') }}
          </UiButton>
        </div>
      </article>
    </div>

    <UiDialog :open="dialogOpen" form :busy="saving" :error="dialogError" size="sm"
      :title="t(editing ? 'occupations.dialog.editTitle' : 'occupations.dialog.createTitle')"
      :description="t('occupations.dialog.description')" @close="dialogOpen = false" @submit="save">
      <div class="occupations-form">
        <TextField v-model="name" :label="t('occupations.dialog.name')" required data-occupation-name />
        <TextField v-model="duties" :label="t('occupations.dialog.duties')" multiline :rows="4" required data-occupation-duties />
        <small>{{ t('occupations.dialog.dutiesHint') }}</small>
      </div>
      <template #footer>
        <GrowthLoading v-if="saving" variant="inline" :label="t('occupations.dialog.saving')" />
        <UiButton variant="ghost" :disabled="saving" @click="dialogOpen = false">{{ t('occupations.dialog.cancel') }}</UiButton>
        <UiButton variant="primary" type="submit" :disabled="saving" data-occupation-save>{{ t('occupations.dialog.save') }}</UiButton>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.occupations-search { flex: 1 1 260px; max-width: 420px; }
.occupations-search input {
  width: 100%; height: var(--control-height-sm); padding: 0 12px; border: 1px solid var(--color-control-border);
  border-radius: var(--radius-control); color: var(--color-ink); background: var(--color-surface); font: inherit; font-size: 13px;
}
.occupations-error { margin: 0; color: var(--color-danger); font-size: 13px; }
.ui-list-row.is-archived .ui-list-heading, .ui-list-row.is-archived .ui-list-text { color: var(--color-muted); }
.occupations-form { display: grid; gap: 12px; }
.occupations-form small { color: var(--color-muted); font-size: 12px; }
</style>
