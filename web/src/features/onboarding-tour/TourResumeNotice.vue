<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { UiIconButton } from '@/ui'
import { endTour, resumeTour, tour } from './onboarding-tour'

// After a beginner's guide step's 「去…」, the guide waits here at the bottom
// right, above the dock (layouts/CornerNotices.vue): 「继续」 opens it again at
// that step, ✕ ends it. It lasts this console open only; 设置 › 系统 › 界面
// 「再看一遍」 starts the guide again from step 1.
</script>

<template>
  <Transition name="tour-resume">
    <section v-if="tour.paused && !tour.open" class="tour-resume" role="status" data-tour-resume>
      <p class="tour-resume-text">{{ t('onboardingTour.paused', { step: tour.step + 1 }) }}</p>
      <Button type="button" size="sm" variant="outline" data-tour-resume-continue @click="resumeTour">{{ t('onboardingTour.resume') }}</Button>
      <UiIconButton icon="close" size="sm" :label="t('common.actions.close')" data-tour-resume-close @click="endTour" />
    </section>
  </Transition>
</template>

<style scoped>
/* Glass, like what's new beside it; one row, so 继续 and ✕ share its centre line. */
.tour-resume {
  display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 16px; border: 1px solid var(--edge-dock); border-radius: var(--radius-card, 12px);
  color: var(--color-ink); background: var(--glass-sheen), var(--surface-dock); box-shadow: var(--shadow-glass);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
.tour-resume-text { flex: 1; min-width: 0; margin: 0; overflow: hidden; font-size: var(--text-control); text-overflow: ellipsis; white-space: nowrap; }
.tour-resume :deep(button) { user-select: none; }
.tour-resume-enter-active, .tour-resume-leave-active { transition: opacity var(--motion-medium) var(--motion-ease), transform var(--motion-medium) var(--motion-ease); }
.tour-resume-enter-from, .tour-resume-leave-to { opacity: 0; transform: translateY(16px); }
</style>
