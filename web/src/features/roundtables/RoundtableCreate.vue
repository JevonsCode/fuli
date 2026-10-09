<script setup lang="ts">
import { computed, ref } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { copy, label } from './copy'
import { roundtableApi, type RoundtableRole, type RoundtableRuntime, type RoundtableSeat } from './roundtable-api'
const emit = defineEmits<{ created: [id: string]; cancel: [] }>()
const goal = ref('')
const mode = ref<'discussion' | 'collaboration'>('discussion')
const seats = ref<RoundtableSeat[]>([
  { id: 'seat-1', name: 'Codex', role: 'moderator', runtime: 'codex' },
  { id: 'seat-2', name: 'Claude', role: 'reviewer', runtime: 'claude-code' },
])
const roles: RoundtableRole[] = ['moderator', 'specialist', 'implementer', 'reviewer']
const runtimes: RoundtableRuntime[] = ['codex', 'claude-code', 'pi', 'mcp', 'grok', 'a2a']
const projectPath = ref('')
const existingTaskId = ref(''), artifactRevision = ref<number | undefined>()
const maxRounds = ref(3), maxMessages = ref(30), durationMinutes = ref(30), turnMinutes = ref(5)
const pending = ref(false), error = ref('')
const writePermissions = ref<Record<string, boolean>>({})
const workspaces = ref<Record<string, string>>({})
let nextSeat = 3
const valid = computed(() => goal.value.trim() && seats.value.length >= 2 && seats.value.length <= 6
  && seats.value.every(seat => seat.name.trim()) && seats.value.filter(seat => seat.role === 'moderator').length === 1
  && seats.value.every(seat => mode.value !== 'collaboration' || seat.role !== 'implementer' || !writePermissions.value[seat.id] || workspaces.value[seat.id]?.trim())
  && (mode.value === 'discussion' || (seats.value.some(seat => seat.role === 'implementer') && seats.value.some(seat => seat.role === 'reviewer'))))
function addSeat() { seats.value.push({ id: `seat-${nextSeat++}`, name: '', role: 'specialist', runtime: 'mcp' }) }
async function create() {
  if (!valid.value || pending.value) return
  pending.value = true; error.value = ''
  try {
    const room = await roundtableApi.create({ goal: goal.value.trim(), mode: mode.value,
      seats: seats.value.map(seat => ({ ...seat, name: seat.name.trim(),
        ...(seat.role === 'implementer' && mode.value === 'collaboration' && writePermissions.value[seat.id]
          ? { execution: { permission: 'workspace-write' as const, workspace: workspaces.value[seat.id]!.trim() } } : {}),
      })),
      limits: { maxRounds: maxRounds.value, maxMessages: maxMessages.value, maxDurationMs: durationMinutes.value * 60000, turnTimeoutMs: turnMinutes.value * 60000 },
      ...(projectPath.value.trim() ? { projectPath: projectPath.value.trim() } : {}),
      ...(projectPath.value.trim() && existingTaskId.value.trim() ? { binding: { taskId: existingTaskId.value.trim(), ...(Number.isSafeInteger(artifactRevision.value) ? { artifactRevision: artifactRevision.value } : {}) } } : {}),
    })
    emit('created', room.id)
  } catch (reason) { error.value = reason instanceof Error ? reason.message : copy('创建失败', 'Creation failed') }
  finally { pending.value = false }
}
</script>

