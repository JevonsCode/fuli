<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { useNow } from '@/composables/useNow'
import { t } from '@/i18n'
import type { ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'
import UiDialog from '@/ui/UiDialog.vue'
import { blockerIsStale, blockerReasonText, confirmTaskUnblocked, markTaskUnblocked } from './task-blocker'
import { formatDate } from './task-labels'
import { actionFailure, type TaskScope } from './task-runs'

// The person's 「标记为已解除」 for a block whose session will never continue,
// in the console on this computer. When one of the task's Agents went on with
// the project in another session, FULI only says the block is probably
// resolved; the person confirms it with one click (「确认已解除」).
const props = defineProps<{
  scope: TaskScope
  title: string
  blocker: ProjectAgentTaskBlocker
  /** The task's last recorded change, for the hint on a block with no progress. */
  updatedAt?: string | null
  /**
   * Where the no-progress hint goes: under the button, or only in its tooltip
   * when the page already says it once for many blocked cards (工作台).
   */
  hint?: 'inline' | 'tooltip'
}>()
const emit = defineEmits<{ cleared: [task: ProjectAgentTaskRecord] }>()

const NOTE_MAX = 500
const noteId = `task-blocker-note-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
const now = useNow()
const stale = computed(() => blockerIsStale(props.blocker, props.updatedAt, now.value))
const probable = computed(() => props.blocker.probablyResolved
  ? t('taskBlocker.probable.line', { time: formatDate(props.blocker.probablyResolved.at) }) : '')
const hintText = computed(() => probable.value || (stale.value ? t('taskBlocker.clear.stale') : ''))
const confirming = ref(false)
const confirmError = ref('')
const open = ref(false)
const note = ref('')
const busy = ref(false)
const error = ref('')

function start() {
  note.value = ''
  error.value = ''
  open.value = true
}

async function confirmProbable() {
  if (confirming.value) return
  confirming.value = true
  confirmError.value = ''
  try {
    emit('cleared', await confirmTaskUnblocked(props.scope))
  } catch (cause) {
    const kind = actionFailure(cause)
    confirmError.value = t(`taskBlocker.clear.failure.${kind}`, { message: cause instanceof Error ? cause.message : '' })
  } finally {
    confirming.value = false
  }
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
    <!-- 标记为已解除 keeps its place; the confirmation follows it when there is evidence. -->
    <Button variant="outline" size="sm" data-term="work.unblock" :title="hintText || undefined" data-blocker-clear-open @click.stop.prevent="start">
      {{ t('taskBlocker.clear.action') }}
    </Button>
    <Button v-if="probable" size="sm" :title="probable" :loading="confirming" :loading-label="t('taskBlocker.probable.pending')"
      data-blocker-confirm @click.stop.prevent="confirmProbable">
      {{ t('taskBlocker.probable.confirm') }}
    </Button>
    <small v-if="hintText && hint !== 'tooltip'" class="task-blocker-clear-hint" :data-blocker-hint="probable ? 'probable' : 'stale'">{{ hintText }}</small>
    <small v-if="confirmError" class="task-blocker-clear-error" role="alert" data-blocker-confirm-error>{{ confirmError }}</small>
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
.task-blocker-clear-error { color: var(--color-danger); font-size: 12px; }
.task-blocker-clear-task { overflow-wrap: anywhere; }
</style>
