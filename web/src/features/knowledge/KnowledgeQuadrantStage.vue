<script setup lang="ts">
import { gsap } from 'gsap'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import KnowledgeQuadrantAxisSystem from './KnowledgeQuadrantAxisSystem.vue'

import {
  quadrantDescription,
  quadrantLabel,
} from '@/features/knowledge/model'

type QuadrantValue =
  | 'known_known'
  | 'known_unknown'
  | 'unknown_known'
  | 'unknown_unknown'

type QuadrantChoice = {
  value: QuadrantValue
  short: string
  coordinate: string
}

const props = defineProps<{
  choices: readonly QuadrantChoice[]
  counts: Record<string, number>
  activeQuadrant: string
}>()

const emit = defineEmits<{
  select: [value: QuadrantValue]
}>()

const stage = ref<HTMLElement | null>(null)
const reduceMotion = ref(false)
const coordinateTurn = ref(0)
const focusedChoice = computed(
  () => props.choices.find(({ value }) => value === props.activeQuadrant) ?? null,
)
const focused = computed(() => Boolean(focusedChoice.value))
const coordinateMotionReady = ref(focused.value)
const quadrantTurns: Record<QuadrantValue, number> = {
  known_unknown: 0,
  known_known: -90,
  unknown_known: 180,
  unknown_unknown: 90,
}
const compactRadius = {
  x: 40,
  y: 24,
}
const compactBasePoints: Record<QuadrantValue, { x: number, y: number }> = {
  known_unknown: { x: -compactRadius.x, y: -compactRadius.y },
  known_known: { x: compactRadius.x, y: -compactRadius.y },
  unknown_unknown: { x: -compactRadius.x, y: compactRadius.y },
  unknown_known: { x: compactRadius.x, y: compactRadius.y },
}
const compactCoordinateStyle = computed<Record<string, string>>(() => ({
  '--coordinate-turn': `${coordinateTurn.value}deg`,
  '--counter-turn': `${-coordinateTurn.value}deg`,
}))
let motion: ReturnType<typeof gsap.to> | null = null
let motionPreference: MediaQueryList | null = null
let motionSequence = 0
let stageTransitioning = false

watch(
  () => props.activeQuadrant,
  (value, previous) => {
    if (!isQuadrantValue(value)) {
      coordinateMotionReady.value = false
      return
    }

    if (previous === undefined || previous === 'all') {
      coordinateMotionReady.value = false
      coordinateTurn.value = quadrantTurns[value]
      if (!stageTransitioning) {
        void nextTick(() => {
          if (props.activeQuadrant === value) {
            coordinateMotionReady.value = true
          }
        })
      }
      return
    }

    coordinateMotionReady.value = true
    coordinateTurn.value = nearestEquivalentTurn(
      coordinateTurn.value,
      quadrantTurns[value],
    )
  },
  { immediate: true },
)

onMounted(() => {
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
  syncMotionPreference()
  motionPreference.addEventListener('change', syncMotionPreference)
})

onBeforeUnmount(() => {
  motionSequence += 1
  motion?.kill()
  if (motionPreference) {
    motionPreference.removeEventListener('change', syncMotionPreference)
  }
})

function syncMotionPreference() {
  reduceMotion.value = motionPreference?.matches ?? false
}

function compactCardStyle(value: QuadrantValue) {
  const point = compactBasePoints[value]
  const radians = coordinateTurn.value * Math.PI / 180
  const cosine = Math.round(Math.cos(radians))
  const sine = Math.round(Math.sin(radians))
  const signX = point.x / compactRadius.x
  const signY = point.y / compactRadius.y
  const targetX = compactRadius.x * (cosine * signX - sine * signY)
  const targetY = compactRadius.y * (sine * signX + cosine * signY)
  const localX = cosine * targetX + sine * targetY
  const localY = -sine * targetX + cosine * targetY

  return {
    '--compact-correction-x': `${Math.round(localX - point.x)}px`,
    '--compact-correction-y': `${Math.round(localY - point.y)}px`,
  }
}

