<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import PageColumns from '@/components/PageColumns.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { focusReturnTarget } from '@/composables/useFocusReturn'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { useRoutePeek } from '@/composables/useRoutePeek'
import KnowledgeBasisReview from '@/features/knowledge-quick-edit/KnowledgeBasisReview.vue'
import KnowledgeContentEditor from '@/features/knowledge-quick-edit/KnowledgeContentEditor.vue'
import KnowledgeItemDependents from '@/features/knowledge-quick-edit/KnowledgeItemDependents.vue'
import KnowledgeItemHistory from '@/features/knowledge-quick-edit/KnowledgeItemHistory.vue'
import KnowledgeItemSummaryCard from '@/features/knowledge-quick-edit/KnowledgeItemSummaryCard.vue'
import KnowledgeScopeEditor from '@/features/knowledge-quick-edit/KnowledgeScopeEditor.vue'
import KnowledgeTagEditor from '@/features/knowledge-quick-edit/KnowledgeTagEditor.vue'
import KnowledgeVersionPeek from '@/features/knowledge-quick-edit/KnowledgeVersionPeek.vue'
import KnowledgeHardDeletedNotice from '@/features/knowledge-hard-delete/KnowledgeHardDeletedNotice.vue'
import KnowledgeHardDeleteSection from '@/features/knowledge-hard-delete/KnowledgeHardDeleteSection.vue'
import type { SourceDeleteTarget } from '@/features/knowledge-hard-delete/source-delete-model'
import { hardDeletedFrom, type HardDeletedState } from '@/features/knowledge-hard-delete/model'
import {
  itemEditPath, versionFromPeekId, versionPeekId, versionStatus, versionStatusLabel, versionTone,
  type EditFailure, type ItemKind, type ItemVersion, type KnowledgeItemView,
} from '@/features/knowledge-quick-edit/model'
import { readKnowledgeItem } from '@/features/knowledge-quick-edit/quick-edit-api'
import { t } from '@/i18n'
import { usePageTitle } from '@/layouts/page-title'
import { useConsoleStore } from '@/stores/console'

// A turn receipt's link (rec#20): this one item, read back from the Provider,
// with its quick edits on one page. The link grants nothing; every read and
// save is authorized again, and a save names the version shown here. An edit
// writes a new version (rec#5 C7), so the page moves to it; an old link shows
// the old version as history and points at the current one. A version in the
// history opens in a quick look kept in the URL (?item=<space>/<kind>:<id>).
// A permanent delete (rec#5 C9) is the last, collapsed section; afterwards,
// and on any old link to what it removed, the page says 已彻底删除.
const route = useRoute()
const router = useRouter()
const store = useConsoleStore()
const spaceId = computed(() => String(route.params.spaceId ?? ''))
const kind = computed(() => String(route.params.itemKind ?? '') as ItemKind)
const itemId = computed(() => String(route.params.itemId ?? ''))

const item = ref<KnowledgeItemView | null>(null)
const loading = ref(false)
const error = ref('')
const deleted = ref<HardDeletedState | null>(null)
const sourceDeletion = ref<{ target: SourceDeleteTarget; state: HardDeletedState } | null>(null)
const notice = ref('')
const root = ref<HTMLElement | null>(null)
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !item.value))
let requestVersion = 0
usePageTitle(computed(() => !deleted.value ? item.value?.title ?? ''
  : t(deleted.value.outcome === 'unknown' ? 'knowledgeHardDelete.deleted.unknownTitle' : 'knowledgeHardDelete.deleted.pageTitle')))

const projects = computed(() => (store.state?.personalProjects ?? [])
  .filter(project => project.personal_space_id === spaceId.value))
const status = computed(() => item.value ? versionStatus(item.value) : 'current')
const active = computed(() => status.value === 'current')
const historyNotice = computed(() => status.value === 'inactive' ? t('knowledgeQuickEdit.historical')
  : t(`knowledgeQuickEdit.historyNote.${status.value}`))
