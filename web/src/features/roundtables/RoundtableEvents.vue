<script setup lang="ts">
import { copy, label, time } from './copy'
import type { RoundtableSnapshot } from './roundtable-api'
const props = defineProps<{ snapshot: RoundtableSnapshot }>()
const seatName = (id: string) => props.snapshot.room.seats.find(seat => seat.id === id)?.name ?? id
</script>
<template>
  <details class="rt-panel rt-event-details"><summary>{{ copy('回合尝试、恢复与历史事件', 'Turn attempts, recovery and history') }}</summary><p class="rt-muted">{{ copy('领取回合代表运行租约。下表保留失败、受阻、中断与取消请求，领取本身不证明已调用模型。', 'Claiming a turn creates a lease. This history retains failed, blocked and interrupted attempts and cancellation requests. A claim alone does not prove model execution.') }}</p>
    <div v-if="snapshot.attempts?.length" class="rt-table-scroll"><table data-testid="turn-attempts"><thead><tr><th>{{ copy('参与者', 'Participant') }}</th><th>{{ copy('尝试', 'Attempt') }}</th><th>{{ copy('状态', 'Status') }}</th><th>{{ copy('领取时间', 'Claimed at') }}</th><th>{{ copy('结束时间', 'Finished at') }}</th></tr></thead><tbody><tr v-for="attempt in snapshot.attempts" :key="`${attempt.turnId}:${attempt.id}`"><td>{{ seatName(attempt.seatId) }}</td><td>{{ attempt.id }}</td><td>{{ label(attempt.status) }}</td><td>{{ time(attempt.startedAt) }}</td><td>{{ attempt.finishedAt ? time(attempt.finishedAt) : '—' }}</td></tr></tbody></table></div><p v-else class="rt-muted">{{ copy('尚无回合尝试。', 'No turn attempts yet.') }}</p>
    <h3>{{ copy('过期结果存档', 'Stale result archive') }}</h3><p class="rt-muted">{{ copy('晚到结果保留在历史中，不替代当前讨论或交付结论。', 'Late results remain in history and do not replace current discussion or delivery outcomes.') }}</p><article v-for="result in snapshot.lateResults ?? []" :key="`${result.turnId}:${result.attemptId}`" class="rt-message"><strong>{{ seatName(result.seatId) }} · {{ time(result.receivedAt) }}</strong><p class="rt-message-body">{{ result.body }}</p><small>{{ result.turnId }} / {{ result.attemptId }}</small></article><p v-if="!snapshot.lateResults?.length" class="rt-muted">{{ copy('没有过期结果。', 'No stale results.') }}</p>
    <h3>{{ copy('状态事件', 'Status events') }}</h3><ol class="rt-events"><li v-for="event in snapshot.events ?? []" :key="event.id"><span>{{ label(event.kind) }}</span> · {{ time(event.createdAt) }}<small v-if="event.kind === 'cancellation_requested' && event.confirmed !== true"> · {{ copy('取消尚未确认', 'Cancellation not confirmed') }}</small></li></ol>
  </details>
</template>
