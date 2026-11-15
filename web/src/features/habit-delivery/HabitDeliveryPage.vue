<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { itemEditPath, scopeLabel } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import { usePageTitle } from '@/layouts/page-title'
import { useConsoleStore } from '@/stores/console'
import { readHabitDelivery, readHabitRows } from './habit-delivery-api'
import type { HabitRow } from './model'

// The habits FULI handed to the assistant when a conversation started: the
// list behind the first reply's 「FULI 习惯」 receipt line. Read in the active
// space; each habit is one line that opens its own page.
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

// The bar names the page; the card's heading says how many, so nothing is said twice or cut short.
usePageTitle(computed(() => t('habitDelivery.title')))

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
      <!-- One plain list: a habit is its text (two lines at most) with where it applies under it, and opens its own page. -->
      <Card v-else-if="rows" as="section" class="gap-3 px-5" aria-labelledby="habit-delivery-heading">
        <h2 id="habit-delivery-heading" class="m-0 text-lg font-semibold">{{ t('habitDelivery.header', { count: rows.length }) }}</h2>
        <ul class="m-0 grid list-none p-0" role="list">
          <li v-for="row in rows" :key="`${row.kind}:${row.id}`" class="border-t first:border-t-0" :data-habit="row.id">
            <p v-if="row.deleted" class="m-0 px-2 py-2.5 text-sm text-muted-foreground" data-habit-deleted>{{ t('habitDelivery.deleted') }}</p>
            <RouterLink v-else :to="itemEditPath(spaceId, row.item)" :title="row.item.content || row.item.title"
              class="grid select-none gap-1 rounded-md px-2 py-2.5 no-underline hover:bg-muted/60">
              <span class="line-clamp-2 text-sm font-medium text-foreground">{{ row.item.content || row.item.title }}</span>
              <span class="whitespace-nowrap text-xs text-muted-foreground" data-habit-scope>{{ scopeLabel(row.item.scope) }}</span>
            </RouterLink>
          </li>
        </ul>
        <p class="m-0 text-xs text-muted-foreground" data-habit-footnote>{{ t('habitDelivery.footnote') }}</p>
      </Card>
    </div>
  </section>
</template>
