<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ApiError, postJson } from '@/api/client'
import TextField from '@/components/TextField.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { OptionSelect } from '@/components/ui/select'
import { currentLocale, t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import { CUSTOM_CLIENT_FORMATS, type CustomClientFormat } from './client-connection-model'
import { addClientPrompt, type AddClientDraft } from './add-client-prompt'
import { injectClientConnectionStatus } from './client-connection-status'

// 「添加客户端」: a client FULI does not know. First a prompt the person sends
// as it is to that client; its own Agent opens this console's add link, which
// fills the form here (`prefill`, add-client-prompt.ts). The person checks it
// and clicks 添加并接入: adding stays their own step on this computer. A
// client that cannot run a command is filled in by hand. FULI writes its entry
// right after adding it, and its tile then updates with the other clients.
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ prefill?: AddClientDraft | null }>()
const prompt = addClientPrompt(currentLocale(), window.location.origin)
const copied = ref(false)
const copyFailed = ref(false)
const byHand = ref(false)
async function copy() {
  copyFailed.value = false
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(prompt)
    copied.value = true
  } catch { copyFailed.value = true }
}
const { busy, writing } = injectClientConnectionStatus()
const pending = ref(false)
const error = ref('')
const draft = reactive<{ name: string, mcpFile: string, format: CustomClientFormat }>({ name: '', mcpFile: '', format: 'mcp-servers-json' })
const formatOptions = CUSTOM_CLIENT_FORMATS.map((value) => ({ value, label: t(`settings.connection.custom.formats.${value}`) }))
// What the add link carries opens the form with it, for the person to check.
const filledByClient = ref(false)
watch(() => [open.value, props.prefill] as const, ([isOpen, prefill]) => {
  if (!isOpen || !prefill) return
  Object.assign(draft, prefill)
  byHand.value = true
  filledByClient.value = true
}, { immediate: true })

function close() {
  if (pending.value) return
  open.value = false
  error.value = ''
  copied.value = false
  byHand.value = false
  filledByClient.value = false
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
      const added = await postJson<{ id: string }>('/api/system/client-connection/custom-clients',
        { name: draft.name.trim(), mcpFile: draft.mcpFile.trim(), format: draft.format })
      Object.assign(draft, { name: '', mcpFile: '', format: 'mcp-servers-json' })
      open.value = false
      filledByClient.value = false
      // 接入 at once: the client's tile shows how it went, with its own 接入 to try again.
      try { await postJson('/api/system/client-connection/connect', { clientId: added.id }) } catch { /* its tile offers 接入 */ }
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
    <DialogContent v-if="open" size="md" data-custom-client-dialog>
      <DialogHeader>
        <DialogTitle>{{ t('settings.connection.custom.add') }}</DialogTitle>
        <DialogDescription>{{ t(filledByClient ? 'settings.connection.custom.filledByClient' : 'settings.connection.custom.addMeta') }}</DialogDescription>
      </DialogHeader>
      <section v-if="!filledByClient" class="add-prompt" data-add-client-prompt>
        <div class="add-prompt__head">
          <strong>{{ t('settings.connection.custom.promptTitle') }}</strong>
          <Button size="sm" data-copy-add-client-prompt @click="copy">{{ copied ? t('settings.connection.custom.promptCopied') : t('settings.connection.custom.promptCopy') }}</Button>
        </div>
        <pre class="add-prompt__text" tabindex="0">{{ prompt }}</pre>
        <p v-if="copyFailed" role="alert">{{ t('settings.connection.custom.promptCopyFailed') }}</p>
        <p v-else>{{ t('settings.connection.custom.promptAfter') }}</p>
      </section>
      <Button v-if="!byHand" variant="link" class="add-by-hand" data-add-client-by-hand @click="byHand = true">{{ t('settings.connection.custom.byHand') }}</Button>
      <form v-if="byHand" id="custom-client-form" class="custom-form" data-custom-client-form @submit.prevent="add">
        <TextField v-model="draft.name" control-id="custom-client-name" :label="t('settings.connection.custom.name')"
          :placeholder="t('settings.connection.custom.namePlaceholder')" required />
        <TextField v-model="draft.mcpFile" control-id="custom-client-file" :label="t('settings.connection.custom.mcpFile')"
          placeholder="~/.acme/mcp.json" required />
        <OptionSelect control-id="custom-client-format" :model-value="draft.format" :options="formatOptions"
          :label="t('settings.connection.custom.format')" @update:model-value="selectFormat" />
        <UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
      </form>
      <DialogFooter v-if="byHand">
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
.add-prompt { display: grid; gap: 6px; min-width: 0; }
.add-prompt__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.add-prompt__head strong { font-size: 13px; }
.add-prompt p { margin: 0; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.5; }
.add-prompt__text {
  max-height: 220px; margin: 0; padding: 8px 10px; overflow: auto; border-radius: var(--radius-control, 8px);
  background: var(--color-surface-sunken, var(--color-accent-soft)); color: var(--color-ink-soft);
  font: 12px/1.55 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; word-break: break-word;
}
.add-by-hand { justify-self: start; height: auto; padding: 0; font-size: 12px; }
</style>
