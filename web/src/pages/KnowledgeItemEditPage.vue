<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import KnowledgeContentEditor from '@/features/knowledge-quick-edit/KnowledgeContentEditor.vue'
import KnowledgeItemHistory from '@/features/knowledge-quick-edit/KnowledgeItemHistory.vue'
import KnowledgeItemSummaryCard from '@/features/knowledge-quick-edit/KnowledgeItemSummaryCard.vue'
import KnowledgeScopeEditor from '@/features/knowledge-quick-edit/KnowledgeScopeEditor.vue'
import KnowledgeTagEditor from '@/features/knowledge-quick-edit/KnowledgeTagEditor.vue'
import type { EditFailure, ItemKind, KnowledgeItemView } from '@/features/knowledge-quick-edit/model'
import { readKnowledgeItem } from '@/features/knowledge-quick-edit/quick-edit-api'
import { t } from '@/i18n'
import { usePageTitle } from '@/layouts/page-title'
import { useConsoleStore } from '@/stores/console'

// A turn receipt's link (rec#20): this one item, read back from the Provider,
// with its quick edits on one page. The link grants nothing; every read and
// save is authorized again, and a save names the version shown here.
const route = useRoute()
const store = useConsoleStore()
const spaceId = computed(() => String(route.params.spaceId ?? ''))
const kind = computed(() => String(route.params.itemKind ?? '') as ItemKind)
const itemId = computed(() => String(route.params.itemId ?? ''))

const item = ref<KnowledgeItemView | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !item.value))
let requestVersion = 0
usePageTitle(computed(() => item.value?.title ?? ''))

const projects = computed(() => (store.state?.personalProjects ?? [])
  .filter(project => project.personal_space_id === spaceId.value))
const active = computed(() => Boolean(item.value && !item.value.invalid_at))

async function load() {
  const current = ++requestVersion
  if (!itemId.value) { error.value = t('knowledgeQuickEdit.missing'); return }
  loading.value = true
  error.value = ''
  try {
    const value = await readKnowledgeItem(spaceId.value, kind.value, itemId.value)
    if (current === requestVersion) item.value = value
  } catch (cause) {
    if (current === requestVersion) error.value = (cause as Error).message
  } finally {
    if (current === requestVersion) loading.value = false
  }
}

// A stale save means the page shows an old version: read it again, keep the person's place.
function failed(reason: EditFailure) {
  notice.value = reason === 'conflict' ? t('knowledgeQuickEdit.conflict') : ''
  if (reason === 'conflict') void load()
}

function saved() {
  notice.value = ''
  void load()
}

watch([spaceId, kind, itemId], () => { item.value = null; void load() }, { immediate: true })
</script>

<template>
  <section class="view [scrollbar-gutter:stable]">
  <div class="mx-auto flex w-full max-w-(--form-max) flex-col gap-4" data-knowledge-item-edit>
    <BackLink to="/organize" :from="/^\/(organize|knowledge|preferences)/" class="text-sm">{{ t('knowledgeQuickEdit.back') }}</BackLink>
    <GrowthLoading v-if="showLoading" :label="t('knowledgeQuickEdit.loading')" />
    <div v-else-if="error && !item" role="alert" class="grid justify-items-start gap-2">
      <p class="m-0">{{ t('knowledgeQuickEdit.loadFailed', { error }) }}</p>
      <Button variant="outline" size="sm" @click="load">{{ t('knowledgeQuickEdit.retry') }}</Button>
    </div>
    <template v-else-if="item">
      <KnowledgeItemSummaryCard :item="item" />
      <GrowthLoading v-if="loading" variant="inline" :label="t('knowledgeQuickEdit.loading')" />
      <p v-if="notice" role="status" class="m-0 text-sm" data-edit-notice>{{ notice }}</p>
      <p v-if="!active" class="m-0 text-sm text-muted-foreground" data-item-historical>{{ t('knowledgeQuickEdit.historical') }}</p>
      <template v-if="active">
        <KnowledgeScopeEditor :item="item" :space-id="spaceId" :projects="projects" @saved="saved" @failed="failed" />
        <KnowledgeTagEditor :item="item" :space-id="spaceId" @changed="saved" @failed="failed" />
        <KnowledgeContentEditor :item="item" :space-id="spaceId" @saved="saved" @failed="failed" />
      </template>
      <KnowledgeItemHistory :item="item" />
    </template>
  </div>
  </section>
</template>