async function selectQuadrant(value: QuadrantValue) {
  const previous = props.activeQuadrant
  const next = previous === value ? 'all' : value
  const stageElement = stage.value

  if (previous !== 'all' && next !== 'all') {
    emit('select', value)
    return
  }

  if (reduceMotion.value || !stageElement) {
    emit('select', value)
    return
  }

  stageTransitioning = true
  const sequence = ++motionSequence
  motion?.kill()
  gsap.killTweensOf(stageElement)
  gsap.set(stageElement, {
    pointerEvents: 'none',
    transformOrigin: '50% 50%',
  })

  await runStageTween(stageElement, {
    autoAlpha: 0,
    duration: 0.14,
    ease: 'power2.in',
    rotation: previous === 'all' ? -0.8 : 0.8,
    scale: 0.985,
    y: previous === 'all' ? -3 : 3,
  })

  if (sequence !== motionSequence) {
    stageTransitioning = false
    return
  }
  emit('select', value)
  await nextTick()

  if (sequence !== motionSequence || !stage.value) {
    stageTransitioning = false
    return
  }
  const currentStage = stage.value
  gsap.set(currentStage, {
    autoAlpha: 0,
    pointerEvents: 'none',
    rotation: next === 'all' ? 0.8 : -0.8,
    scale: next === 'all' ? 0.992 : 1.012,
    transformOrigin: '50% 50%',
    y: next === 'all' ? 3 : -3,
  })

  await runStageTween(currentStage, {
    autoAlpha: 1,
    duration: 0.3,
    ease: 'power3.out',
    rotation: 0,
    scale: 1,
    y: 0,
  })

  if (sequence !== motionSequence) {
    stageTransitioning = false
    return
  }
  gsap.set(currentStage, {
    clearProps: 'opacity,visibility,transform,transformOrigin,pointerEvents',
  })
  stageTransitioning = false
  coordinateMotionReady.value = next !== 'all'
}

function nearestEquivalentTurn(current: number, target: number) {
  const clockwiseDelta = ((target - current) % 360 + 360) % 360
  const shortestDelta = clockwiseDelta > 180
    ? clockwiseDelta - 360
    : clockwiseDelta
  return current + shortestDelta
}

function isQuadrantValue(value: string): value is QuadrantValue {
  return Object.prototype.hasOwnProperty.call(quadrantTurns, value)
}

function runStageTween(
  target: HTMLElement,
  vars: gsap.TweenVars,
) {
  return new Promise<void>((resolve) => {
    motion = gsap.to(target, {
      ...vars,
      onComplete: resolve,
      onInterrupt: resolve,
    })
  })
}
</script>

<template>
  <section
    ref="stage"
    class="quadrant-stage"
    :class="{ 'is-focused': focused }"
    aria-label="知识发现四象限"
  >
    <div class="quadrant-stage-header">
      <div class="quadrant-stage-copy" aria-live="polite">
        <span>{{ focused ? 'FOCUS MODE' : 'DISCOVERY MAP' }}</span>
        <strong v-if="focusedChoice">
          正在查看 {{ quadrantLabel(focusedChoice.value) }}
        </strong>
        <strong v-else>点击一个象限，进入聚焦整理</strong>
        <small>
          {{ focused
            ? '选择其他象限可直接切换；再次点击当前象限返回全局。'
            : '横轴表示是否掌握，纵轴表示是否意识到。' }}
        </small>
      </div>
      <button
        v-if="focusedChoice"
        class="quadrant-reset"
        type="button"
        aria-label="返回四象限"
        title="返回四象限"
        @click="selectQuadrant(focusedChoice.value)"
      >
        全局
      </button>
    </div>

    <KnowledgeQuadrantAxisSystem :focused="focused" />

    <div
      class="quadrant-matrix"
      :class="{ 'coordinate-motion-ready': focused && coordinateMotionReady }"
      :style="focused ? compactCoordinateStyle : undefined"
    >
      <span class="compact-axis" aria-hidden="true">
        <i class="compact-axis-line compact-axis-x" />
        <i class="compact-axis-line compact-axis-y" />
        <i class="compact-axis-origin" />
      </span>
      <button
        v-for="(choice, index) in choices"
        :key="choice.value"
        type="button"
        class="quadrant-card"
        :class="[
          choice.value,
          {
            'matrix-card': !focused,
            'active-card': activeQuadrant === choice.value,
          },
        ]"
        :style="focused ? compactCardStyle(choice.value) : undefined"
        :data-quadrant="choice.value"
        :aria-pressed="activeQuadrant === choice.value"
        @click="selectQuadrant(choice.value)"
      >
        <span class="quadrant-card-face">
          <span class="quadrant-card-topline">
            <span>{{ choice.coordinate }}</span>
            <b>{{ String(index + 1).padStart(2, '0') }}</b>
          </span>
          <span class="quadrant-card-title">
            <strong>{{ quadrantLabel(choice.value) }}</strong>
            <em>{{ counts[choice.value] ?? 0 }}</em>
          </span>
          <span class="quadrant-card-short">{{ choice.short }}</span>
          <span class="quadrant-card-description">
            {{ quadrantDescription(choice.value) }}
          </span>
          <span class="quadrant-card-action">
            {{ activeQuadrant === choice.value ? '再次点击返回全局' : '点击聚焦' }}
            <i aria-hidden="true">↗</i>
          </span>
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.quadrant-stage {
  position: relative;
  min-height: 392px;
  padding: 64px 56px 44px;
  border: 1px solid #d4dbd5;
  border-radius: 12px;
  overflow: hidden;
  isolation: isolate;
  background:
    radial-gradient(circle at 50% 50%, rgba(255, 255, 255, .94) 0 24%, transparent 58%),
    linear-gradient(135deg, #f8faf8 0%, #f3f6f3 100%);
}

.quadrant-stage::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image: radial-gradient(circle, rgba(75, 96, 83, .12) .7px, transparent .8px);
  background-size: 15px 15px;
  content: '';
  mask-image: linear-gradient(to bottom, rgba(0, 0, 0, .64), transparent 92%);
}

