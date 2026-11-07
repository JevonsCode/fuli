<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import NoticeRow from './NoticeRow.vue'
import { knownNotice, NOTICE_KINDS, noticePageShape, type Notice } from './notices'
import WorkbenchListHead from './WorkbenchListHead.vue'
import './workbench-card.css'

// Widget 'recent-notices' (Jevons 11-06): 「最近你可能需要知道的事」, what changed in
// the last two weeks that the person may want to know (a topic made into a project,
// what Dreaming found, a finished task's retrospective, what Tonborg confirmed, who joined or left, a model that
// stopped answering, a new version), each with its one quick way in. Seven show;
// 更多 opens the list's own page. With nothing to say, the card stays away.
const FEED_ROWS = 7

const items = ref<Notice[]>([])
const total = ref(0)
const state = ref<'loading' | 'ready' | 'failed'>('loading')

onMounted(async () => {
  try {
    // Only the kinds this console can word, so the count behind 更多 is the list's own.
    const query = new URLSearchParams({ limit: String(FEED_ROWS) })
    for (const kind of NOTICE_KINDS) query.append('kind', kind)
    const page = await getJson(`/api/notices?${query}`, noticePageShape)
    items.value = page.items.filter(knownNotice)
    total.value = page.total ?? items.value.length
    state.value = 'ready'
  } catch {
    // The workbench says nothing rather than show a broken card.
    state.value = 'failed'
  }
})
</script>

<template>
  <section v-if="state === 'loading' || items.length" class="workbench-card" aria-labelledby="recent-notices-heading" data-widget="recent-notices" data-list-morph="notices">
    <WorkbenchListHead id="recent-notices-heading" list="notices" :title="t('overview.notices.title')" :more="total - items.length" />
    <GrowthLoading v-if="state === 'loading'" variant="compact" :label="t('overview.notices.loading')" />
    <TransitionGroup v-else name="ui-list" tag="ul" class="workbench-rows">
      <li v-for="item in items" :key="item.id"><NoticeRow :item="item" /></li>
    </TransitionGroup>
  </section>
</template>
