<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { z } from 'zod'

import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import HeaderPeek from '@/components/HeaderPeek.vue'
import { Button } from '@/components/ui/button'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { sessionLinksFor } from '@/features/client-links/model'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiIcon from '@/ui/UiIcon.vue'
import UiIconButton from '@/ui/UiIconButton.vue'

import { EXPLAIN_MODELS } from './explain-models'
import { tonborgExplainPrompt } from './tonborg-explain-prompt'

// 「让 Tonborg 给你解释」 beside the Tonborg card's title (Jevons 11-07): one row
// per connected client whose documented new-chat link takes a prompt
// (registry/client-links.json); a click opens a new chat there with the
// prompt filled in, never sent, where the person's AI speaks as Tonborg
// (list_tonborg_questions, answer_tonborg_question). Copying the prompt is the
// fallback for any other AI, and the only row when no client can open a chat.
const props = defineProps<{ count: number }>()
const consoleStore = useConsoleStore()
const links = useClientLinks()
const open = ref(false)
const failed = ref(false)

// Only what this panel reads of /api/system/client-connection/status.
const statusShape = shapeOf(z.looseObject({
  clients: z.array(z.looseObject({ status: z.string(), sourceApplication: z.string().nullish() })),
}))
const connected = ref<Set<string> | null>(null)

const prompt = computed(() => tonborgExplainPrompt(props.count, currentLocale()))
const openers = computed(() => (links.state?.manifest.clients ?? []).filter(client => connected.value?.has(client.id)).flatMap(client => {
  const choice = EXPLAIN_MODELS[client.id]
  const link = client.sessionLinks.find(item => 'prompt' in item.parameters)
  // A link value carries no line breaks (client-links/model.ts): the same prompt on one line.
  const [built] = sessionLinksFor(links.state?.manifest, client.id, { prompt: prompt.value.replaceAll('\n', ' '), model: choice?.model })
  if (!link || !built) return []
  // The model's name shows only when the link really carries it.
  return [{ id: client.id, name: client.name, href: built.href, model: choice && 'model' in link.parameters ? choice.label : '' }]
}))

watch(open, (now) => {
  failed.value = false
  if (!now) return
  // Either read may fail; copying still works without them.
  void links.load().catch(() => {})
  if (!connected.value) {
    void getJson('/api/system/client-connection/status', statusShape).then((value) => {
      connected.value = new Set(value.clients.filter(client => client.status === 'connected' && client.sourceApplication)
        .map(client => client.sourceApplication as string))
    }).catch(() => {})
  }
})

function opened(name: string) {
  open.value = false
  consoleStore.notify(t('reviewList.explain.opened', { client: name }))
}

async function copy() {
  try {
    await navigator.clipboard.writeText(prompt.value)
    open.value = false
    consoleStore.notify(t('reviewList.explain.copied'))
  } catch {
    failed.value = true
  }
}
</script>

<template>
  <HeaderPeek v-model:open="open" align="start">
    <template #trigger>
      <UiIconButton icon="help" size="sm" class="tonborg-explain__trigger" :label="t('reviewList.explain.title')" :active="open"
        data-tonborg-explain @click="open = !open" />
    </template>
    <div class="tonborg-explain" data-tonborg-explain-panel>
      <div class="tonborg-explain__head">
        <span class="header-peek-title">{{ t('reviewList.explain.title') }}</span>
        <span v-if="openers.length" class="tonborg-explain__lead">{{ t('reviewList.explain.lead') }}</span>
      </div>
      <ul v-if="openers.length" class="tonborg-explain__clients">
        <li v-for="opener in openers" :key="opener.id">
          <a class="tonborg-explain__row" :href="opener.href" :data-tonborg-explain-open="opener.id" @click="opened(opener.name)">
            <UiIcon name="chat" :size="16" />
            <span class="tonborg-explain__name">{{ opener.name }}</span>
            <span v-if="opener.model" class="tonborg-explain__model">{{ opener.model }}</span>
          </a>
        </li>
      </ul>
      <Button v-if="openers.length" variant="link" size="sm" class="tonborg-explain__copy" data-tonborg-explain-copy @click="copy">
        {{ t('reviewList.explain.copy') }}</Button>
      <Button v-else variant="ghost" class="tonborg-explain__copy-only" data-tonborg-explain-copy @click="copy">
        <UiIcon name="copy" :size="16" />{{ t('reviewList.explain.copyOnly') }}</Button>
      <template v-if="failed">
        <p class="tonborg-explain__lead" role="alert">{{ t('reviewList.explain.copyFailed') }}</p>
        <textarea class="tonborg-explain__text" readonly :value="prompt" rows="5" data-tonborg-explain-text />
      </template>
    </div>
  </HeaderPeek>
</template>

<style scoped>
/* Inside the title's own 30px line, as every card 「?」: opening the panel moves nothing. */
.tonborg-explain__trigger { margin-block: -3px; color: var(--color-muted); }
.tonborg-explain { display: grid; gap: 8px; width: min(300px, calc(100vw - 48px)); }
.tonborg-explain__head { display: grid; gap: 2px; }
.tonborg-explain__lead { margin: 0; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.5; }
.tonborg-explain__clients { display: grid; gap: 2px; margin: 0 -8px; padding: 0; list-style: none; }
.tonborg-explain__row {
  display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 8px; border-radius: var(--radius-control, 8px);
  color: var(--color-ink); font-size: var(--text-body); text-decoration: none; user-select: none; cursor: pointer;
}
.tonborg-explain__row:hover, .tonborg-explain__row:focus-visible { background: var(--color-accent-soft); outline: none; }
.tonborg-explain__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tonborg-explain__model { flex: none; color: var(--color-muted); font-size: var(--text-meta); }
.tonborg-explain__copy { justify-self: start; padding: 0; user-select: none; }
.tonborg-explain__copy-only { justify-content: flex-start; gap: 8px; margin: 0 -8px; padding: 0 8px; user-select: none; }
.tonborg-explain__text {
  width: 100%; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-control, 8px);
  background: var(--color-surface); color: var(--color-ink-soft); font: 12px/1.55 var(--font-mono, ui-monospace, monospace); resize: none;
}
</style>