const currentVersionPath = computed(() => item.value?.current_item_id && item.value.current_item_id !== item.value.item_id
  ? itemEditPath(spaceId.value, { item_kind: item.value.item_kind, item_id: item.value.current_item_id }) : null)

const peek = useRoutePeek()
const peekVersion = computed(() => {
  const requested = peek.item.value
  return requested && requested.spaceId === spaceId.value ? versionFromPeekId(requested.id) : null
})
const peekKnown = computed(() => item.value?.versions?.find(version =>
  version.item_id === peekVersion.value?.item_id && version.item_kind === peekVersion.value?.item_kind) ?? null)
let lastOpened = ''
// What the page says once it moved to the version an edit wrote.
let carriedNotice = ''

async function load() {
  const current = ++requestVersion
  if (!itemId.value) { error.value = t('knowledgeQuickEdit.missing'); return }
  loading.value = true
  error.value = ''
  try {
    const value = await readKnowledgeItem(spaceId.value, kind.value, itemId.value)
    if (current === requestVersion) item.value = value
  } catch (cause) {
    if (current !== requestVersion) return
    const gone = hardDeletedFrom(cause)
    if (gone) deleted.value = gone
    else error.value = (cause as Error).message
  } finally {
    if (current === requestVersion) loading.value = false
  }
}

// A stale save means the page shows an old version: read it again, keep the person's place.
function failed(reason: EditFailure) {
  notice.value = reason === 'conflict' ? t('knowledgeQuickEdit.conflict')
    : reason === 'superseded' ? t('knowledgeQuickEdit.supersededConflict') : ''
  if (reason === 'conflict' || reason === 'superseded') void load()
}

function saved() {
  notice.value = ''
  void load()
}

// The edit wrote a new version: this page is about that one now. Replace, so
// Back still returns to the collection the page was opened from.
function versioned(versionId: string, waiting = 0) {
  carriedNotice = [t('knowledgeQuickEdit.content.saved'),
    waiting ? t('knowledgeQuickEdit.meaning.dependents', { count: waiting }) : ''].filter(Boolean).join(' ')
  void router.replace(itemEditPath(spaceId.value, { item_kind: kind.value, item_id: versionId }))
}

function sourceRemoved(target: SourceDeleteTarget, state: HardDeletedState) {
  ++requestVersion
  loading.value = false
  item.value = null
  sourceDeletion.value = { target, state }
  void peek.close()
}
function reloadAfterSource() {
  sourceDeletion.value = null
  void load()
}

function removed(state: HardDeletedState) {
  item.value = null
  deleted.value = state
}

// Checked: the delete did not happen after all; show the item again.
function stillThere() {
  deleted.value = null
  notice.value = t('knowledgeHardDelete.deleted.notDeleted')
  void load()
}

function openVersion(version: ItemVersion) {
  lastOpened = versionPeekId(version)
  void peek.open({ spaceId: spaceId.value, id: lastOpened })
}

function peekOpenChange(value: boolean) {
  if (!value) void peek.close()
}

function focusDialog(event: Event) {
  event.preventDefault()
  ;(event.target as HTMLElement | null)?.focus({ preventScroll: true })
}

function returnFocus(event: Event) {
  event.preventDefault()
  focusReturnTarget(root.value, lastOpened)
}

watch([spaceId, kind, itemId], () => {
  item.value = null
  deleted.value = null
  sourceDeletion.value = null
  notice.value = carriedNotice
  carriedNotice = ''
  void load()
}, { immediate: true })
</script>

