<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { UiDialog } from '@/ui'

import { usePersonConfirmation } from './person-confirmation'

// The person's own click for a page tool's change the delegation gate left to
// them (a model key, the endpoint listing, their decisions). Closing it is no.
const { current, waiting, answer } = usePersonConfirmation()
</script>

<template>
  <UiDialog :open="Boolean(current)" size="sm" :title="current?.title ?? ''" :description="t('aiHelp.webmcp.confirm.asks')"
    data-person-confirm @close="current && answer(current.id, false)">
    <ul v-if="current?.lines.length" class="person-confirm-lines">
      <li v-for="line in current.lines" :key="line">{{ line }}</li>
    </ul>
    <p v-if="waiting" class="person-confirm-waiting">{{ t('aiHelp.webmcp.confirm.waiting', { count: waiting }) }}</p>
    <template #footer>
      <Button variant="outline" data-person-confirm-deny @click="current && answer(current.id, false)">{{ t('aiHelp.webmcp.confirm.deny') }}</Button>
      <Button data-person-confirm-allow @click="current && answer(current.id, true)">{{ t('aiHelp.webmcp.confirm.allow') }}</Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.person-confirm-lines { display: grid; gap: 4px; margin: 0; padding-left: 18px; color: var(--color-ink-soft); font-size: var(--text-body); }
.person-confirm-waiting { margin: 8px 0 0; color: var(--color-muted); font-size: var(--text-meta); }
</style>
