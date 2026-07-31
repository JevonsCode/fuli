<script setup lang="ts">
import { t } from '@/i18n'

defineProps<{
  focused: boolean
}>()
</script>

<template>
  <div
    class="quadrant-axis-system"
    :class="{ 'is-focused': focused }"
    aria-hidden="true"
  >
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <line x1="2" y1="50" x2="98" y2="50" />
      <line x1="50" y1="98" x2="50" y2="2" />
    </svg>
    <span class="quadrant-axis-arrow quadrant-axis-arrow-x" />
    <span class="quadrant-axis-arrow quadrant-axis-arrow-y" />
    <span class="axis-caption axis-caption-x">{{ t('knowledge.workspace.quadrant.axes.mastery') }}</span>
    <span class="axis-caption axis-caption-y">{{ t('knowledge.workspace.quadrant.axes.awareness') }}</span>
    <span class="axis-end axis-x-start">{{ t('knowledge.workspace.quadrant.axes.notMastered') }}</span>
    <span class="axis-end axis-x-end">{{ t('knowledge.workspace.quadrant.axes.mastered') }}</span>
    <span class="axis-end axis-y-start">{{ t('knowledge.workspace.quadrant.axes.unaware') }}</span>
    <span class="axis-end axis-y-end">{{ t('knowledge.workspace.quadrant.axes.aware') }}</span>
  </div>
</template>

<style scoped>
.quadrant-axis-system {
  position: absolute;
  z-index: 1;
  inset: 64px 18px 44px;
  color: #718077;
  opacity: 1;
  transform: scale(1) rotate(0);
  transform-origin: 50% 50%;
  transition:
    opacity .3s ease,
    transform .5s cubic-bezier(.22, 1, .36, 1);
}

.quadrant-axis-system.is-focused {
  opacity: 0;
  transform: scale(.82) rotate(-8deg);
  pointer-events: none;
}

.quadrant-axis-system svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.quadrant-axis-system line {
  stroke: #5f7467;
  stroke-linecap: round;
  stroke-width: 1.4;
  vector-effect: non-scaling-stroke;
}

.quadrant-axis-arrow {
  position: absolute;
  z-index: 2;
  width: 0;
  height: 0;
  display: block;
  pointer-events: none;
}

.quadrant-axis-arrow-x {
  top: 50%;
  left: 98%;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 7px solid #53695b;
  transform: translate(-7px, -50%);
}

.quadrant-axis-arrow-y {
  top: 2%;
  left: 50%;
  border-right: 4px solid transparent;
  border-bottom: 7px solid #53695b;
  border-left: 4px solid transparent;
  transform: translateX(-50%);
}

.axis-caption,
.axis-end {
  position: absolute;
  z-index: 3;
  padding: 2px 5px;
  border-radius: 4px;
  color: #5f7066;
  background: rgba(247, 249, 247, .96);
  font-size: 8px;
  font-weight: 700;
  white-space: nowrap;
}

.axis-caption-x {
  right: 0;
  bottom: -22px;
}

.axis-caption-y {
  top: -22px;
  left: 50%;
  transform: translateX(8px);
}

.axis-end {
  color: #75837b;
  font-size: 7px;
  font-weight: 650;
}

.axis-x-start {
  top: 50%;
  left: -2px;
  transform: translateY(8px);
}

.axis-x-end {
  top: 50%;
  right: -2px;
  transform: translateY(8px);
}

.axis-y-start {
  bottom: -22px;
  left: 50%;
  transform: translateX(8px);
}

.axis-y-end {
  top: -22px;
  left: 50%;
  transform: translateX(-42px);
}

@media (max-width: 1040px) {
  .quadrant-axis-system:not(.is-focused) {
    inset: 58px 12px 42px;
  }
}

@media (max-width: 760px) {
  .quadrant-axis-system:not(.is-focused) {
    inset: 58px 8px 42px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .quadrant-axis-system {
    transition: none;
  }
}
</style>
