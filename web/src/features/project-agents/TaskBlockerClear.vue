<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { useNow } from '@/composables/useNow'
import { t } from '@/i18n'
import type { ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'
import UiDialog from '@/ui/UiDialog.vue'
import { blockerIsStale, blockerReasonText, markTaskUnblocked } from './task-blocker'
import { actionFailure, type TaskScope } from './task-runs'

// The person's 「标记为已解除」 for a block whose session will never continue.
// Only the person does this, in the console on this computer; Agents end a
// block only by continuing in the session that reported it.
const props = defineProps<{
  scope: TaskScope
  title: string
  blocker: ProjectAgentTaskBlocker
  /** The task's last recorded change, for the hint on a block with no progress. */
  updatedAt?: string | null
}>()
const emit = defineEmits<{ cleared: [task: ProjectAgentTaskRecord] }>()

const NOTE_MAX = 500
const noteId = `task-blocker-note-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
const now = useNow()
const stale = computed(() => blockerIsStale(props.blocker, props.updatedAt, now.value))
const open = ref(false)
const note = ref('')
const busy = ref(false)
const error = ref('')

function start() {
  note.value = ''
  error.value = ''
  open.value = true
}

async function confirm() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const task = await markTaskUnblocked(props.scope, note.value)
    open.value = false
    emit('cleared', task)
  } catch (cause) {
    const kind = actionFailure(cause)
    error.value = t(`taskBlocker.clear.failure.${kind}`, { message: cause instanceof Error ? cause.message : '' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="task-blocker-clear" data-blocker-clear>
    <Button variant="outline" size="sm" data-term="work.unblock" data-blocker-clear-open @click.stop.prevent="start">
      {{ t('taskBlocker.clear.action') }}
    </Button>
    <small v-if="stale" class="task-blocker-clear-hint" data-blocker-stale>{{ t('taskBlocker.clear.stale') }}</small>
    <UiDialog :open="open" :title="t('taskBlocker.clear.action')" size="sm" :busy="busy" :error="error" form
      @close="open = false" @submit="confirm">
      <p class="task-blocker-clear-task"><strong>{{ title }}</strong> · {{ blockerReasonText(blocker) }}</p>
      <p>{{ t('taskBlocker.clear.body') }}</p>
      <Field>
        <FieldLabel :for="noteId">{{ t('taskBlocker.clear.note') }}</FieldLabel>
        <Textarea :id="noteId" v-model="note" rows="2" :maxlength="NOTE_MAX" :disabled="busy"
          :placeholder="t('taskBlocker.clear.notePlaceholder')" data-blocker-clear-note />
      </Field>
      <template #footer>
        <Button variant="outline" :disabled="busy" @click="open = false">{{ t('common.actions.cancel') }}</Button>
        <Button type="submit" :loading="busy" :loading-label="t('taskBlocker.clear.pending')" data-blocker-clear-confirm>
          {{ t('taskBlocker.clear.action') }}
        </Button>
      </template>
    </UiDialog>
  </div>
</template>

<style scoped>
.task-blocker-clear { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.task-blocker-clear-hint { color: var(--color-muted); font-size: 12px; }
.task-blocker-clear-task { overflow-wrap: anywhere; }
</style>