<template>
  <section class="rt-panel rt-create" aria-labelledby="rt-create-title">
    <div class="rt-section-heading"><h2 id="rt-create-title">{{ copy('创建圆桌', 'Create a roundtable') }}</h2><button type="button" @click="emit('cancel')" :disabled="pending">{{ copy('关闭', 'Close') }}</button></div>
    <form @submit.prevent="create">
      <label class="rt-field">{{ copy('共同目标', 'Shared goal') }}<textarea v-model="goal" required maxlength="12000" rows="3" :placeholder="copy('描述要一起解决的问题和期望的交付', 'Describe the problem and expected deliverable')" /></label>
      <label class="rt-field">{{ copy('方式', 'Mode') }}<select v-model="mode"><option value="discussion">{{ label('discussion') }}</option><option value="collaboration">{{ label('collaboration') }}</option></select></label>
      <div class="rt-section-heading"><h3>{{ copy('参与席位', 'Seats') }}</h3><span>{{ seats.length }} / 6</span></div>
      <p class="rt-muted">{{ copy('每位参与者有独立席位。选择入口后，还需要在参与者的电脑上启动工作端，或从 MCP 客户端主动加入。', 'Each participant has its own seat. After choosing an adapter, start a worker on the participant’s computer or actively join from an MCP client.') }}</p>
      <div v-for="(seat, index) in seats" :key="seat.id" class="rt-seat-form">
        <label class="rt-field">{{ copy('姓名', 'Name') }}<input v-model="seat.name" required maxlength="120" :aria-label="`${copy('姓名', 'Name')} ${index + 1}`" /></label>
        <label class="rt-field">{{ copy('职责', 'Role') }}<select v-model="seat.role" :aria-label="`${copy('职责', 'Role')} ${index + 1}`"><option v-for="role in roles" :key="role" :value="role">{{ label(role) }}</option></select></label>
        <label class="rt-field">{{ copy('参与方式', 'Adapter') }}<select v-model="seat.runtime" :aria-label="`${copy('参与方式', 'Adapter')} ${index + 1}`"><option v-for="runtime in runtimes" :key="runtime" :value="runtime">{{ label(runtime) }}</option></select></label>
        <button type="button" :disabled="seats.length <= 2 || pending" :aria-label="`${copy('移除', 'Remove')} ${seat.name || index + 1}`" @click="seats.splice(index, 1)">×</button>
        <div v-if="seat.role === 'implementer' && mode === 'collaboration'" class="rt-seat-permission"><label><input v-model="writePermissions[seat.id]" type="checkbox" /> {{ copy('允许此实施席位写入指定工作区', 'Allow this implementer to write to the specified workspace') }}</label><label v-if="writePermissions[seat.id]" class="rt-field">{{ copy('获授权工作区路径', 'Authorized workspace path') }}<input v-model="workspaces[seat.id]" required /></label></div>
      </div>
      <button type="button" :disabled="seats.length >= 6 || pending" @click="addSeat">{{ copy('添加席位', 'Add seat') }}</button>
      <p v-if="!valid && goal.trim()" class="rt-warning">{{ copy('需要 2–6 个有姓名的席位和一位主持人；协作任务还需要实施者和审查者。', 'Use 2–6 named seats and exactly one moderator. Collaborative tasks also require an implementer and a reviewer.') }}</p>
      <details class="rt-advanced"><summary>{{ copy('停止条件与项目', 'Limits and project') }}</summary>
        <label class="rt-field">{{ copy('已登记项目的本机路径（可选）', 'Registered local project path (optional)') }}<input v-model="projectPath" :placeholder="copy('留空建立独立临时圆桌', 'Leave blank for an independent temporary room')" /></label>
        <p class="rt-muted">{{ copy('项目绑定由服务端验证。跨电脑工作端的本地路径单独设置；加入席位不会授权读取他人的私有记忆。', 'The server validates project binding. Each worker sets its own local path; joining does not authorize access to another participant’s private memory.') }}</p>
        <template v-if="projectPath.trim()"><label class="rt-field">{{ copy('关联已有 Fuli 任务 ID（可选）', 'Existing Fuli task ID (optional)') }}<input v-model="existingTaskId" /></label><label v-if="existingTaskId.trim()" class="rt-field">{{ copy('产物版本（用于任务验证）', 'Artifact revision (for task verification)') }}<input v-model.number="artifactRevision" type="number" min="0" step="1" /></label><p class="rt-muted">{{ copy('关联项目本身不会完成 Fuli 任务。关联已有任务时，交付还要通过该任务的验证门槛；独立圆桌的人工验收只结束圆桌。', 'A project link alone does not complete a Fuli task. Linking an existing task adds its verification gate; human acceptance of an independent room concludes only the room.') }}</p></template>
        <div class="rt-limit-form"><label class="rt-field">{{ copy('讨论轮数', 'Discussion rounds') }}<input v-model.number="maxRounds" type="number" min="1" max="3" required /></label><label class="rt-field">{{ copy('Agent 发言上限', 'Agent message limit') }}<input v-model.number="maxMessages" type="number" min="1" max="30" required /></label><label class="rt-field">{{ copy('总时限（分钟）', 'Total minutes') }}<input v-model.number="durationMinutes" type="number" min="1" max="30" required /></label><label class="rt-field">{{ copy('单回合（分钟）', 'Minutes per turn') }}<input v-model.number="turnMinutes" type="number" min="1" max="5" required /></label></div>
      </details>
      <p v-if="mode === 'collaboration'" class="rt-muted">{{ copy('实施席位仍需要在工作端明确授权工作区写入；审查默认只读。执行结果等待你的验收。', 'Implementation still requires explicit workspace write permission on the worker. Reviews default to read only. Results await your acceptance.') }}</p>
      <p v-if="error" role="alert" class="rt-error">{{ error }}</p>
      <button type="submit" class="rt-primary" :disabled="!valid || pending"><GrowthLoading v-if="pending" variant="inline" label="创建圆桌 · Creating roundtable" /><span v-else>{{ copy('创建草案', 'Create draft') }}</span></button>
    </form>
  </section>
</template>
