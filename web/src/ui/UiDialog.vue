<script setup lang="ts">
import { useId } from 'vue'

import { useModalDialog } from '@/composables/useModalDialog'
import { t } from '@/i18n'

// The one modal shell: title, optional description, scrolling body, footer actions.
// With `form`, the shell is a <form> and the footer's submit button submits it.
const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  busy?: boolean
  form?: boolean
  error?: string
}>(), { description: undefined, size: 'md', busy: false, form: false, error: '' })

const emit = defineEmits<{ close: []; submit: [] }>()
const titleId = `ui-dialog-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
const { dialogRef, initialFocusRef, onCancel, onKeydown } = useModalDialog(() => props.open, requestClose)

function requestClose() { if (!props.busy) emit('close') }
defineExpose({ initialFocusRef })
</script>

<template>
  <dialog v-if="open" ref="dialogRef" class="ui-dialog" :class="`ui-dialog--${size}`" aria-modal="true"
    :aria-labelledby="titleId" :aria-busy="busy || undefined" @cancel="onCancel" @keydown="onKeydown">
    <component :is="form ? 'form' : 'div'" class="ui-dialog__shell" @submit.prevent="emit('submit')">
      <header class="ui-dialog__header">
        <div>
          <h2 :id="titleId">{{ title }}</h2>
          <p v-if="description">{{ description }}</p>
        </div>
        <button class="ui-button ui-button--ghost ui-button--icon ui-button--sm" type="button" :disabled="busy"
          :aria-label="t('common.actions.close')" @click="requestClose">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
      </header>
      <div class="ui-dialog__body">
        <p v-if="error" class="ui-dialog__error" role="alert">{{ error }}</p>
        <slot />
      </div>
      <footer v-if="$slots.footer" class="ui-dialog__footer"><slot name="footer" /></footer>
    </component>
  </dialog>
</template>
