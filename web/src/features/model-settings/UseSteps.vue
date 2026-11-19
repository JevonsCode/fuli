<script setup lang="ts">
import { UiIcon } from '@/ui'
import type { UseStep } from './use-steps'

// How a model use works, as numbered steps in its 「查看详情」 (rec issue 143). A
// step the server reported shows its state: the running one is marked and,
// with a count of a total, fills a bar; a done one gets a check; a failed one
// says why in its line.
defineProps<{ steps: readonly UseStep[]; label: string }>()
const percent = (progress: NonNullable<UseStep['progress']>) =>
  (progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0)
</script>

<template>
  <ol class="use-steps" :aria-label="label" data-use-steps>
    <li v-for="(step, index) in steps" :key="step.id" class="use-step" :class="step.state && `is-${step.state}`"
      :data-use-step="step.id" :data-state="step.state ?? 'idle'" :aria-current="step.state === 'active' ? 'step' : undefined">
      <span class="use-step-mark" aria-hidden="true">
        <UiIcon v-if="step.state === 'done'" name="check" :size="12" />
        <template v-else>{{ index + 1 }}</template>
      </span>
      <div class="use-step-body">
        <p class="use-step-title">{{ step.title }}</p>
        <p class="use-step-detail" :role="step.state === 'failed' ? 'alert' : step.state === 'active' ? 'status' : undefined" data-use-step-detail>{{ step.detail }}</p>
        <div v-if="step.state === 'active' && step.progress" class="use-step-bar" role="progressbar" :aria-valuenow="step.progress.done"
          aria-valuemin="0" :aria-valuemax="step.progress.total" :aria-label="step.title" data-use-step-progress>
          <span :style="{ inlineSize: `${percent(step.progress)}%` }" />
        </div>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.use-steps { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; font-size: var(--text-control); }
.use-step { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: var(--space-3); align-items: start; }
.use-step-mark {
  display: inline-grid; place-items: center; inline-size: 20px; block-size: 20px; border: 1px solid var(--color-border-strong); border-radius: 50%;
  color: var(--color-muted); font-size: var(--text-meta); font-variant-numeric: tabular-nums; user-select: none;
  transition: background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast);
}
.use-step.is-active .use-step-mark { border-color: var(--color-gold); color: var(--color-gold); }
.use-step.is-done .use-step-mark { border-color: var(--color-gold); background: var(--color-gold); color: var(--color-surface); }
.use-step.is-failed .use-step-mark { border-color: var(--color-danger); color: var(--color-danger); }
.use-step-body { display: grid; gap: 2px; min-width: 0; }
.use-step-title { margin: 0; color: var(--color-ink); font-weight: var(--weight-medium); line-height: 20px; }
.use-step-detail { margin: 0; color: var(--color-muted); overflow-wrap: anywhere; }
.use-step.is-failed .use-step-detail { color: var(--color-danger); }
.use-step-bar { overflow: hidden; block-size: 4px; margin-top: 4px; border-radius: 2px; background: color-mix(in srgb, var(--color-gold) 18%, transparent); }
.use-step-bar span { display: block; block-size: 100%; border-radius: inherit; background: var(--color-gold); transition: inline-size var(--motion-move); }
</style>
