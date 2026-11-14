<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import PageStack from '@/components/PageStack.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import KnowledgeItemSummaryCard from '@/features/knowledge-quick-edit/KnowledgeItemSummaryCard.vue'
import { itemEditPath } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import { usePageTitle } from '@/layouts/page-title'
import { useConsoleStore } from '@/stores/console'
import { readHabitDelivery, readHabitRows } from './habit-delivery-api'
import type { HabitRow } from './model'

// The habits FULI handed to the assistant when a conversation started: the
// list behind the first reply's 「FULI 习惯」 receipt line. Read in the active
// space; each habit opens its own quick edit.
const route = useRoute()
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const taskKey = computed(() => String(route.params.taskKey ?? ''))

const rows = ref<HabitRow[] | null>(null)
const expired = ref(false)
const loading = ref(false)
const error = ref('')
const showLoading = useMinimumLoadingDisplay(computed(() => (loading.value || !spaceId.value) && !rows.value && !expired.value))
let requestVersion = 0

usePageTitle(computed(() => rows.value ? t('habitDelivery.header', { count: rows.value.length }) : ''))

async function load() {
  if (!spaceId.value) return
  const current = ++requestVersion
  loading.value = true
  error.value = ''
  try {
    const delivery = await readHabitDelivery(taskKey.value)
    const value = delivery ? await readHabitRows(spaceId.value, delivery) : null
    if (current !== requestVersion) return
    expired.value = !delivery
    rows.value = value
  } catch (cause) {
    if (current === requestVersion) error.value = (cause as Error).message
  } finally {
    if (current === requestVersion) loading.value = false
  }
}

watch([spaceId, taskKey], () => { rows.value = null; expired.value = false; void load() }, { immediate: true })
</script>

<template>
  <section class="view">
    <div class="flex w-full flex-col gap-4" data-habit-delivery>
      <GrowthLoading v-if="showLoading" :label="t('habitDelivery.loading')" />
      <div v-else-if="error" role="alert" class="grid justify-items-start gap-2">
        <p class="m-0">{{ t('habitDelivery.loadFailed', { error }) }}</p>
        <Button variant="outline" size="sm" @click="load">{{ t('knowledgeQuickEdit.retry') }}</Button>
      </div>
      <p v-else-if="expired" class="m-0 text-sm text-muted-foreground" data-habit-expired>{{ t('habitDelivery.expired') }}</p>
      <template v-else-if="rows">
        <PageStack role="list">
          <div v-for="row in rows" :key="`${row.kind}:${row.id}`" role="listitem" class="grid gap-2" :data-habit="row.id">
            <Card v-if="row.deleted" as="section" class="px-5" data-habit-deleted>
              <p class="m-0 text-sm text-muted-foreground">{{ t('habitDelivery.deleted') }}</p>
            </Card>
            <template v-else>
              <RouterLink :to="itemEditPath(spaceId, row.item)" class="select-none text-sm font-medium underline">
                {{ t('knowledgeQuickEdit.turn.open') }} · {{ row.item.title }}
              </RouterLink>
              <KnowledgeItemSummaryCard :item="row.item" />
            </template>
          </div>
        </PageStack>
        <p class="m-0 text-sm text-muted-foreground" data-habit-footnote>{{ t('habitDelivery.footnote') }}</p>
      </template>
    </div>
  </section>
</template>