<template>
  <section class="view">
  <div ref="root" class="flex w-full flex-col gap-4" data-knowledge-item-edit>
    <BackLink to="/organize" :from="/^\/(organize|knowledge|preferences)/" class="text-sm">{{ t('knowledgeQuickEdit.back') }}</BackLink>
    <GrowthLoading v-if="showLoading" :label="t('knowledgeQuickEdit.loading')" />
    <section v-else-if="sourceDeletion" class="grid gap-3" data-source-deleted-page>
      <KnowledgeHardDeletedNotice :state="sourceDeletion.state" :space-id="spaceId" :item-kind="sourceDeletion.target.item_kind" :item-id="sourceDeletion.target.item_id"
        @changed="sourceRemoved(sourceDeletion!.target, $event)" @present="reloadAfterSource" />
      <Button v-if="sourceDeletion.state.outcome === 'complete' || sourceDeletion.state.outcome === 'gone'" variant="outline" @click="reloadAfterSource">{{ t('knowledgeHardDelete.source.reload') }}</Button>
    </section>
    <KnowledgeHardDeletedNotice v-else-if="deleted" :state="deleted" :space-id="spaceId" :item-kind="kind" :item-id="itemId"
      @changed="removed" @present="stillThere" />
    <div v-else-if="error && !item" role="alert" class="grid justify-items-start gap-2">
      <p class="m-0">{{ t('knowledgeQuickEdit.loadFailed', { error }) }}</p>
      <Button variant="outline" size="sm" @click="load">{{ t('knowledgeQuickEdit.retry') }}</Button>
    </div>
    <template v-else-if="item">
      <KnowledgeItemSummaryCard :item="item" :heading="item.title" />
      <GrowthLoading v-if="loading" variant="inline" :label="t('knowledgeQuickEdit.loading')" />
      <p v-if="notice" role="status" class="m-0 text-sm" data-edit-notice>{{ notice }}</p>
      <div v-if="!active" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground" data-item-historical>
        <span>{{ historyNotice }}</span>
        <Button v-if="currentVersionPath" variant="link" size="sm" class="h-auto p-0" as-child data-current-version>
          <RouterLink :to="currentVersionPath">{{ t('knowledgeQuickEdit.viewCurrent') }}</RouterLink>
        </Button>
      </div>
      <!-- The page's full width: the item's sections sit in two columns on a wide window. -->
      <PageColumns>
        <KnowledgeBasisReview :item="item" :space-id="spaceId" @versioned="versioned" @failed="failed" />
        <template v-if="active">
          <KnowledgeScopeEditor :item="item" :space-id="spaceId" :projects="projects" @saved="saved" @failed="failed" />
          <KnowledgeTagEditor :item="item" :space-id="spaceId" @changed="saved" @failed="failed" />
        </template>
        <KnowledgeContentEditor :item="item" :space-id="spaceId" @saved="saved" @versioned="versioned" @failed="failed" />
        <Card v-if="item.bases?.length" as="section" data-item-bases>
          <CardHeader>
            <CardTitle as="h2">{{ t('knowledgeQuickEdit.bases.title') }}</CardTitle>
            <CardDescription>{{ t('knowledgeQuickEdit.bases.help') }}</CardDescription>
          </CardHeader>
          <ul class="m-0 grid list-none gap-2 px-5 text-sm">
            <li v-for="basis in item.bases" :key="basis.item_id" class="flex min-w-0 flex-wrap items-center gap-2">
              <Badge :variant="versionTone(basis.status)">{{ versionStatusLabel(basis.status) }}</Badge>
              <RouterLink :to="itemEditPath(spaceId, basis)" class="min-w-0 underline underline-offset-4 [overflow-wrap:anywhere]">
                {{ basis.status === 'deleted' ? t('knowledgeHardDelete.deleted.basis') : basis.content }}
              </RouterLink>
            </li>
          </ul>
        </Card>
        <KnowledgeItemDependents :item="item" :space-id="spaceId" @saved="saved" @failed="failed" />
        <KnowledgeItemHistory :item="item" :space-id="spaceId" @open-version="openVersion" @source-deleted="sourceRemoved" />
        <KnowledgeHardDeleteSection :item="item" :space-id="spaceId" @deleted="removed" />
      </PageColumns>
    </template>
  </div>
  <Dialog :open="Boolean(peekVersion)" @update:open="peekOpenChange">
    <DialogContent v-if="peekVersion" size="lg" data-version-peek @open-auto-focus="focusDialog" @close-auto-focus="returnFocus">
      <KnowledgeVersionPeek :space-id="spaceId" :version="peekVersion" :known="peekKnown" />
    </DialogContent>
  </Dialog>
  </section>
</template>
