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
        <i :style="{ width: `${progress}%` }" />
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
    <RouterLink v-if="ready" class="writing-taste-milestone__action" to="/preferences/writing">
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
  border: 1px solid #d8dfda;
  border-radius: 11px;
  background: #f7f9f7;
  box-shadow: 0 7px 20px rgba(49, 66, 56, 0.04);
}

.writing-taste-milestone.status-preview_ready,
.writing-taste-milestone.status-active {
  border-color: #cbd9d0;
  background: #f4f8f5;
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
  background: #e4ebe6;
}

.writing-taste-milestone__mark span {
  width: 5px;
  border-radius: 3px 3px 1px 1px;
  background: #668372;
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
  color: #304138;
  font-size: 14px;
}

.writing-taste-milestone__heading > span {
  padding: 2px 7px;
  border-radius: 999px;
  background: #e2e9e4;
  color: #5c7064;
  font-size: 9px;
  font-weight: 750;
}

.writing-taste-milestone p {
  color: #707b74;
  font-size: 10px;
  line-height: 1.5;
}

.writing-taste-milestone__progress {
  width: min(300px, 100%);
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: #e0e5e1;
}

.writing-taste-milestone__progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #6f8e7c;
  transition: width 180ms ease;
}

.writing-taste-milestone__metrics {
  display: flex;
  gap: 12px;
  color: #7c857f;
  font-size: 9px;
}

.writing-taste-milestone__action {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  border: 1px solid #bdcbc2;
  border-radius: 8px;
  color: #395347;
  background: #fff;
  text-decoration: none;
  font-size: 10px;
  font-weight: 750;
}

.writing-taste-milestone__action:hover {
  border-color: #8fa697;
  background: #f9fbf9;
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
