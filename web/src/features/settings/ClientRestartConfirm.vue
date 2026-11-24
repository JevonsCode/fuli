<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n'

import type { ClientObservation } from './client-connection-model'

// The one question before FULI quits a client to write its entry (「重启并更新」, 「重启并接入」):
// quitting ends the client's running tasks and sessions, so it is asked every time.
const client = defineModel<ClientObservation | null>('client', { required: true })
const emit = defineEmits<{ confirm: [client: ClientObservation] }>()

function confirm() {
  const chosen = client.value
  client.value = null
  if (chosen) emit('confirm', chosen)
}
</script>

<template>
  <Dialog :open="Boolean(client)" @update:open="(open: boolean) => { if (!open) client = null }">
    <DialogContent v-if="client" size="sm" data-restart-confirm>
      <DialogHeader>
        <DialogTitle>{{ t('settings.connection.clients.restartConfirm.title', { client: client.label }) }}</DialogTitle>
        <DialogDescription>{{ t('settings.connection.clients.restartConfirm.body', { client: client.label }) }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="client = null">{{ t('settings.connection.clients.restartConfirm.cancel') }}</Button>
        <Button data-restart-confirmed @click="confirm">{{ t('settings.connection.clients.restartConfirm.confirm') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
