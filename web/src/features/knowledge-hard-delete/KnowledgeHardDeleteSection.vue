<script setup lang="ts">
import { ref } from 'vue'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import KnowledgeHardDeleteDialog from './KnowledgeHardDeleteDialog.vue'
import type { HardDeletedState } from './model'

// rec#5 C9: 「彻底删除」 lives in a collapsed danger section at the end of the
// item page; opening it is the first step, the dialog's preview and typed
// confirmation the second. Only the console offers it.
defineProps<{ item: KnowledgeItemSummary; spaceId: string }>()
const emit = defineEmits<{ deleted: [state: HardDeletedState] }>()

const open = ref(false)
const opener = ref<HTMLElement | null>(null)

function deleted(state: HardDeletedState) {
  open.value = false
  emit('deleted', state)
}

function returnFocus(event: Event) {
  event.preventDefault()
  opener.value?.querySelector('button')?.focus({ preventScroll: true })
}
</script>

<template>
  <Card as="section" class="px-5 py-0" data-hard-delete-section>
    <Accordion type="single" collapsible>
      <AccordionItem value="danger" class="border-0">
        <AccordionTrigger data-hard-delete-toggle>{{ t('knowledgeHardDelete.danger.title') }}</AccordionTrigger>
        <AccordionContent>
          <div class="grid justify-items-start gap-3 pb-4 text-sm">
            <p class="m-0 text-muted-foreground">{{ t('knowledgeHardDelete.danger.help') }}</p>
            <span ref="opener">
              <Button variant="destructive" data-hard-delete-open @click="open = true">{{ t('knowledgeHardDelete.danger.open') }}</Button>
            </span>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </Card>
  <Dialog v-model:open="open">
    <DialogContent v-if="open" size="lg" data-hard-delete-dialog @close-auto-focus="returnFocus">
      <KnowledgeHardDeleteDialog :item="item" :space-id="spaceId" @deleted="deleted" @cancel="open = false" />
    </DialogContent>
  </Dialog>
</template>
