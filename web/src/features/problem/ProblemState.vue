<script setup lang="ts">
import { watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiIcon } from '@/ui'
import CopyFixPrompt from './CopyFixPrompt.vue'

// What a page or section shows when it cannot do its job: centred in the
// space it would have filled, one headline, one plain sentence, the error
// itself folded away, and two ways forward: read again, or copy the problem
// for the person's own AI. Never a thin strip on an empty page.
const props = defineProps<{
  title: string
  detail?: string
  /** The raw error, folded under 错误信息 and carried into the copied prompt. */
  error?: string | null
  /** A retry is running: the button waits and says so. */
  retrying?: boolean
  /** What the retry is reading, for its loading label. */
  retryingLabel?: string
}>()
const emit = defineEmits<{ retry: [] }>()

// While shown it is the one place the problem is said: the shell's error line
// would only repeat it (a retry that fails again included).
const store = useConsoleStore()
watch(() => store.feedback, (feedback) => { if (feedback?.tone === 'error') store.clearFeedback() }, { immediate: true })
</script>

<template>
  <section class="problem-state" role="alert" data-problem-state>
    <div class="problem-body">
      <span class="problem-plate" aria-hidden="true"><UiIcon name="warning" :size="22" /></span>
      <h2 class="problem-title">{{ title }}</h2>
      <p v-if="detail" class="problem-detail">{{ detail }}</p>
      <div class="problem-actions">
        <Button :disabled="retrying" data-problem-retry @click="emit('retry')">
          <GrowthLoading v-if="retrying" variant="inline" :label="retryingLabel || t('problem.retry')" />
          <template v-else>{{ t('problem.retry') }}</template>
        </Button>
        <CopyFixPrompt :what="props.title" :error="error" size="default" />
      </div>
      <details v-if="error" class="problem-error">
        <summary>{{ t('problem.errorDetails') }}</summary>
        <code>{{ error }}</code>
      </details>
    </div>
  </section>
</template>

<style scoped>
/* Fills the area it stands in for and sits in its middle. */
.problem-state {
  display: grid; flex: 1 1 auto; place-items: center; width: 100%; min-height: min(420px, 100%);
  padding: 40px 24px; border-radius: var(--radius-shell); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border);
}
.problem-body { display: grid; justify-items: center; gap: 10px; max-width: 440px; text-align: center; }
.problem-plate {
  display: grid; width: 48px; height: 48px; margin-bottom: 6px; place-items: center; border-radius: 12px;
  color: var(--color-warning); background: var(--color-warning-soft);
}
.problem-title { margin: 0; color: var(--color-ink); font-size: var(--text-card-title); font-weight: var(--weight-strong); }
.problem-detail { margin: 0; color: var(--color-muted); font-size: var(--text-body); line-height: var(--leading-prose); }
.problem-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 12px; }
.problem-actions :deep(button) { user-select: none; }
.problem-error { width: 100%; margin-top: 8px; color: var(--color-muted); font-size: 12px; text-align: left; }
.problem-error summary { cursor: pointer; text-align: center; user-select: none; }
.problem-error code {
  display: block; margin-top: 8px; padding: 10px 12px; border-radius: var(--radius-control);
  background: var(--color-surface-subtle); white-space: pre-wrap; overflow-wrap: anywhere;
}
</style>
