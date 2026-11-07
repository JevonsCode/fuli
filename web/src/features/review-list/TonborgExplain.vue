<script setup lang="ts">
import { computed, ref } from 'vue'

import { getJson } from '@/api/client'
import { Button } from '@/components/ui/button'
import { captureSourceFor, clientDetectionShape, type ClientDetection } from '@/features/capture/capture-clients'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { sessionLinksFor } from '@/features/client-links/model'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiIconButton from '@/ui/UiIconButton.vue'
import UiPopover from '@/ui/UiPopover.vue'

import { ASK_HOW_MANY_ABOVE, tonborgExplainPrompt } from './tonborg-explain-prompt'

// 「让 AI 解释」 on the Tonborg card (Jevons 11-07): the person's own AI explains
// Tonborg's unsure items and records their answers (list_tonborg_questions,
// answer_tonborg_question). 复制给 AI copies the prompt; for each connected
// client whose documented new-chat link takes a prompt (registry/client-links.json),
// 用 … 打开 starts a new chat with it filled in, never sent. Without such a
// client only the copy is offered.
const props = defineProps<{ count: number }>()
const consoleStore = useConsoleStore()
const links = useClientLinks()
const open = ref(false)
const anchor = ref<DOMRect | null>(null)
const detection = ref<ClientDetection | null>(null)
const failed = ref(false)

const prompt = computed(() => tonborgExplainPrompt(props.count, currentLocale()))
const connected = computed(() => new Set((detection.value?.clients ?? [])
  .filter(client => client.status === 'connected').map(client => captureSourceFor(client.id) ?? client.id)))
const openers = computed(() => (links.state?.manifest.clients ?? []).filter(client => connected.value.has(client.id)).flatMap(client => {
  // A link value carries no line breaks (client-links/model.ts): the same prompt on one line.
  const [link] = sessionLinksFor(links.state?.manifest, client.id, { prompt: prompt.value.replaceAll('\n', ' ') })
  return link ? [{ id: client.id, name: client.name, href: link.href }] : []
}))

function toggle(event: MouseEvent) {
  anchor.value = (event.currentTarget as HTMLElement).getBoundingClientRect()
  open.value = !open.value
  failed.value = false
  if (!open.value) return
  // Either read may fail; the copy still works without them.
  void links.load().catch(() => {})
  if (!detection.value) {
    void getJson('/api/system/client-connection/status', clientDetectionShape)
      .then(value => { detection.value = value }).catch(() => {})
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(prompt.value)
    open.value = false
    consoleStore.notify(t('reviewList.explain.copied', { count: props.count }))
  } catch {
    failed.value = true
  }
}
</script>

<template>
  <UiIconButton icon="help" size="sm" class="tonborg-explain__button" :label="t('reviewList.explain.button')" :active="open"
    data-tonborg-explain @click.stop="toggle" />
  <UiPopover :open="open" :anchor="anchor" :label="t('reviewList.explain.title')" glass @close="open = false">
    <div class="tonborg-explain" data-tonborg-explain-panel>
      <strong class="tonborg-explain__title">{{ t('reviewList.explain.title') }}</strong>
      <p class="tonborg-explain__lead">{{ count > ASK_HOW_MANY_ABOVE ? t('reviewList.explain.leadMany', { count }) : t('reviewList.explain.lead') }}</p>
      <div class="tonborg-explain__actions">
        <Button size="sm" data-tonborg-explain-copy @click="copy">{{ t('reviewList.explain.copy') }}</Button>
        <Button v-for="opener in openers" :key="opener.id" size="sm" variant="outline" as-child>
          <a :href="opener.href" :title="t('reviewList.explain.openHint')" :data-tonborg-explain-open="opener.id" @click="open = false">
            {{ t('reviewList.explain.openIn', { client: opener.name }) }}</a>
        </Button>
      </div>
      <template v-if="failed">
        <p class="tonborg-explain__lead" role="alert">{{ t('reviewList.explain.copyFailed') }}</p>
        <textarea class="tonborg-explain__text" readonly :value="prompt" rows="5" data-tonborg-explain-text />
      </template>
    </div>
  </UiPopover>
</template>

<style scoped>
.tonborg-explain__button { color: var(--color-muted); }
.tonborg-explain { display: grid; gap: 8px; width: min(320px, calc(100vw - 48px)); }
.tonborg-explain__title { font-size: var(--text-body); font-weight: var(--weight-medium); }
.tonborg-explain__lead { margin: 0; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.5; }
.tonborg-explain__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.tonborg-explain__actions a { user-select: none; }
.tonborg-explain__text {
  width: 100%; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-control, 8px);
  background: var(--color-surface); color: var(--color-ink-soft); font: 12px/1.55 var(--font-mono, ui-monospace, monospace); resize: none;
}
</style>
