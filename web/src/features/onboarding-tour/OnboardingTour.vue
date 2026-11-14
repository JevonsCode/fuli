<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useRouter } from 'vue-router'

import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { fuliMarkUrl } from '@/lib/brand'
import { useConsoleStore } from '@/stores/console'
import { UiDialog, UiIcon } from '@/ui'
import { TOUR_VERSION, endTour, pauseTour, startTour, stepTarget, tour, tourDue, tourSteps, type TourStepId } from './onboarding-tour'

// The beginner's guide (Jevons 11-12): a centred glass dialog, one step at a
// time, with Back / Next, 跳过 and the step's one 「去…」. It opens on its own
// once per tour version, only after the first-run dialog (the clients, start
// at login and the capture question) has closed, and the corner's what's-new
// notice waits until it closes. Closing it any way counts as seen; 「去…」
// counts too and leaves a corner notice to continue at that step
// (TourResumeNotice.vue). Every step is laid in the same grid cell, so the
// dialog keeps the height of the longest step and its buttons never move.
const store = useConsoleStore()
const router = useRouter()

if (!tour.offered) tour.deciding = true
watchEffect(() => {
  if (tour.offered) return
  if (!store.state) {
    if (store.runtimeStatus === 'error') tour.deciding = false
    return
  }
  if (store.firstRunDialogOpen) return
  tour.offered = true
  tour.deciding = false
  if (tourDue(store.state)) startTour()
})

const spaceId = computed(() => store.activePersonalSpace?.id ?? 'current')
const steps = computed(tourSteps)
const targets = computed(() => Object.fromEntries(steps.value.map(step => [step.id, stepTarget(step.id, spaceId.value)])) as Record<TourStepId, string | null>)
const last = computed(() => tour.step === steps.value.length - 1)
const progress = computed(() => t('onboardingTour.progress', {
  step: tour.step + 1, total: steps.value.length, title: t(`onboardingTour.steps.${steps.value[tour.step]!.id}.title`),
}))

function close() {
  endTour()
  void store.markTourSeen(TOUR_VERSION)
}

function next() {
  if (last.value) close()
  else tour.step += 1
}

function go(id: TourStepId) {
  const to = targets.value[id]
  if (!to) return
  pauseTour()
  void store.markTourSeen(TOUR_VERSION)
  void router?.push(to)
}
</script>

<template>
  <UiDialog :open="tour.open" :title="t('onboardingTour.title')" size="md" class="onboarding-tour" data-onboarding-tour @close="close">
    <p class="ui-sr-only" aria-live="polite" data-tour-progress>{{ progress }}</p>
    <ol class="tour-dots" aria-hidden="true">
      <li v-for="(step, index) in steps" :key="step.id" :data-current="index === tour.step || undefined" />
    </ol>
    <div class="tour-stage">
      <section v-for="(step, index) in steps" :key="step.id" class="tour-step" :class="{ 'is-current': index === tour.step }"
        :aria-hidden="index !== tour.step || undefined" :inert="index !== tour.step || undefined" :data-tour-step="step.id">
        <span class="tour-figure" aria-hidden="true">
          <img v-if="step.icon === 'brand'" :src="fuliMarkUrl" alt="" width="36" height="36" />
          <UiIcon v-else :name="step.icon" :size="26" />
        </span>
        <h3 class="tour-title">{{ t(`onboardingTour.steps.${step.id}.title`) }}</h3>
        <p class="tour-text">{{ t(`onboardingTour.steps.${step.id}.text`) }}</p>
        <!-- Every step keeps this row, so a step without a place is as tall as one with it. -->
        <span class="tour-go">
          <Button v-if="targets[step.id]" type="button" variant="outline" size="sm" :disabled="index !== tour.step"
            :data-tour-go="step.id" @click="go(step.id)">{{ t(`onboardingTour.steps.${step.id}.go`) }}</Button>
        </span>
      </section>
    </div>
    <template #footer>
      <Button type="button" variant="ghost" class="tour-skip" data-tour-skip @click="close">{{ t('onboardingTour.skip') }}</Button>
      <Button type="button" variant="outline" :disabled="tour.step === 0" data-tour-back @click="tour.step -= 1">{{ t('onboardingTour.back') }}</Button>
      <Button type="button" class="tour-next" autofocus data-tour-next @click="next">{{ t(last ? 'onboardingTour.done' : 'onboardingTour.next') }}</Button>
    </template>
  </UiDialog>
</template>

<style scoped>
/* It floats over the page, so it is the dock's frosted glass (docs/console-design.md). */
.onboarding-tour {
  border-color: var(--edge-glass); background: var(--glass-sheen), var(--surface-dock-panel); box-shadow: var(--shadow-glass);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
.onboarding-tour :deep(.ui-dialog__footer) { border-top-color: var(--edge-dock); background: transparent; }
.onboarding-tour :deep(button) { user-select: none; }
.tour-skip { margin-right: auto; }
/* 下一步 and 完成 take one width, so Back never shifts on the last step. */
.tour-next { min-width: 7em; }
.tour-dots { display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; }
.tour-dots li { width: 6px; height: 6px; border-radius: 999px; background: var(--color-border-strong); transition: transform var(--motion-medium) var(--motion-ease-out); }
.tour-dots li[data-current] { background: var(--color-ink); transform: scale(1.35); }
/* All steps share one cell: the stage is as tall as the longest step at this width. */
.tour-stage { display: grid; }
.tour-step {
  grid-area: 1 / 1; display: grid; align-content: start; justify-items: start; gap: 10px; min-width: 0;
  visibility: hidden; opacity: 0; transform: translateY(4px);
}
.tour-step.is-current {
  visibility: visible; opacity: 1; transform: none;
  transition: opacity var(--motion-medium) var(--motion-ease-out), transform var(--motion-medium) var(--motion-ease-out);
}
.tour-figure {
  display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 4px; border-radius: 16px;
  color: var(--color-ink); background: var(--surface-dock-panel); box-shadow: var(--shadow-glass);
}
.tour-title { margin: 0; color: var(--color-ink); font-size: 18px; font-weight: var(--weight-strong); }
.tour-text { max-width: var(--measure); margin: 0; color: var(--color-ink-soft); font-size: var(--text-body); line-height: 1.6; overflow-wrap: anywhere; }
.tour-go { display: flex; min-height: var(--control-height-sm); margin-top: 4px; }
</style>
