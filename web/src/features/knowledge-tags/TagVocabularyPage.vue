<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { t } from '@/i18n'
import { createDebouncedAction } from '@/lib/debounce'
import { useConsoleStore } from '@/stores/console'
import {
  groupByNamespace, linkedChange, statusLabel,
  type GovernanceChange, type StatusFilter, type TagEntry, type TagNamespace, type TagRef, type TagVocabulary,
} from './model'
import TagCard from './TagCard.vue'
import TagDetailDialog from './TagDetailDialog.vue'
import { readVocabulary, VOCABULARY_PAGE } from './tags-api'

// The tag vocabulary (rec#11 D-07 part 2): every namespace the owner has, by
// status, with the review queue of what Agents proposed. A tag opens in a
// dialog where the person governs it; an Agent's link opens that dialog on
// the change it asked for, which still waits for the person's confirm.
const SEARCH_DELAY_MS = 250
const STATUSES = ['provisional', 'active', 'merged', 'retired'] as const
const route = useRoute()
const router = useRouter()
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const projectNames = computed(() => new Map((store.state?.personalProjects ?? [])
  .map(project => [project.project_id, project.profile?.name || project.project_id] as [string, string])))

const tab = ref<'vocabulary' | 'review'>('vocabulary')
const query = ref('')
const namespace = ref<TagNamespace | 'all'>('all')
const status = ref<StatusFilter | 'all'>('all')
const vocabulary = ref<TagVocabulary | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !vocabulary.value))
let request = 0

// The dialog follows the URL: ?tag=<id>[&change=<change>][&into=<id>]. Opening a
// card pushes it, so Back and Forward move between tags and changes, and a
// different change or target on the same tag starts afresh (the dialog's key).
interface Opened { id: string; name: string; change: GovernanceChange | null; target: TagRef | null; key: string }
const opened = computed<Opened | null>(() => {
  const linked = linkedChange(route.query)
  if (!linked) return null
  const known = vocabulary.value?.tags.find(tag => tag.id === linked.tagId)
  return { id: linked.tagId, name: known?.name ?? '', change: linked.change,
    target: linked.intoId ? { id: linked.intoId, name: '', namespace: 'personal', status: 'active' } : null,
    key: `${linked.tagId}:${linked.change ?? ''}:${linked.intoId}` }
})
const groups = computed(() => groupByNamespace(vocabulary.value?.tags ?? [], projectNames.value))
const remaining = computed(() => vocabulary.value ? vocabulary.value.total - vocabulary.value.tags.length : 0)

function filters(offset = 0) {
  return tab.value === 'review'
    ? { status: 'review' as const, offset }
    : { query: query.value, namespace: namespace.value === 'all' ? '' as const : namespace.value,
        status: status.value === 'all' ? '' as const : status.value, offset }
}

async function load() {
  if (!spaceId.value) return
  const current = ++request
  loading.value = true
  error.value = ''
  try {
    const read = await readVocabulary(spaceId.value, filters())
    if (current === request) vocabulary.value = read
  } catch (cause) {
    if (current === request) error.value = apiErrorReason(cause)
  } finally {
    if (current === request) loading.value = false
  }
}

async function loadMore() {
  const shown = vocabulary.value
  if (!shown || shown.next_offset === null || loadingMore.value) return
  loadingMore.value = true
  try {
    const read = await readVocabulary(spaceId.value, filters(shown.next_offset))
    if (vocabulary.value === shown) vocabulary.value = { ...read, tags: [...shown.tags, ...read.tags] }
  } catch (cause) {
    error.value = apiErrorReason(cause)
  } finally {
    loadingMore.value = false
  }
}

function open(tag: TagEntry) {
  void router.push({ query: { tag: tag.id } })
}

function closed(open: boolean) {
  if (!open && route.query.tag) void router.push({ query: {} })
}

const debounced = createDebouncedAction(() => void load(), SEARCH_DELAY_MS)
watch(query, () => debounced.schedule())
watch([tab, namespace, status, spaceId], () => { vocabulary.value = null; void load() }, { immediate: true })
onBeforeUnmount(() => debounced.cancel())

</script>

