<script setup lang="ts">
import { ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import VisitRequestCard from './VisitRequestCard.vue'
import { readVisitRequest, type VisitAction } from './visit-request-api'
import type { VisitRequestCard as Card } from './visit-request-shape'
import { useVisitDecision, visitErrorText } from './useVisitDecision'

// The quick look of one request (`id`, '' when closed), read whole each time
// it opens and again after every decision, so the card shows what the server
// holds. A refresh keeps the card on screen until the new answer replaces it.
const props = defineProps<{ id: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const card = ref<Card | null>(null)
const loading = ref(false)
const error = ref('')
const decision = useVisitDecision()

async function load(id = props.id) {
  if (!id) return
  loading.value = true
  error.value = ''
  try {
    const read = await readVisitRequest(id)
    if (id === props.id) card.value = read
  } catch (cause) {
    if (id === props.id) error.value = visitErrorText(cause, t('visitRequests.card.loadFailed'))
  } finally {
    if (id === props.id) loading.value = false
  }
}
watch(() => props.id, (id) => {
  if (card.value?.id !== id) card.value = null
  void load(id)
}, { immediate: true })

async function act(action: VisitAction, reason: string) {
  if (!card.value) return
  await decision.decide(card.value, action, reason)
  emit('changed')
  await load()
}
function openChange(open: boolean) { if (!open) emit('close') }
</script>

<template>
  <Dialog :open="Boolean(id)" @update:open="openChange">
    <DialogContent v-if="id" size="lg" data-visit-peek>
      <VisitRequestCard v-if="card" :card="card" :busy="decision.busy.value" @act="act" @changed="load(); emit('changed')" />
      <template v-else>
        <DialogHeader>
          <DialogTitle>{{ t('visitRequests.card.title') }}</DialogTitle>
          <DialogDescription class="sr-only">{{ t('visitRequests.card.loading') }}</DialogDescription>
        </DialogHeader>
        <GrowthLoading v-if="loading" variant="compact" :label="t('visitRequests.card.loading')" />
        <UiNotice v-else-if="error" tone="error" data-visit-peek-error>
          {{ error }}
          <template #actions><Button size="sm" variant="ghost" @click="load()">{{ t('visitRequests.list.retry') }}</Button></template>
        </UiNotice>
      </template>
    </DialogContent>
  </Dialog>
</template>
