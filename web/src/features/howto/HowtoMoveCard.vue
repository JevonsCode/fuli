<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'
import HowtoScene from './HowtoScene.vue'
import { phraseParts, type HowtoMove } from './howto-content'

// One move: its title, when to use it, the exact words to say (each copied
// with one click) and a small scene. Both copy labels share one grid cell, so
// the button keeps its width when it says 已复制.
const props = defineProps<{ move: HowtoMove }>()

const COPIED_MS = 1800
const copied = ref<string | null>(null)
const failed = ref(false)
let reset: ReturnType<typeof setTimeout> | undefined

async function copy(phrase: string) {
  clearTimeout(reset)
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable')
    await clipboard.writeText(phrase)
    copied.value = phrase
    failed.value = false
  } catch {
    copied.value = null
    failed.value = true
  }
  reset = setTimeout(() => { copied.value = null; failed.value = false }, COPIED_MS)
}
onBeforeUnmount(() => clearTimeout(reset))
</script>

<template>
  <Card as="article" class="howto-move" :data-howto-move="props.move.id" :aria-labelledby="`howto-move-${props.move.id}`">
    <CardHeader class="howto-move-header">
      <div class="howto-move-heading">
        <CardTitle :id="`howto-move-${props.move.id}`">{{ props.move.title }}</CardTitle>
        <CardDescription class="howto-move-when">{{ props.move.when }}</CardDescription>
      </div>
      <HowtoScene :move="props.move.id" class="howto-move-scene" />
    </CardHeader>
    <ul class="howto-phrases">
      <li v-for="phrase in props.move.phrases" :key="phrase" class="howto-phrase-row">
        <code class="howto-phrase" data-howto-phrase>
          <span v-for="(part, index) in phraseParts(phrase)" :key="index" :class="{ 'howto-placeholder': part.placeholder }">{{ part.text }}</span>
        </code>
        <Button
          variant="outline"
          size="md"
          class="howto-copy"
          :class="{ 'is-copied': copied === phrase }"
          data-howto-copy
          :aria-label="t('howto.copyPhrase', { text: phrase })"
          @click="copy(phrase)"
        >
          <UiIcon :name="copied === phrase ? 'check' : 'copy'" :size="14" />
          <span class="howto-copy-label">
            <span :aria-hidden="copied === phrase">{{ t('howto.copy') }}</span>
            <span :aria-hidden="copied !== phrase">{{ t('howto.copied') }}</span>
          </span>
        </Button>
      </li>
    </ul>
    <p class="howto-move-note" :data-term="props.move.term">{{ props.move.note }}</p>
    <span class="sr-only" role="status" aria-live="polite">{{ failed ? t('howto.copyFailed') : copied ? t('howto.copied') : '' }}</span>
  </Card>
</template>

<style scoped>
.howto-move-header { grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto; align-items: center; column-gap: var(--space-4); }
.howto-move-heading { display: grid; gap: 6px; min-width: 0; }
.howto-move-when { color: var(--color-muted); font-size: var(--text-body); line-height: 1.6; }
.howto-move-scene { width: 132px; }
.howto-phrases { display: grid; gap: 8px; margin: 0; padding: 0 20px; list-style: none; }
.howto-phrase-row { display: flex; align-items: flex-start; gap: 8px; }
.howto-phrase {
  flex: 1 1 auto; min-width: 0; min-height: var(--control-height); box-sizing: border-box; display: flex; align-items: center;
  padding: 7px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-control);
  background: var(--color-surface-subtle); color: var(--color-ink);
  font-family: var(--font-mono); font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; white-space: normal;
}
.howto-placeholder { color: var(--color-gold); font-weight: var(--weight-medium); }
.howto-copy { flex: 0 0 auto; }
.howto-copy.is-copied { color: var(--color-success); }
.howto-copy-label { display: inline-grid; }
.howto-copy-label > span { grid-area: 1 / 1; }
.howto-copy-label > span[aria-hidden="true"] { visibility: hidden; }
.howto-move-note { padding: 0 20px; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.6; }

@media (max-width: 520px) {
  .howto-move-header { grid-template-columns: minmax(0, 1fr); }
  .howto-move-scene { width: 112px; }
}
</style>