<template>
  <section class="view [scrollbar-gutter:stable]">
    <div class="@container mx-auto flex w-full max-w-(--layout-max) flex-col gap-4" data-tag-vocabulary>
      <Tabs v-model="tab">
        <TabsList :aria-label="t('knowledgeTags.tabs.label')">
          <TabsTrigger value="vocabulary" data-tag-tab="vocabulary">{{ t('knowledgeTags.tabs.vocabulary') }}</TabsTrigger>
          <TabsTrigger value="review" data-tag-tab="review">
            {{ t('knowledgeTags.tabs.review') }}
            <Badge v-if="vocabulary?.review_count" variant="warning" class="ml-1.5 tabular-nums" data-tag-review-count>
              {{ vocabulary.review_count }}
            </Badge>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div v-if="tab === 'vocabulary'" class="flex min-w-0 flex-wrap items-center gap-2" data-tag-filters>
        <Input v-model="query" type="search" class="min-w-0 flex-[1_1_16rem]" :aria-label="t('knowledgeTags.search')"
          :placeholder="t('knowledgeTags.search')" autocomplete="off" data-tag-search />
        <Select v-model="namespace">
          <SelectTrigger class="w-auto min-w-36" :aria-label="t('knowledgeTags.namespaceFilter')" data-tag-namespace-filter>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t('knowledgeTags.allNamespaces') }}</SelectItem>
            <SelectItem value="personal">{{ t('knowledgeTags.namespace.personal') }}</SelectItem>
            <SelectItem value="project">{{ t('knowledgeTags.namespace.projects') }}</SelectItem>
          </SelectContent>
        </Select>
        <Select v-model="status">
          <SelectTrigger class="w-auto min-w-36" :aria-label="t('knowledgeTags.statusFilter')" data-tag-status-filter>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t('knowledgeTags.allStatuses') }}</SelectItem>
            <SelectItem v-for="value in STATUSES" :key="value" :value="value">{{ statusLabel(value) }}</SelectItem>
          </SelectContent>
        </Select>
        <span v-if="vocabulary" class="ml-auto text-sm text-muted-foreground tabular-nums" data-tag-total>
          {{ t('knowledgeTags.total', { count: vocabulary.total }) }}
        </span>
      </div>

      <GrowthLoading v-if="showLoading" :label="t('knowledgeTags.loading')" />
      <div v-else-if="error && !vocabulary" role="alert" class="grid justify-items-start gap-2 rounded-lg border bg-card p-4">
        <p class="m-0 text-sm text-destructive [overflow-wrap:anywhere]">{{ t('knowledgeTags.loadFailed', { error }) }}</p>
        <Button variant="outline" size="sm" @click="load">{{ t('knowledgeTags.retry') }}</Button>
      </div>
      <template v-else-if="vocabulary">
        <GrowthLoading v-if="loading" variant="inline" :label="t('knowledgeTags.refreshing')" />
        <p v-if="error" role="alert" class="m-0 text-sm text-destructive">{{ t('knowledgeTags.loadFailed', { error }) }}</p>
        <p v-if="!vocabulary.tags.length" class="ui-empty m-0 rounded-lg border border-dashed bg-card" data-tag-empty>
          {{ tab === 'review' ? t('knowledgeTags.reviewEmpty') : t('knowledgeTags.empty') }}
        </p>
        <section v-for="group in groups" :key="group.key" class="grid min-w-0 gap-3" :data-tag-group="group.key">
          <h2 class="m-0 text-sm font-semibold text-muted-foreground">{{ group.label }}</h2>
          <ul class="m-0 grid list-none grid-cols-1 gap-3 p-0 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[1400px]:grid-cols-4">
            <li v-for="tag in group.tags" :key="tag.id" class="min-w-0">
              <TagCard :tag="tag" :selected="opened?.id === tag.id" @open="open(tag)" />
            </li>
          </ul>
        </section>
        <div v-if="vocabulary.next_offset !== null" class="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" :loading="loadingMore" :loading-label="t('knowledgeTags.loadingMore')"
            data-tag-more @click="loadMore">{{ t('knowledgeTags.loadMore', { count: Math.min(remaining, VOCABULARY_PAGE) }) }}</Button>
        </div>
      </template>
    </div>

    <Dialog :open="Boolean(opened && spaceId)" @update:open="closed">
      <DialogContent v-if="opened && spaceId" size="lg" data-tag-dialog>
        <TagDetailDialog :key="opened.key" :space-id="spaceId" :tag-id="opened.id" :name="opened.name || '…'"
          :project-names="projectNames" :initial-change="opened.change" :initial-target="opened.target" @changed="load" />
      </DialogContent>
    </Dialog>
  </section>
</template>
