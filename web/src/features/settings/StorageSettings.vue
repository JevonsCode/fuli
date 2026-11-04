<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import UiNotice from '@/ui/UiNotice.vue'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { formatBytes } from '@/lib/format-bytes'
import { useConsoleStore } from '@/stores/console'
import UiIcon from '@/ui/UiIcon.vue'
import { deleteOldData, oldDataGroups, oldDataKindLabel, oldDataLabel, readOldData, restoreOldData, storageHeadline, type OldData, type OldDataItem } from './old-data-model'

// Settings › 存储 (rec#80 group B): how much FULI's data takes, and the old
// data FULI kept before changing it. 「查看旧数据」 lists each copy with what
// left it; 恢复 is reversible (FULI keeps today's data first), so it runs at
// once; 立即删除 cannot be undone, so it asks once more in place.
const store = useConsoleStore()
const oldData = ref<OldData | null>(null)
const loadError = ref('')
const open = ref(false)
const pending = ref<{ id: string; action: 'restore' | 'delete' } | null>(null)
const confirming = ref<string | null>(null)
// By kind, the biggest first (Jevons 11-04: dozens of small client copies buried the 4 GB);
// a kind of several copies opens on a click, one of one copy shows it at once.
const groups = computed(() => oldDataGroups(oldData.value?.items ?? []))
const openKinds = ref(new Set<string>())
function toggleKind(kind: string) {
  const next = new Set(openKinds.value)
  if (!next.delete(kind)) next.add(kind)
  openKinds.value = next
}
const time = (value: string) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '-' })

async function load() {
  try {
    oldData.value = await readOldData()
    loadError.value = ''
  } catch (error) {
    loadError.value = t('settings.storage.loadError', { reason: apiErrorReason(error) })
  }
}
onMounted(load)

async function restore(item: OldDataItem) {
  pending.value = { id: item.id, action: 'restore' }
  try {
    await restoreOldData(item.id)
    store.notify(t('settings.storage.restoreStarted', { what: oldDataLabel(item) }))
  } catch (error) {
    store.reportError(error)
  } finally {
    pending.value = null
  }
}

async function remove(item: OldDataItem) {
  if (confirming.value !== item.id) {
    confirming.value = item.id
    return
  }
  confirming.value = null
  pending.value = { id: item.id, action: 'delete' }
  try {
    const { freedBytes } = await deleteOldData(item.id)
    store.notify(t('settings.storage.deleted', { what: oldDataLabel(item), size: formatBytes(freedBytes) }))
    await load()
    if (!oldData.value?.items.length) open.value = false
  } catch (error) {
    store.reportError(error)
  } finally {
    pending.value = null
  }
}

const busy = (item: OldDataItem, action: 'restore' | 'delete') => pending.value?.id === item.id && pending.value.action === action
</script>

<template>
  <Card as="section" id="storage" class="settings-card storage-settings" aria-labelledby="settings-storage-title" data-storage-settings>
    <CardHeader>
      <CardTitle id="settings-storage-title" as="h2">{{ t('settings.storage.title') }}</CardTitle>
      <CardDescription v-if="oldData" data-storage-headline>{{ storageHeadline(oldData) }}</CardDescription>
      <CardAction v-if="oldData?.items.length">
        <Button type="button" size="sm" variant="outline" aria-haspopup="dialog" data-old-data-open @click="open = true">
          {{ t('settings.storage.view') }}
        </Button>
      </CardAction>
    </CardHeader>
    <div v-if="!oldData" class="storage-body">
      <GrowthLoading v-if="!loadError" variant="compact" :label="t('settings.storage.loading')" />
      <UiNotice v-else tone="error">{{ loadError }}</UiNotice>
    </div>

    <Dialog v-model:open="open">
      <DialogContent size="lg" data-old-data-dialog>
        <DialogHeader>
          <DialogTitle>{{ t('settings.storage.dialogTitle') }}</DialogTitle>
          <DialogDescription>{{ t('settings.storage.dialogDescription') }}</DialogDescription>
        </DialogHeader>
        <ul class="old-data-list">
          <li v-for="group in groups" :key="group.kind" class="old-data-group" :data-old-data-group="group.kind">
            <button v-if="group.items.length > 1" type="button" class="old-data-group-head" :aria-expanded="openKinds.has(group.kind)"
              data-old-data-group-toggle @click="toggleKind(group.kind)">
              <span>
                <strong>{{ oldDataKindLabel(group.kind) }}</strong>
                <small>{{ t('settings.storage.group', { count: group.items.length, size: formatBytes(group.bytes) }) }}</small>
              </span>
              <UiIcon :name="openKinds.has(group.kind) ? 'chevron-up' : 'chevron-down'" :size="16" />
            </button>
            <ul v-if="group.items.length === 1 || openKinds.has(group.kind)" class="old-data-items">
              <li v-for="item in group.items" :key="item.id" class="old-data-row" :data-old-data-item="item.id">
                <span>
                  <strong>{{ oldDataLabel(item) }}</strong>
                  <small>{{ t('settings.storage.row', { time: time(item.createdAt), size: formatBytes(item.bytes) }) }}</small>
                </span>
                <span class="old-data-actions">
                  <Button v-if="item.restorable" type="button" size="sm" variant="outline" :disabled="Boolean(pending)"
                    :loading="busy(item, 'restore')" :loading-label="t('settings.storage.restoring')" data-old-data-restore @click="restore(item)">
                    {{ t('settings.storage.restore') }}
                  </Button>
                  <Button type="button" size="sm" :variant="confirming === item.id ? 'destructive' : 'ghost'" :disabled="Boolean(pending)"
                    :loading="busy(item, 'delete')" :loading-label="t('settings.storage.deleting')" class="old-data-delete" data-old-data-delete @click="remove(item)">
                    {{ confirming === item.id ? t('settings.storage.confirmDelete') : t('settings.storage.delete') }}
                  </Button>
                </span>
              </li>
            </ul>
          </li>
        </ul>
      </DialogContent>
    </Dialog>
  </Card>
</template>

<style scoped>
.storage-body { display: grid; gap: var(--space-3); padding-inline: 24px; }
.old-data-list, .old-data-items { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.old-data-group { display: grid; gap: 10px; }
.old-data-group-head {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0; border: 0; background: none;
  color: var(--color-muted); text-align: left; cursor: pointer; user-select: none;
}
.old-data-group-head > span { display: grid; gap: 2px; }
.old-data-group-head strong { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.old-data-group-head small { font-size: var(--text-meta); }
.old-data-group:has(.old-data-group-head) .old-data-items { padding-left: 12px; }
.old-data-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.old-data-row > span:first-child { display: grid; min-width: 0; gap: 2px; }
.old-data-row strong { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.old-data-row small { color: var(--color-muted); font-size: var(--text-meta); }
.old-data-actions { display: flex; flex-shrink: 0; gap: 8px; }
/* 立即删除 turns into 确认删除 in place; its width is kept so 恢复 beside it stays put. */
.old-data-delete { min-width: 92px; }
</style>
