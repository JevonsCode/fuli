<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ApiError, postJson } from '@/api/client'
import TextField from '@/components/TextField.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { OptionSelect } from '@/components/ui/select'
import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import { CUSTOM_CLIENT_FORMATS, type CustomClientFormat } from './client-connection-model'
import { injectClientConnectionStatus } from './client-connection-status'

// 「添加客户端」: a client FULI does not know, described by its name and the
// MCP configuration file under the home folder. Adding it reads the clients'
// status again, so its tile appears in the grid, where it connects like the others.
const open = defineModel<boolean>('open', { required: true })
const { busy, writing } = injectClientConnectionStatus()
const pending = ref(false)
const error = ref('')
const draft = reactive<{ name: string, mcpFile: string, format: CustomClientFormat }>({ name: '', mcpFile: '', format: 'mcp-servers-json' })
const formatOptions = CUSTOM_CLIENT_FORMATS.map((value) => ({ value, label: t(`settings.connection.custom.formats.${value}`) }))

function close() {
  if (pending.value) return
  open.value = false
  error.value = ''
}
function selectFormat(value: string) {
  const known = CUSTOM_CLIENT_FORMATS.find((candidate) => candidate === value)
  if (known) draft.format = known
}
async function add() {
  if (busy.value || !draft.name.trim() || !draft.mcpFile.trim()) return
  pending.value = true
  error.value = ''
  await writing(async () => {
    try {
      await postJson('/api/system/client-connection/custom-clients', { name: draft.name.trim(), mcpFile: draft.mcpFile.trim(), format: draft.format })
      Object.assign(draft, { name: '', mcpFile: '', format: 'mcp-servers-json' })
      open.value = false
    } catch (reason) {
      // A refusal of what was typed is worded here: its own text is the JSON an Agent reads.
      error.value = reason instanceof ApiError && reason.status === 400
        ? t('settings.connection.custom.addRefused')
        : t('settings.connection.custom.addError', { reason: reason instanceof Error ? reason.message : String(reason) })
    } finally { pending.value = false }
  })
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => { if (!value) close() }">
    <DialogContent v-if="open" size="sm" data-custom-client-dialog>
      <DialogHeader>
        <DialogTitle>{{ t('settings.connection.custom.add') }}</DialogTitle>
        <DialogDescription>{{ t('settings.connection.custom.addMeta') }}</DialogDescription>
      </DialogHeader>
      <form id="custom-client-form" class="custom-form" data-custom-client-form @submit.prevent="add">
        <TextField v-model="draft.name" control-id="custom-client-name" :label="t('settings.connection.custom.name')"
          :placeholder="t('settings.connection.custom.namePlaceholder')" required />
        <TextField v-model="draft.mcpFile" control-id="custom-client-file" :label="t('settings.connection.custom.mcpFile')"
          placeholder="~/.acme/mcp.json" required />
        <OptionSelect control-id="custom-client-format" :model-value="draft.format" :options="formatOptions"
          :label="t('settings.connection.custom.format')" @update:model-value="selectFormat" />
        <UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
      </form>
      <DialogFooter>
        <Button type="button" variant="ghost" :disabled="pending" @click="close">{{ t('settings.connection.custom.cancel') }}</Button>
        <Button type="submit" form="custom-client-form" data-submit-custom-client :disabled="busy || !draft.name.trim() || !draft.mcpFile.trim()"
          :loading="pending" :loading-label="t('settings.connection.custom.adding', { client: draft.name.trim() })">
          {{ t('settings.connection.custom.submit') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.custom-form { display: grid; gap: 12px; }
</style>
