<script setup lang="ts">
import { computed } from 'vue'
import { artifactText, copy, label, time } from './copy'
import type { RoundtableSnapshot } from './roundtable-api'
const props = defineProps<{ snapshot: RoundtableSnapshot }>()
const receipts = computed(() => props.snapshot.messages.filter(message => message.actual))
const dissent = computed(() => props.snapshot.messages.filter(message => message.kind === 'dissent'))
const artifacts = computed(() => [...(props.snapshot.outcome?.artifacts ?? []), ...props.snapshot.tasks.flatMap(task => task.artifacts ?? [])])
const seatName = (id: string | null) => props.snapshot.room.seats.find(seat => seat.id === id)?.name ?? id ?? copy('系统', 'System')
function dissentText(value: unknown) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const report = value as Record<string, unknown>
    if (typeof report.body === 'string') return report.body
    if (typeof report.reason === 'string') return report.reason
  }
  return artifactText(value)
}
function reportText(value: unknown) {
  return value == null ? copy('未报告', 'Not reported') : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
function usage(value: Record<string, unknown> | null | undefined) {
  if (!value || !Object.keys(value).length) return copy('未知', 'Unknown')
  return Object.entries(value).filter(([, count]) => typeof count === 'number').map(([name, count]) => `${name}: ${count}`).join(' · ') || copy('未知', 'Unknown')
}
</script>

<template>
  <section class="rt-panel" aria-labelledby="rt-results-title"><div class="rt-section-heading"><h2 id="rt-results-title">{{ copy('结果与证据', 'Results and evidence') }}</h2><span v-if="snapshot.outcome" class="rt-tag">{{ label(snapshot.outcome.acceptance) }}</span></div>
    <template v-if="snapshot.outcome"><p class="rt-message-body">{{ snapshot.outcome.body }}</p><p class="rt-muted">{{ copy('Agent 报告的结论保留为报告；人工验收和任务验证分别记录。', 'Agent conclusions remain reports. Human acceptance and task verification are recorded separately.') }}</p><details v-if="snapshot.outcome.verification?.reported != null" class="rt-advanced"><summary>{{ copy('汇总验证报告', 'Outcome verification report') }}</summary><p class="rt-message-body">{{ reportText(snapshot.outcome.verification.reported) }}</p><p class="rt-muted">{{ snapshot.outcome.verification.confirmed ? copy('服务端记录为已确认', 'Recorded as confirmed by server') : copy('参与端报告，尚未确认', 'Participant report, not confirmed') }}</p></details></template>
    <p v-else class="rt-empty">{{ copy('尚未提交最终结论。讨论、任务报告与实际执行记录会持续保留。', 'No final outcome has been submitted. Discussion, task reports and execution records are preserved.') }}</p>
    <h3>{{ copy('任务', 'Tasks') }}</h3><div v-if="snapshot.tasks.length" class="rt-table-scroll"><table><thead><tr><th>{{ copy('任务 / 阶段', 'Task / phase') }}</th><th>{{ copy('负责人', 'Assignee') }}</th><th>{{ copy('权限', 'Permission') }}</th><th>{{ copy('状态', 'Status') }}</th><th>{{ copy('依赖', 'Dependencies') }}</th></tr></thead><tbody><tr v-for="task in snapshot.tasks" :key="task.id"><td>{{ task.title || task.id }}<small>{{ label(task.phase) }}</small></td><td>{{ seatName(task.seatId) }}</td><td>{{ label(task.permission) }}</td><td>{{ label(task.status) }}</td><td>{{ task.dependencies?.join(', ') || '—' }}</td></tr></tbody></table></div><p v-else class="rt-muted">{{ copy('本圆桌尚无执行任务。讨论消息不算工作进程执行。', 'No execution tasks in this room. Discussion messages are not worker execution.') }}</p>
    <div v-for="task in snapshot.tasks.filter(item => item.verification != null)" :key="task.id"><details class="rt-advanced"><summary>{{ copy('任务验证报告', 'Task verification report') }} · {{ task.title || task.id }}</summary><p class="rt-message-body">{{ reportText(task.verification) }}</p></details></div>
    <h3>{{ copy('保留的分歧', 'Retained dissent') }}</h3><article v-for="message in dissent" :key="message.id" class="rt-dissent"><strong>{{ seatName(message.seatId) }} · #{{ message.seq }}</strong><p class="rt-message-body">{{ message.body }}</p></article><p v-for="(item, index) in snapshot.outcome?.dissent ?? []" :key="index" class="rt-message-body">{{ dissentText(item) }}</p><p v-if="!dissent.length && !snapshot.outcome?.dissent?.length" class="rt-muted">{{ copy('尚未记录分歧。', 'No dissent recorded.') }}</p>
    <h3>{{ copy('产物引用', 'Artifact references') }}</h3><ul v-if="artifacts.length" class="rt-artifacts"><li v-for="(artifact, index) in artifacts" :key="index">{{ artifactText(artifact) }}</li></ul><p v-else class="rt-muted">{{ copy('尚无产物引用。', 'No artifact references reported.') }}</p>
    <h3>{{ copy('实际运行回执', 'Actual runtime receipts') }}</h3><p class="rt-muted">{{ copy('只展示提交了运行来源的回执；来源由参与端报告，未独立验证运行时身份。加入、选择平台或配置席位不产生执行行；用量缺失时显示未知。', 'Only submitted runtime source receipts appear here. Sources are participant reports; runtime identity is not independently verified. Joining or configuring a seat does not create an execution row; missing usage stays unknown.') }}</p>
    <div v-if="receipts.length" class="rt-table-scroll"><table data-testid="runtime-receipts"><thead><tr><th>{{ copy('席位 / 消息', 'Seat / message') }}</th><th>{{ copy('报告的应用', 'Reported application') }}</th><th>{{ copy('报告的模型', 'Reported model') }}</th><th>{{ copy('会话', 'Session') }}</th><th>{{ copy('用量', 'Usage') }}</th><th>{{ copy('证据来源', 'Provenance') }}</th><th>{{ copy('时间', 'Time') }}</th></tr></thead><tbody><tr v-for="message in receipts" :key="message.id"><td>{{ seatName(message.seatId) }}<small>#{{ message.seq }} · {{ label(message.kind) }}</small></td><td>{{ message.actual?.applicationLabel || message.actual?.reportedApplication || message.actual?.sourceApplication || copy('未知', 'Unknown') }}</td><td>{{ message.actual?.model || copy('未知', 'Unknown') }}</td><td>{{ message.actual?.sessionId || copy('未知', 'Unknown') }}</td><td>{{ usage(message.actual?.usage) }}</td><td>{{ copy('参与端报告', 'Participant reported') }}<small>{{ copy('身份未独立验证', 'Identity not independently verified') }}</small></td><td>{{ time(message.createdAt) }}</td></tr></tbody></table></div><p v-else class="rt-empty" data-testid="no-runtime-receipts">{{ copy('尚无实际运行回执。', 'No actual runtime receipts yet.') }}</p>
  </section>
</template>
