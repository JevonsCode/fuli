<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import { useAgentAttention } from '@/features/project-agents/attention-store'
import { useReviewList } from '@/features/review-list/review-store'
import { t } from '@/i18n'

// What the 待决策 tray holds, at a glance on hover (Jevons 11-06): how many things wait and the
// first three, Agents' requests first, then Tonborg's questions, then knowledge to confirm,
// each one line. The whole list is one click away; nothing is answered here.
const SHOWN = 3
const attention = useAgentAttention()
const review = useReviewList()

const total = computed(() => attention.total + review.total)
const lines = computed(() => [
  ...attention.previewItems.map(item => ({ key: `a:${item.requestId}`, tag: t('shell.peek.request'), text: item.title })),
  ...review.list.questions.map(line => ({ key: `q:${line.key}`, tag: t('shell.peek.question'), text: line.review?.question || line.text })),
  ...review.list.pending.map(line => ({ key: `p:${line.key}`, tag: t('shell.peek.confirm'), text: line.text })),
].slice(0, SHOWN))
const more = computed(() => Math.max(0, total.value - lines.value.length))
</script>

<template>
  <div class="header-peek-head">
    <span class="header-peek-title">{{ t('shell.sections.askedYou') }}</span>
    <span v-if="total" class="header-peek-meta" data-inbox-peek-count>{{ t('shell.peek.count', { count: total }) }}</span>
  </div>
  <ul v-if="lines.length" class="header-peek-list">
    <li v-for="line in lines" :key="line.key" class="header-peek-row" data-inbox-peek-line>
      <span class="header-peek-text" :title="line.text">{{ line.text }}</span>
      <span class="header-peek-tag">{{ line.tag }}</span>
    </li>
  </ul>
  <p v-else class="header-peek-empty" data-inbox-peek-empty>{{ t('shell.peek.empty') }}</p>
  <RouterLink v-if="total" to="/inbox" class="header-peek-go" data-inbox-peek-go>
    {{ more ? t('shell.peek.more', { count: more }) : t('shell.peek.go') }}
  </RouterLink>
</template>