.quadrant-stage.is-focused {
  min-height: 74px;
  padding: 0 48px 0 0;
  border: 0;
  border-radius: 0;
  overflow: visible;
  background: transparent;
}

.quadrant-stage.is-focused::before {
  display: none;
}

.quadrant-stage-header {
  position: absolute;
  z-index: 5;
  top: 14px;
  right: 20px;
  left: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  pointer-events: none;
}

.quadrant-stage-copy {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 2px 9px;
}

.quadrant-stage-copy > span {
  color: #7a887f;
  font-size: 8px;
  font-weight: 760;
  letter-spacing: .12em;
}

.quadrant-stage-copy > strong {
  overflow: hidden;
  color: #35443b;
  font-size: 11px;
  font-weight: 680;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quadrant-stage-copy > small {
  grid-column: 2;
  overflow: hidden;
  color: #859088;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quadrant-reset {
  flex: 0 0 auto;
  padding: 5px 8px;
  border: 1px solid #ccd5ce;
  border-radius: 6px;
  color: #516158;
  background: rgba(255, 255, 255, .82);
  font-size: 8px;
  font-weight: 650;
  pointer-events: auto;
}

.quadrant-reset:hover {
  border-color: #91a397;
  background: #fff;
}

.is-focused .quadrant-stage-header {
  inset: 0 2px 0 auto;
  width: 42px;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.is-focused .quadrant-stage-copy {
  display: none;
}

.is-focused .quadrant-reset {
  width: 38px;
  height: 32px;
  padding: 0 4px;
  border-color: #d2d9d3;
  color: #647169;
  background: rgba(255, 255, 255, .82);
  font-size: 8px;
  line-height: 1;
}

.quadrant-matrix {
  position: relative;
  z-index: 2;
  min-height: 282px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(126px, 1fr));
  grid-template-areas:
    'known-unknown known-known'
    'unknown-unknown unknown-known';
  gap: 30px 32px;
}

.compact-axis {
  display: none;
}

.is-focused .quadrant-matrix {
  width: 170px;
  height: 74px;
  min-height: 0;
  display: block;
  margin: 0 8px 0 auto;
  transform: rotate(var(--coordinate-turn));
  transform-origin: 50% 50%;
  transition: none;
}

.is-focused .quadrant-matrix.coordinate-motion-ready {
  transition: transform .56s cubic-bezier(.22, 1, .36, 1);
}

.is-focused .compact-axis {
  position: absolute;
  z-index: 0;
  inset: 6px 54px;
  display: block;
  pointer-events: none;
}

.compact-axis-line {
  position: absolute;
  display: block;
  border-radius: 999px;
  background: #73837a;
  opacity: .76;
}

.compact-axis-x {
  top: 50%;
  right: 0;
  left: 0;
  height: 1px;
  transform: translateY(-50%);
}

.compact-axis-y {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
}

.compact-axis-x::after,
.compact-axis-y::after {
  position: absolute;
  width: 0;
  height: 0;
  content: '';
}

.compact-axis-x::after {
  top: 50%;
  right: -1px;
  border-top: 3px solid transparent;
  border-bottom: 3px solid transparent;
  border-left: 5px solid #65776c;
  transform: translateY(-50%);
}

.compact-axis-y::after {
  top: -1px;
  left: 50%;
  border-right: 3px solid transparent;
  border-bottom: 5px solid #65776c;
  border-left: 3px solid transparent;
  transform: translateX(-50%);
}

.compact-axis-origin {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 5px;
  height: 5px;
  display: block;
  border: 1px solid rgba(87, 108, 95, .42);
  border-radius: 50%;
  background: #f8faf8;
  box-shadow: 0 0 0 3px rgba(242, 246, 243, .86);
  transform: translate(-50%, -50%);
}

.quadrant-card {
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: 9px;
  color: inherit;
  background: transparent;
  text-align: left;
}

.quadrant-card.known_known {
  grid-area: known-known;
  --quadrant-accent: #4f7c62;
  --quadrant-border: #cbdccf;
  --quadrant-surface: rgba(244, 250, 246, .94);
}

.quadrant-card.known_unknown {
  grid-area: known-unknown;
  --quadrant-accent: #8b6b2f;
  --quadrant-border: #e1d6bb;
  --quadrant-surface: rgba(252, 249, 240, .95);
}

.quadrant-card.unknown_known {
  grid-area: unknown-known;
  --quadrant-accent: #586d88;
  --quadrant-border: #d0d9e4;
  --quadrant-surface: rgba(245, 248, 252, .95);
}

.quadrant-card.unknown_unknown {
  grid-area: unknown-unknown;
  --quadrant-accent: #7c617a;
  --quadrant-border: #dfd2dd;
  --quadrant-surface: rgba(251, 246, 250, .95);
}

.quadrant-card-face {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: grid;
  grid-template-rows: auto auto auto 1fr auto;
  gap: 4px;
  padding: 15px 17px 13px;
  border: 1px solid var(--quadrant-border);
  border-radius: inherit;
  background: var(--quadrant-surface);
  box-shadow: 0 2px 8px rgba(54, 70, 59, .035);
  transition:
    border-color .18s ease,
    box-shadow .18s ease,
    background-color .18s ease;
}

.quadrant-card:hover .quadrant-card-face {
  border-color: var(--quadrant-accent);
  box-shadow: 0 8px 22px rgba(54, 70, 59, .1);
}

.quadrant-card:focus-visible {
  outline: 2px solid var(--quadrant-accent);
  outline-offset: 3px;
}

.quadrant-card.active-card .quadrant-card-face {
  padding: 17px 18px 13px;
  border-color: var(--quadrant-accent);
  background: color-mix(in srgb, var(--quadrant-surface) 88%, #fff);
  box-shadow: 0 12px 28px rgba(54, 70, 59, .12);
}

.quadrant-card-topline,
.quadrant-card-title,
.quadrant-card-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.quadrant-card-topline {
  color: var(--quadrant-accent);
  font-size: 8px;
  font-weight: 720;
  letter-spacing: .06em;
}

.quadrant-card-topline b {
  font: 650 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: .62;
}

.quadrant-card-title strong {
  color: #303c35;
  font-size: 15px;
  font-weight: 690;
}

.quadrant-card-title em {
  min-width: 29px;
  display: grid;
  place-items: center;
  padding: 3px 5px;
  border-radius: 999px;
  color: var(--quadrant-accent);
  background: rgba(255, 255, 255, .72);
  font-size: 10px;
  font-style: normal;
  font-weight: 720;
}

.active-card .quadrant-card-title strong {
  font-size: 17px;
}

.active-card .quadrant-card-title em {
  min-width: 31px;
  font-size: 11px;
}

.quadrant-card-short {
  color: #59655e;
  font-size: 10px;
  font-weight: 650;
}

.quadrant-card-description {
  color: #748078;
  font-size: 9px;
  line-height: 1.5;
}

.quadrant-card-action {
  align-self: end;
  color: var(--quadrant-accent);
  font-size: 8px;
  font-weight: 650;
  opacity: 0;
  transition: opacity .18s ease;
}

.quadrant-card-action i {
  font-size: 10px;
  font-style: normal;
}

.quadrant-card:hover .quadrant-card-action,
.quadrant-card.active-card .quadrant-card-action {
  opacity: 1;
}

.is-focused .quadrant-card {
  position: absolute;
  z-index: 1;
  width: 78px;
  height: 26px;
  border-radius: 6px;
  transform:
    translate(
      var(--compact-correction-x, 0),
      var(--compact-correction-y, 0)
    )
    rotate(var(--counter-turn));
  transform-origin: 50% 50%;
  transition: none;
}

.is-focused .coordinate-motion-ready .quadrant-card {
  transition: transform .56s cubic-bezier(.22, 1, .36, 1);
}

.is-focused .quadrant-card.known_unknown {
  top: 0;
  left: 6px;
}

.is-focused .quadrant-card.known_known {
  top: 0;
  right: 6px;
}

.is-focused .quadrant-card.unknown_unknown {
  bottom: 0;
  left: 6px;
}

.is-focused .quadrant-card.unknown_known {
  right: 6px;
  bottom: 0;
}

.is-focused .quadrant-card-face,
.is-focused .quadrant-card.active-card .quadrant-card-face {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  padding: 3px 2px;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.is-focused .quadrant-card-face::before {
  width: 4px;
  height: 4px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--quadrant-accent);
  content: '';
  opacity: .66;
  transition:
    width .18s ease,
    border-radius .18s ease,
    opacity .18s ease;
}

.is-focused .quadrant-card:hover .quadrant-card-face {
  background: color-mix(in srgb, var(--quadrant-surface) 54%, transparent);
  box-shadow: none;
}

.is-focused .quadrant-card.active-card .quadrant-card-face {
  background: color-mix(in srgb, var(--quadrant-surface) 74%, transparent);
  box-shadow: 0 2px 8px rgba(54, 70, 59, .055);
}

.is-focused .quadrant-card.active-card .quadrant-card-face::before {
  width: 7px;
  border-radius: 999px;
  opacity: 1;
}

.is-focused .quadrant-card:focus-visible {
  outline: none;
}

.is-focused .quadrant-card:focus-visible .quadrant-card-face {
  box-shadow:
    inset 0 -1px var(--quadrant-accent),
    0 2px 8px rgba(54, 70, 59, .055);
}

.is-focused .quadrant-card-topline,
.is-focused .quadrant-card-short,
.is-focused .quadrant-card-description,
.is-focused .quadrant-card-action {
  display: none;
}

.is-focused .quadrant-card-title {
  width: auto;
  min-width: 0;
  flex: 1 1 auto;
  gap: 3px;
}

.is-focused .quadrant-card-title strong,
.is-focused .quadrant-card.active-card .quadrant-card-title strong {
  min-width: 0;
  overflow: hidden;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.is-focused .quadrant-card-title em,
.is-focused .quadrant-card.active-card .quadrant-card-title em {
  min-width: 14px;
  box-sizing: border-box;
  flex: 0 0 auto;
  padding: 0;
  border-radius: 0;
  background: transparent;
  font-size: 7px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

@media (max-width: 1040px) {
  .quadrant-stage:not(.is-focused) {
    min-height: 360px;
    padding: 58px 42px 42px;
  }

  .quadrant-stage:not(.is-focused) .quadrant-matrix {
    min-height: 258px;
    grid-template-rows: repeat(2, minmax(116px, 1fr));
    gap: 26px 18px;
  }

}

@media (max-width: 760px) {
  .quadrant-stage:not(.is-focused) {
    min-height: 360px;
    padding: 58px 34px 42px;
  }

  .quadrant-stage:not(.is-focused) .quadrant-matrix {
    min-height: 258px;
    gap: 26px 16px;
  }

  .quadrant-stage:not(.is-focused) .quadrant-card-face {
    padding: 12px 13px 11px;
  }

  .quadrant-stage.is-focused {
    min-height: 74px;
    padding: 0 44px 0 0;
  }

  .is-focused .quadrant-stage-header {
    inset: 0 1px 0 auto;
    width: 34px;
  }

  .is-focused .quadrant-reset {
    width: 34px;
  }

  .is-focused .quadrant-matrix {
    width: 170px;
    height: 74px;
  }

  .is-focused .compact-axis {
    inset: 6px 54px;
  }

  .is-focused .quadrant-card {
    width: 78px;
    height: 26px;
  }

  .quadrant-stage-copy > small {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .quadrant-stage,
  .quadrant-matrix,
  .quadrant-card,
  .quadrant-card-face,
  .quadrant-card-action {
    transition: none;
  }
}
</style>
