<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { readWorkLocations, type WorkLocations } from './work-locations'

// Widget 'fla-continue-elsewhere' (rec#147): carrying this FLA's work into
// another client. One click copies the opening prompt; the person pastes it as
// the first message there. It is deliberately not the same control as 「回到原
// 会话」 next to a segment: this one starts a NEW session and leaves the
// original conversation where it is, and the card says so in one line rather
// than leaving the person to guess (Jevons 2026-11-18).
//
// Self-contained: it reads its own data from the FLA's id alone. An FLA with no
// conversation to continue shows nothing at all.
const props = defineProps<{ spaceId: string; agentId: string; agentName?: string }>()

const store = useConsoleStore()
const located = ref<WorkLocations | null>(null)
let controller: AbortController | null = null

async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    const result = await readWorkLocations(props.spaceId, props.agentId, current.signal)
    if (controller === current) located.value = result
  } catch (cause) {
    if (controller !== current || (cause instanceof DOMException && cause.name === 'AbortError')) return
    located.value = null
  }
}
watch(() => [props.spaceId, props.agentId], () => { if (props.spaceId && props.agentId) void load() }, { immediate: true })
onBeforeUnmount(() => controller?.abort())

const prompt = computed(() => located.value?.continuation?.prompt ?? null)

async function copyPrompt() {
  if (!prompt.value) return
  try {
    await navigator.clipboard.writeText(prompt.value)
    store.notify(t('flaPage.continueElsewhere.copied'))
  } catch (cause) {
    store.reportError(cause)
  }
}
</script>

<template>
  <section v-if="prompt" class="continue" aria-labelledby="fla-continue-heading" data-widget="fla-continue-elsewhere">
    <h2 id="fla-continue-heading" class="continue-label">{{ t('flaPage.continueElsewhere.title') }}</h2>
    <Card class="continue-card">
      <p class="continue-line">{{ t('flaPage.continueElsewhere.how') }}</p>
      <Button size="sm" variant="outline" class="continue-copy" data-copy-continuation @click="copyPrompt">
        {{ t('flaPage.continueElsewhere.copy') }}
      </Button>
    </Card>
  </section>
</template>

<style scoped>
.continue { display: grid; gap: 12px; }
.continue-label { margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.continue-card { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 24px; }
.continue-line { margin: 0; min-width: 0; color: var(--color-muted); font-size: var(--text-meta); }
.continue-copy { flex: none; user-select: none; }
</style>
