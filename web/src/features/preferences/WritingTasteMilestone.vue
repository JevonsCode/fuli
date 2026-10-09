<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import { t } from '@/i18n'
import type { WritingTasteProfile } from '@/types'

const props = defineProps<{
  profile: WritingTasteProfile | null
}>()

const ready = computed(() => props.profile?.ready === true)
const title = computed(() => {
  if (props.profile?.status === 'active') {
    return t('writingTaste.milestone.activeTitle')
  }
  if (props.profile?.status === 'preview_ready') {
    return t('writingTaste.milestone.previewTitle')
  }
  return t('writingTaste.milestone.collectingTitle')
})
const copy = computed(() => ready.value
  ? t('writingTaste.milestone.readyCopy')
  : t('writingTaste.milestone.collectingCopy'))
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
  <section
    v-if="profile"
    class="writing-taste-milestone"
    :class="`status-${profile.status}`"
    :aria-label="t('writingTaste.milestone.aria')"
  >
    <div class="writing-taste-milestone__mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
    <div class="writing-taste-milestone__copy">
      <div class="writing-taste-milestone__heading">
        <h2>{{ title }}</h2>
        <span>{{ t(`writingTaste.status.${profile.status}`) }}</span>
      </div>
      <p>{{ copy }}</p>
      <div class="writing-taste-milestone__progress" aria-hidden="true">
        <i :style="{ transform: `scaleX(${progress / 100})` }" />
      </div>
      <div class="writing-taste-milestone__metrics">
        <small>
          {{ t('writingTaste.milestone.rules', {
            current: profile.readiness.rule_count,
            target: profile.readiness.thresholds.rule_count,
          }) }}
        </small>
        <small>
          {{ t('writingTaste.milestone.sessions', {
            current: profile.readiness.session_count,
            target: profile.readiness.thresholds.session_count,
          }) }}
        </small>
      </div>
    </div>
    <RouterLink class="writing-taste-milestone__action" to="/preferences/writing">
      {{ t('writingTaste.milestone.open') }}
      <span aria-hidden="true">→</span>
    </RouterLink>
  </section>
</template>

<style scoped>
.writing-taste-milestone {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin-top: 12px;
  padding: 14px 15px;
  border: 1px solid var(--color-border);
  border-radius: 11px;
  background: var(--color-surface);
  box-shadow: 0 7px 20px rgba(49, 66, 56, 0.04);
}

.writing-taste-milestone.status-preview_ready,
.writing-taste-milestone.status-active {
  border-color: var(--color-success-soft);
  background: var(--color-success-soft);
}

.writing-taste-milestone__mark {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: end;
  justify-content: center;
  gap: 3px;
  padding: 8px;
  border-radius: 10px;
  background: var(--color-surface-subtle);
}

.writing-taste-milestone__mark span {
  width: 5px;
  border-radius: 3px 3px 1px 1px;
  background: var(--color-muted);
}

.writing-taste-milestone__mark span:nth-child(1) { height: 9px; }
.writing-taste-milestone__mark span:nth-child(2) { height: 16px; }
.writing-taste-milestone__mark span:nth-child(3) { height: 23px; }

.writing-taste-milestone__copy {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.writing-taste-milestone__heading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.writing-taste-milestone h2,
.writing-taste-milestone p {
  margin: 0;
}

.writing-taste-milestone h2 {
  color: var(--color-ink);
  font-size: 14px;
}

.writing-taste-milestone__heading > span {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--color-surface-subtle);
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 750;
}

.writing-taste-milestone p {
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.5;
}

.writing-taste-milestone__progress {
  width: min(300px, 100%);
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--color-surface-subtle);
}

.writing-taste-milestone__progress i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--color-muted);
  transform-origin: left;
  transition: transform 180ms ease;
}

.writing-taste-milestone__metrics {
  display: flex;
  gap: 12px;
  color: var(--color-muted);
  font-size: 12px;
}

.writing-taste-milestone__action {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-control);
  color: var(--color-ink);
  background: var(--color-surface);
  text-decoration: none;
  font-size: 12px;
  font-weight: 750;
}

.writing-taste-milestone__action:hover {
  border-color: var(--color-muted);
  background: var(--color-surface);
}

@media (max-width: 760px) {
  .writing-taste-milestone {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .writing-taste-milestone__action {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
