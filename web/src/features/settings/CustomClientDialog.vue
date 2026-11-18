<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ApiError, postJson } from '@/api/client'
import TextField from '@/components/TextField.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { OptionSelect } from '@/components/ui/select'
import { currentLocale, t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import { ADD_CLIENT_FORMATS, addClientPrompt, type AddClientDraft, type AddClientFormat } from './add-client-prompt'
import { injectClientConnectionStatus } from './client-connection-status'

// 「添加客户端」: a client FULI does not know. First a prompt the person sends
// as it is to that client; its own Agent opens this console's add link, which
// fills the form here (`prefill`, add-client-prompt.ts). The person checks it
// and clicks 添加并接入: adding stays their own step on this computer. A
// client that cannot run a command is filled in by hand. Once added, the parent
// connects it as its tile's 接入 would, and the tile shows how that went.
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ prefill?: AddClientDraft | null }>()
// The added client's id: the parent connects it with its tiles' own connectOne,
// so the person gets the same answer a tile click gives.
const emit = defineEmits<{ added: [clientId: string] }>()
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
const draft = reactive<AddClientDraft>({ name: '', mcpFile: '', format: 'mcp-servers-json', skillsDir: '' })
const formatOptions = ADD_CLIENT_FORMATS.map((value) => ({ value, label: t(`settings.connection.custom.formats.${value}`) }))
// What the add link carries opens the form with it, for the person to check.
// Any page may open that link, so the dialog says the link filled it, never who.
const filledByLink = ref(false)
watch(() => [open.value, props.prefill] as const, ([isOpen, prefill]) => {
  if (!isOpen || !prefill) return
  Object.assign(draft, prefill)
  byHand.value = true
  filledByLink.value = true
}, { immediate: true })

// The next opening starts on the prompt again.
function hide() {
  open.value = false
  error.value = ''
  copied.value = false
  copyFailed.value = false
  byHand.value = false
  filledByLink.value = false
}
function close() {
  if (!pending.value) hide()
}
function selectFormat(value: string) {
  const known = ADD_CLIENT_FORMATS.find((candidate) => candidate === value)
  if (known) draft.format = known
}
async function add() {
  if (busy.value || !draft.name.trim() || !draft.mcpFile.trim()) return
  pending.value = true
  error.value = ''
  let addedId = ''
  await writing(async () => {
    try {
      const added = await postJson<{ id: string }>('/api/system/client-connection/custom-clients',
        { name: draft.name.trim(), mcpFile: draft.mcpFile.trim(), format: draft.format,
          ...(draft.skillsDir.trim() ? { skillsDir: draft.skillsDir.trim() } : {}) })
      Object.assign(draft, { name: '', mcpFile: '', format: 'mcp-servers-json', skillsDir: '' })
      addedId = added.id
      hide()
    } catch (reason) {
      // A refusal of what was typed is worded here: its own text is the JSON an Agent reads.
      error.value = reason instanceof ApiError && reason.status === 400
        ? t('settings.connection.custom.addRefused')
        : t('settings.connection.custom.addError', { reason: reason instanceof Error ? reason.message : String(reason) })
    } finally { pending.value = false }
  })
  // After the write ends, so its tile is listed before it is connected.
  if (addedId) emit('added', addedId)
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => { if (!value) close() }">
    <DialogContent v-if="open" size="md" data-custom-client-dialog>
      <DialogHeader>
        <DialogTitle>{{ t('settings.connection.custom.add') }}</DialogTitle>
        <DialogDescription>{{ t(filledByLink ? 'settings.connection.custom.filledByLink' : 'settings.connection.custom.addMeta') }}</DialogDescription>
      </DialogHeader>
      <section v-if="!filledByLink" class="add-prompt" data-add-client-prompt>
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
        <div class="custom-form__field">
          <TextField v-model="draft.skillsDir" control-id="custom-client-skills" :label="t('settings.connection.custom.skillsDir')"
            placeholder="~/.acme/skills" aria-describedby="custom-client-skills-hint" />
          <p id="custom-client-skills-hint" class="custom-form__hint">{{ t('settings.connection.custom.skillsDirHint') }}</p>
        </div>
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
.custom-form__field { display: grid; gap: 4px; min-width: 0; }
.custom-form__hint { margin: 0; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.5; }
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
