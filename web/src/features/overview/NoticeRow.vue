<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import UiIcon from '@/ui/UiIcon.vue'
import BetaBadge from '@/components/BetaBadge.vue'
import { isBetaNotice, isProblemNotice, NOTICE_ICONS, noticeAction, noticeText, noticeTime, type Notice } from './notices'
import './workbench-card.css'

// One notice: what changed, when, and its one quick way in.
defineProps<{ item: Notice }>()
</script>

<template>
  <div class="workbench-row" :data-notice="item.kind">
    <span class="notice-mark" :class="{ 'is-problem': isProblemNotice(item) }" aria-hidden="true">
      <UiIcon :name="NOTICE_ICONS[item.kind]" :size="16" />
    </span>
    <div class="workbench-row-text">
      <p class="workbench-row-title workbench-clamp notice-text">{{ noticeText(item) }}</p>
      <span class="workbench-meta notice-meta"><time :datetime="item.at">{{ noticeTime(item) }}</time><BetaBadge v-if="isBetaNotice(item)" /></span>
    </div>
    <Button as-child variant="outline" size="sm"><RouterLink :to="item.href" data-notice-go>{{ noticeAction(item) }}</RouterLink></Button>
  </div>
</template>

<style scoped>
.notice-mark { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 11px; color: var(--color-ink-soft); background: var(--color-surface-subtle); }
.notice-mark.is-problem { color: var(--color-danger); background: var(--color-danger-soft); }
/* A notice reads in full up to two lines. */
.notice-text { white-space: normal; }
.notice-meta { display: flex; align-items: center; }
</style>
