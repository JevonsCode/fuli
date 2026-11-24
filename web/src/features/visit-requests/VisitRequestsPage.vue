<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import Breadcrumb from '@/components/Breadcrumb.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import VirtualDirectoryList from '@/components/VirtualDirectoryList.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { overviewTime } from '@/features/overview/overview-data'
import { useListPages, type ListSource } from '@/features/workbench-lists/useListPages'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'
import UiNotice from '@/ui/UiNotice.vue'
import VisitRequestDialog from './VisitRequestDialog.vue'
import { readVisitRequests } from './visit-request-api'
import { askerLine, failedLine, visitStateLabel } from './visit-request-model'
import type { VisitRequest } from './visit-request-shape'
import { useVisitPeek, visitRequestLocation } from './useVisitPeek'
import '@/features/overview/workbench-card.css'
import './visit-card.css'

// Every request other computers sent, newest first, not only the waiting ones:
// one compact row each (state in plain words, who asked and, for one that did
// not work, why; the title, when), the
// same card as 等你拍板 from its link (?item=visit/<id>). One read of the
// newest 200; older ones stay on the server, and a full read says so.
const LIST_READ = 200
const ROW_HEIGHT = 64
const WAITING = new Set(['awaiting_owner', 'awaiting_review'])

const peek = useVisitPeek()
const source = computed<ListSource<VisitRequest>>(() => ({ key: 'visit-requests', read: async () => {
  const answer = await readVisitRequests({ limit: LIST_READ })
  return { items: answer.requests, nextCursor: null, total: answer.requests.length }
} }))
const pages = useListPages(source)
const rows = computed(() => pages.items.value)
const firstRead = computed(() => pages.loading.value && !rows.value.length)
const cut = computed(() => rows.value.length >= LIST_READ)
</script>

<template>
  <section class="view visit-list-view" data-visit-list>
    <Breadcrumb :parent="{ label: t('routes.today.title'), to: '/', from: /^\/(?:[?#]|$)/ }" />
    <div class="workbench-card visit-list-card" :class="{ 'is-filled': rows.length }">
      <UiNotice v-if="pages.error.value" tone="error" data-visit-list-error>
        {{ t('visitRequests.list.failed') }}
        <template #actions><Button size="sm" variant="ghost" @click="pages.reload()">{{ t('visitRequests.list.retry') }}</Button></template>
      </UiNotice>
      <GrowthLoading v-if="firstRead" variant="compact" :label="t('visitRequests.list.loading')" />
      <p v-else-if="!rows.length && !pages.error.value" class="workbench-empty" data-visit-list-empty>{{ t('visitRequests.list.empty') }}</p>
      <VirtualDirectoryList v-if="rows.length" class="visit-list-rows" :items="rows" :row-height="ROW_HEIGHT"
        :label="t('visitRequests.list.title')" :item-key="row => row.id">
        <template #default="{ item }">
          <RouterLink :to="visitRequestLocation(item.id)" class="workbench-row visit-list-row" aria-haspopup="dialog" :data-visit-list-row="item.id"
            :data-return-focus="item.id">
            <span class="visit-mark" aria-hidden="true"><UiIcon name="roundtable" :size="16" /></span>
            <span class="workbench-row-text">
              <span class="workbench-row-title">{{ item.title }}</span>
              <span class="workbench-meta visit-list-meta" :title="failedLine(item) ?? undefined" data-visit-list-meta>
                {{ askerLine(item.requester) }}<template v-if="failedLine(item)"> · {{ failedLine(item) }}</template>
              </span>
            </span>
            <span class="visit-list-end">
              <Badge :variant="WAITING.has(item.state) ? 'default' : 'secondary'">{{ visitStateLabel(item) }}</Badge>
              <time class="workbench-meta" :datetime="item.createdAt">{{ overviewTime(item.createdAt) }}</time>
            </span>
          </RouterLink>
        </template>
      </VirtualDirectoryList>
      <p v-if="cut" class="workbench-meta visit-list-cut" data-visit-list-cut>{{ t('visitRequests.list.newestOnly', { count: LIST_READ }) }}</p>
    </div>
    <VisitRequestDialog :id="peek.id.value" @close="peek.close()" @changed="pages.reload()" />
  </section>
</template>

<style scoped>
.visit-list-view { display: flex; flex-direction: column; gap: 12px; overflow: hidden; padding-bottom: 96px !important; }
/* The card fills the page only when it has rows to scroll; empty, loading or failed it is as tall as its one line. */
.visit-list-card { display: flex; flex: 0 0 auto; flex-direction: column; gap: 10px; min-height: 0; padding-bottom: 6px; }
.visit-list-card.is-filled { flex: 1; }
.visit-list-rows { flex: 1; min-height: 0; margin: 0 -10px; }
.visit-list-row {
  height: 100%; padding: 0 10px; border-radius: 12px; color: inherit; text-decoration: none; user-select: none;
  transition: background var(--motion-fast);
}
.visit-list-row:hover { background: var(--color-surface-subtle); }
.visit-list-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visit-list-end { display: grid; justify-items: end; gap: 4px; }
.visit-list-cut { margin: 0; padding: 0 0 6px; }
@media (max-width: 860px) {
  .visit-list-view { padding-bottom: calc(112px + env(safe-area-inset-bottom)) !important; }
}
</style>
