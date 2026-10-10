<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import { t } from '@/i18n'
import type { WritingTasteProfile } from '@/types'

const props = defineProps<{
  profile: WritingTasteProfile | null
}>()

const title = computed(() => {
  if (props.profile?.status === 'active') {
    return t('writingTaste.milestone.activeTitle')
  }
  if (props.profile?.status === 'preview_ready') {
    return t('writingTaste.milestone.previewTitle')
  }
  return t('writingTaste.milestone.collectingTitle')
})
const progress = computed(() => {
  const readiness = props.profile?.readiness
  if (!readiness) return 0
  const ratios = [
    ratio(readiness.rule_count, readiness.thresholds.rule_count),
    ratio(readiness.evidence_count, readiness.thresholds.evidence_count),
    ratio(readiness.session_count, readiness.thresholds.session_count),
    ratio(readiness.observation_day_count, readiness.thresholds.observation_day_count),
  ]
  return Math.round(ratios.reduce((sum, value) => sum + value, 0) / ratios.length * 100)
})

function ratio(current: number, target: number) {
  if (target <= 0) return 1
  return Math.min(Math.max(current / target, 0), 1)
}
</script>

<template>
  <RouterLink
    v-if="profile"
    to="/preferences/writing"
    class="writing-taste-milestone"
    :class="`status-${profile.status}`"
    :aria-label="t('writingTaste.milestone.aria')"
  >
    <strong>{{ title }}</strong>
    <span class="writing-taste-milestone__progress" aria-hidden="true"><i :style="{ transform: `scaleX(${progress / 100})` }" /></span>
    <small>
      {{ t('writingTaste.milestone.rules', { current: profile.readiness.rule_count, target: profile.readiness.thresholds.rule_count }) }}
      · {{ t('writingTaste.milestone.sessions', { current: profile.readiness.session_count, target: profile.readiness.thresholds.session_count }) }}
    </small>
    <span class="writing-taste-milestone__action">{{ t('writingTaste.milestone.open') }} →</span>
  </RouterLink>
</template>

<style scoped>
.writing-taste-milestone {
  display: grid; grid-template-columns: auto 120px auto 1fr; align-items: center; gap: 14px;
  margin-bottom: 18px; padding: 10px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card);
  color: var(--color-ink); background: var(--color-surface); text-decoration: none; font-size: 13px;
  transition: border-color var(--motion-fast);
}
.writing-taste-milestone:hover { border-color: var(--color-border-strong); }
.writing-taste-milestone strong { font-weight: 600; }
.writing-taste-milestone small { color: var(--color-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.writing-taste-milestone__progress { height: 4px; overflow: hidden; border-radius: 2px; background: var(--color-surface-subtle); }
.writing-taste-milestone__progress i { display: block; height: 100%; background: var(--color-accent); transform-origin: left; }
.writing-taste-milestone__action { justify-self: end; color: var(--color-accent); font-size: 13px; font-weight: 550; }
.status-preview_ready, .status-active { border-color: var(--color-accent-line); background: var(--color-accent-soft); }
@media (max-width: 720px) { .writing-taste-milestone { grid-template-columns: 1fr auto; } .writing-taste-milestone__progress, .writing-taste-milestone small { grid-column: 1 / -1; } }
</style>
