<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import RoundtableSeats from './RoundtableSeats.vue'
import RoundtableResults from './RoundtableResults.vue'
import RoundtableEvents from './RoundtableEvents.vue'
import { copy, label, time } from './copy'
import { roundtableApi, type RoundtableControl, type RoundtableSnapshot } from './roundtable-api'
const props = defineProps<{ snapshot: RoundtableSnapshot; refreshing: boolean }>()
const emit = defineEmits<{ refresh: [] }>()
const body = ref(''), error = ref(''), pending = ref('')
const actionReason = ref(''), showStop = ref(false), showAcceptance = ref(false)
const budgetRounds = ref(3), budgetMessages = ref(30), budgetMinutes = ref(30), budgetTurnMinutes = ref(5)
const room = computed(() => props.snapshot.room)
const terminal = computed(() => ['concluded', 'failed', 'cancelled'].includes(room.value.status))
const seatsReady = computed(() => room.value.seats.every(seat => seat.joinedAt))
const canAdvance = computed(() => room.value.status === 'active' && room.value.phase === 'discussion' && (room.value.round ?? 1) > 1
  && props.snapshot.currentTurn?.status === 'pending' && room.value.phaseIndex === 0)
const canRetry = computed(() => ['paused', 'waiting_input'].includes(room.value.status) && props.snapshot.currentTurn && !['pending', 'claimed'].includes(props.snapshot.currentTurn.status))
const canSkip = computed(() => props.snapshot.currentTurn && props.snapshot.currentTurn.status !== 'claimed' && ['discussion', 'planning'].includes(room.value.phase))
const canResume = computed(() => !props.snapshot.currentTurn || ['pending', 'claimed'].includes(props.snapshot.currentTurn.status))
const seatName = (id: string | null) => room.value.seats.find(seat => seat.id === id)?.name ?? id ?? copy('系统', 'System')
watch(() => room.value.id, () => { body.value = ''; error.value = ''; showStop.value = false; showAcceptance.value = false })
watch(() => `${room.value.id}:${JSON.stringify(room.value.limits)}`, () => {
  const limits = room.value.limits
  budgetRounds.value = limits.maxRounds; budgetMessages.value = limits.maxMessages
  budgetMinutes.value = limits.maxDurationMs / 60000; budgetTurnMinutes.value = limits.turnTimeoutMs / 60000
}, { immediate: true })
async function updateLimits() {
  if (pending.value) return
  pending.value = 'update_limits'; error.value = ''
  try {
    await roundtableApi.control(room.value.id, 'update_limits', room.value.revision, '', {
      maxRounds: budgetRounds.value, maxMessages: budgetMessages.value,
      maxDurationMs: Math.round(budgetMinutes.value * 60000), turnTimeoutMs: Math.round(budgetTurnMinutes.value * 60000),
    }); emit('refresh')
  } catch (reason) { error.value = reason instanceof Error ? reason.message : copy('更新停止条件失败', 'Could not update limits'); emit('refresh') }
  finally { pending.value = '' }
}
async function control(action: RoundtableControl) {
  if (pending.value) return
  pending.value = action; error.value = ''
  try { await roundtableApi.control(room.value.id, action, room.value.revision, actionReason.value.trim()); showStop.value = false; showAcceptance.value = false; actionReason.value = ''; emit('refresh') }
  catch (reason) { error.value = reason instanceof Error ? reason.message : copy('操作失败', 'Action failed'); emit('refresh') }
  finally { pending.value = '' }
}
async function send() {
  if (!body.value.trim() || pending.value) return
  pending.value = 'message'; error.value = ''
  try { await roundtableApi.message(room.value.id, body.value.trim()); body.value = ''; emit('refresh') }
  catch (reason) { error.value = reason instanceof Error ? reason.message : copy('发送失败', 'Could not send') }
  finally { pending.value = '' }
}
const actionLabels: Record<string, string> = {
  start: '开始圆桌 · Starting roundtable', pause: '暂停圆桌 · Pausing roundtable', resume: '恢复圆桌 · Resuming roundtable', stop: '停止圆桌 · Stopping roundtable',
  advance_phase: '推进圆桌阶段 · Advancing roundtable phase', next_round: '开启下一轮讨论 · Starting next discussion round',
  retry_turn: '重试当前回合 · Retrying current turn', skip_turn: '记录跳过回合 · Recording skipped turn', complete: '记录人工验收 · Recording human acceptance',
  update_limits: '更新圆桌停止条件 · Updating roundtable limits',
}
</script>

