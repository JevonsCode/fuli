<script setup lang="ts">
import { computed, ref } from 'vue'

import { Button } from '@/components/ui/button'
import { modelGuideUrl } from '@/features/model-settings/model'
import { pageModelContext } from '@/features/webmcp/model-context'
import { currentLocale, t } from '@/i18n'

import { aiTaskPrompt, type AiTaskId } from './ai-task-prompts'

// 「让 AI 来做」 inside a 「?」: the prompt the person copies into their own
// Agent, filled with this console's address. Where the browser offers WebMCP,
// one line says the page's own tools are open to the browser's AI as well.
const props = defineProps<{ task: AiTaskId; area: string }>()
const copied = ref(false)
const failed = ref(false)
const prompt = computed(() => aiTaskPrompt(props.task, currentLocale(), {
  console: window.location.origin, area: props.area, guide: modelGuideUrl(currentLocale()),
}))
const browserTools = pageModelContext() !== null

async function copy() {
  failed.value = false
  try {
    await navigator.clipboard.writeText(prompt.value)
    copied.value = true
  } catch {
    failed.value = true
  }
}
</script>

<template>
  <section class="ai-task" :aria-label="t('aiHelp.prompt.title')" :data-ai-task="task">
    <div class="ai-task__head">
      <strong>{{ t('aiHelp.prompt.title') }}</strong>
      <Button size="sm" variant="outline" data-ai-task-copy @click="copy">{{ copied ? t('aiHelp.prompt.copied') : t('aiHelp.prompt.copy') }}</Button>
    </div>
    <p class="ai-task__lead">{{ t('aiHelp.prompt.lead') }}</p>
    <pre class="ai-task__text" tabindex="0">{{ prompt }}</pre>
    <p v-if="failed" class="ai-task__lead" role="alert">{{ t('aiHelp.prompt.copyFailed') }}</p>
    <p v-if="browserTools" class="ai-task__lead" data-ai-task-webmcp>{{ t('aiHelp.prompt.webmcp') }}</p>
  </section>
</template>

<style scoped>
.ai-task { display: grid; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--color-border); }
.ai-task__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ai-task__head strong { font-size: 13px; }
.ai-task__lead { margin: 0; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.5; }
.ai-task__text {
  max-height: 132px; margin: 0; padding: 8px 10px; overflow: auto; border-radius: var(--radius-control, 8px);
  background: var(--color-surface-sunken, var(--color-accent-soft)); color: var(--color-ink-soft);
  font: 12px/1.55 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; word-break: break-word;
}
</style>
