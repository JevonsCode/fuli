<script setup lang="ts">
import { computed, toRef } from 'vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { useWorkLocations } from './work-locations'

// Widget 'fla-continue-elsewhere' (rec issue 147): carrying this FLA's latest
// piece of work into another client. One click copies the opening prompt; the
// person sends it as the first message there. It names the work and project it
// carries, and says in one line that it opens a NEW session and leaves the
// original where it is — so it is never mistaken for 「回原会话」 beside a
// segment, which opens that session itself (Jevons 2026-11-18).
//
// Self-contained: it shares the FLA's one work-location read with the count.
// With no conversation to continue it shows nothing.
const props = defineProps<{ spaceId: string; agentId: string; agentName?: string; projectName?: (id: string) => string }>()

const store = useConsoleStore()
const { located } = useWorkLocations(toRef(props, 'spaceId'), toRef(props, 'agentId'))
const continuation = computed(() => located.value?.continuation ?? null)
const what = computed(() => {
  const value = continuation.value
  if (!value) return ''
  const project = value.personal_project_id ? (props.projectName?.(value.personal_project_id) ?? value.personal_project_id) : t('flaPage.worked.global')
  return t('flaPage.continueElsewhere.what', { title: value.title || t('flaPage.worked.untitled'), project })
})

async function copyPrompt() {
  if (!continuation.value) return
  try {
    await navigator.clipboard.writeText(continuation.value.prompt)
    store.notify(t('flaPage.continueElsewhere.copied'))
  } catch (cause) {
    store.reportError(cause)
  }
}
</script>

<template>
  <section v-if="continuation" class="continue" aria-labelledby="fla-continue-heading" data-widget="fla-continue-elsewhere">
    <h2 id="fla-continue-heading" class="continue-label">{{ t('flaPage.continueElsewhere.title') }}</h2>
    <Card class="continue-card">
      <div class="continue-main">
        <span class="continue-what" data-continuation-what>{{ what }}</span>
        <span class="continue-line">{{ t('flaPage.continueElsewhere.how') }}</span>
      </div>
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
.continue-main { display: grid; min-width: 0; }
.continue-what { overflow: hidden; color: var(--color-ink); font-size: var(--text-body); text-overflow: ellipsis; white-space: nowrap; }
.continue-line { color: var(--color-muted); font-size: var(--text-meta); }
.continue-copy { flex: none; user-select: none; }
</style>