<template>
  <div class="rt-detail">
    <section class="rt-panel rt-room-heading"><div class="rt-section-heading"><span class="rt-eyebrow">{{ label(room.mode) }} · {{ room.binding?.projectId || copy('独立临时任务', 'Independent temporary task') }}</span><span class="rt-tag" :data-status="room.status">{{ label(room.status) }}</span></div><h1>{{ room.goal }}</h1>
      <div class="rt-meta"><span>{{ copy('阶段', 'Phase') }}: {{ label(room.phase) }}</span><span>{{ copy('讨论轮数', 'Discussion rounds') }}: {{ room.round ?? 0 }} / {{ room.limits.maxRounds }}</span><span>{{ copy('Agent 发言', 'Agent messages') }}: {{ room.agentMessageCount ?? 0 }} / {{ room.limits.maxMessages }}</span><span>{{ copy('总时限', 'Time limit') }}: {{ Math.round(room.limits.maxDurationMs / 60000) }} {{ copy('分钟', 'min') }}</span></div>
      <p v-if="room.stopReason" class="rt-warning">{{ copy('当前原因', 'Current reason') }}: {{ room.stopReason }}</p>
      <div class="rt-actions"><button v-if="room.status === 'draft'" class="rt-primary" type="button" :disabled="!!pending || !seatsReady" @click="control('start')">{{ copy('开始圆桌', 'Start roundtable') }}</button><button v-if="room.status === 'active'" type="button" :disabled="!!pending" @click="control('pause')">{{ copy('暂停', 'Pause') }}</button><button v-if="['paused', 'waiting_auth', 'waiting_input'].includes(room.status) && !(room.phase === 'synthesis' && snapshot.outcome && !snapshot.currentTurn)" type="button" :disabled="!!pending || !canResume" @click="control('resume')">{{ copy('恢复', 'Resume') }}</button><button v-if="!terminal" type="button" :disabled="!!pending" @click="showStop = !showStop">{{ copy('停止', 'Stop') }}</button><button type="button" :disabled="refreshing || !!pending" @click="emit('refresh')">{{ copy('刷新', 'Refresh') }}</button></div>
      <p v-if="room.status === 'draft' && !seatsReady" class="rt-muted">{{ copy('先邀请所有席位，在各参与端完成预检并加入后开始。选择平台不会自动启动工作端。', 'Invite every seat and complete preflight and joining on each worker before starting. Choosing an adapter does not start a worker.') }}</p>
      <GrowthLoading v-if="pending && pending !== 'message'" variant="inline" :label="actionLabels[pending] || '更新圆桌 · Updating roundtable'" />
      <div v-if="showStop" class="rt-confirm"><p>{{ copy('停止将拒绝新回合并请求取消当前运行。外部进程是否已取消，以工作端回执为准。', 'Stopping blocks new turns and requests cancellation of the current run. Worker receipts confirm whether external execution stopped.') }}</p><label class="rt-field">{{ copy('停止原因（可选）', 'Stop reason (optional)') }}<input v-model="actionReason" maxlength="2000" /></label><button type="button" :disabled="!!pending" @click="control('stop')">{{ copy('确认停止', 'Confirm stop') }}</button></div>
      <p v-if="error" class="rt-error" role="alert">{{ error }}</p>
      <details v-if="!terminal" class="rt-advanced"><summary>{{ copy('由你修改停止条件', 'Change limits explicitly') }}</summary><p class="rt-muted">{{ copy('修改后仍需明确恢复；总时限从最初开始时间计算。服务端限制可设置的最大预算，Agent 不会自动扩展。', 'After updating, resume explicitly. Total duration is measured from the original start. The server caps the allowed budget; agents do not increase it automatically.') }}</p><form class="rt-budget-form" @submit.prevent="updateLimits"><div class="rt-limit-form"><label class="rt-field">{{ copy('讨论轮数', 'Discussion rounds') }}<input v-model.number="budgetRounds" type="number" min="1" max="3" required /></label><label class="rt-field">{{ copy('Agent 发言上限', 'Agent message limit') }}<input v-model.number="budgetMessages" type="number" min="1" max="30" required /></label><label class="rt-field">{{ copy('总时限（分钟）', 'Total minutes') }}<input v-model.number="budgetMinutes" type="number" min="0.1" step="0.1" max="30" required /></label><label class="rt-field">{{ copy('单回合（分钟）', 'Minutes per turn') }}<input v-model.number="budgetTurnMinutes" type="number" min="0.1" step="0.1" max="5" required /></label></div><button type="submit" :disabled="!!pending">{{ copy('确认修改停止条件', 'Confirm limit changes') }}</button></form></details>
    </section>
    <RoundtableSeats :room="room" :active-seat-id="snapshot.currentTurn?.seatId" @changed="emit('refresh')" />
    <section class="rt-panel" aria-labelledby="rt-messages-title"><div class="rt-section-heading"><h2 id="rt-messages-title">{{ copy('公开讨论', 'Shared discussion') }}</h2><span>{{ snapshot.messages.length }} {{ copy('条记录', 'records') }}</span></div>
      <div v-if="snapshot.currentTurn" class="rt-current-turn"><strong>{{ copy('当前回合', 'Current turn') }} · {{ seatName(snapshot.currentTurn.seatId) }}</strong><span>{{ label(snapshot.currentTurn.status) }} · {{ label(snapshot.currentTurn.phase) }}</span><small v-if="snapshot.currentTurn.deadline">{{ copy('期限', 'Deadline') }}: {{ time(snapshot.currentTurn.deadline) }}</small></div>
      <div class="rt-messages" aria-live="polite" aria-relevant="additions"><article v-for="message in snapshot.messages" :key="message.id" class="rt-message" :class="{ 'rt-message-user': ['user', 'human'].includes(message.kind), 'rt-message-system': message.kind === 'system' }"><div class="rt-section-heading"><strong>{{ message.kind === 'human' ? copy('你', 'You') : seatName(message.seatId) }}</strong><span>{{ label(message.kind) }} · #{{ message.seq }}</span></div><p class="rt-message-body">{{ message.body }}</p><small>{{ time(message.createdAt) }}</small></article><p v-if="!snapshot.messages.length" class="rt-empty">{{ copy('这里会保存按顺序发布的提案、审查、交接和补充要求。', 'Ordered proposals, reviews, handoffs and your additions will appear here.') }}</p></div>
      <button v-if="snapshot.hasMore" type="button" :disabled="refreshing" @click="emit('refresh')">{{ copy('读取后续消息', 'Load remaining messages') }}</button>
      <form v-if="!terminal" class="rt-input-form" @submit.prevent="send"><label class="rt-field">{{ copy('补充要求', 'Add a requirement') }}<textarea v-model="body" maxlength="16000" rows="3" :placeholder="copy('所有获授权席位可见。不要填写凭据或他人的私有记忆。', 'Visible to all authorized seats. Keep credentials and others’ private memory out.')" /></label><button type="submit" :disabled="!body.trim() || !!pending"><GrowthLoading v-if="pending === 'message'" variant="inline" label="发送补充要求 · Sending requirement" /><span v-else>{{ copy('发送', 'Send') }}</span></button></form>
      <details v-if="!terminal" class="rt-advanced"><summary>{{ copy('主持与恢复操作', 'Moderation and recovery') }}</summary><p class="rt-muted">{{ copy('每位参与者完成回合后自动安排下一位和下一轮。完整一轮之后，可在下一轮开始前提前推进阶段。服务端检查阶段、预算与任务依赖，必需实施和审查不能跳过。', 'Turns and rounds advance automatically as participants finish. After a complete round, you may advance the phase before the next round starts. The server checks phases, limits and dependencies; required implementation and review cannot be skipped.') }}</p><label class="rt-field">{{ copy('操作原因（跳过回合时必填）', 'Reason (required when skipping a turn)') }}<input v-model="actionReason" maxlength="2000" /></label><div class="rt-actions"><button type="button" :disabled="!!pending || !canAdvance" @click="control('advance_phase')">{{ copy('提前推进阶段', 'Advance phase early') }}</button><button type="button" :disabled="!!pending || !canRetry" @click="control('retry_turn')">{{ copy('重试回合', 'Retry turn') }}</button><button type="button" :disabled="!!pending || !canSkip || !actionReason.trim()" @click="control('skip_turn')">{{ copy('记录并跳过回合', 'Record and skip turn') }}</button></div></details>
    </section>
    <RoundtableResults :snapshot="snapshot" />
    <RoundtableEvents :snapshot="snapshot" />
    <section v-if="room.status === 'waiting_input' && room.phase === 'synthesis' && snapshot.outcome" class="rt-panel"><h2>{{ copy('由你验收', 'Your acceptance') }}</h2><p>{{ copy('检查结论、保留分歧、产物和验证报告后，明确记录是否接受交付。人工接受不会制造模型用量或工作进程证据。', 'Review the conclusion, dissent, artifacts and verification reports before accepting delivery. Acceptance does not create model usage or worker evidence.') }}</p><button type="button" :disabled="!!pending" @click="showAcceptance = !showAcceptance">{{ copy('检查并接受交付', 'Review and accept delivery') }}</button><div v-if="showAcceptance" class="rt-confirm"><p>{{ copy('此操作记录你的人工验收，并结束本圆桌。', 'This records your acceptance and concludes this room.') }}</p><button class="rt-primary" type="button" :disabled="!!pending" @click="control('complete')">{{ copy('确认接受交付', 'Confirm acceptance') }}</button><button type="button" @click="showAcceptance = false">{{ copy('继续检查', 'Keep reviewing') }}</button></div></section>
  </div>
</template>
