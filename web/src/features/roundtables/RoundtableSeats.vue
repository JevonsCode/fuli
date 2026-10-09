<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { copy, label, time } from './copy'
import { roundtableApi, type RoundtableInvite, type RoundtableRoom } from './roundtable-api'
const props = defineProps<{ room: RoundtableRoom; activeSeatId?: string }>()
const emit = defineEmits<{ changed: [] }>()
const invite = ref<RoundtableInvite | null>(null)
const pending = ref(''), error = ref(''), copied = ref('')
const workspace = ref('')
const coordinatorUrl = ref(typeof window === 'undefined' ? '' : window.location.origin)
const allowWrite = ref(false), a2aUrl = ref(''), piModel = ref('')
let disposed = false
watch(() => props.room.id, () => { invite.value = null; error.value = ''; copied.value = '' })
onBeforeUnmount(() => { disposed = true; invite.value = null })
async function issue(seatId: string) {
  if (pending.value) return
  pending.value = `invite:${seatId}`; error.value = ''; invite.value = null; copied.value = ''
  const roomId = props.room.id
  try { const result = await roundtableApi.invite(roomId, seatId); if (!disposed && props.room.id === roomId) invite.value = result }
  catch (reason) { error.value = reason instanceof Error ? reason.message : copy('创建邀请失败', 'Invitation failed') }
  finally { pending.value = '' }
}
async function revoke(seatId: string) {
  if (pending.value) return
  pending.value = `revoke:${seatId}`; error.value = ''
  try { await roundtableApi.revoke(props.room.id, seatId); if (invite.value?.seatId === seatId) invite.value = null; emit('changed') }
  catch (reason) { error.value = reason instanceof Error ? reason.message : copy('撤销失败', 'Revocation failed') }
  finally { pending.value = '' }
}
async function copyValue(value: string, name: string) {
  try { await navigator.clipboard.writeText(value); copied.value = name }
  catch { error.value = copy('剪贴板不可用，请手动选择并复制。', 'Clipboard unavailable. Select and copy manually.') }
}
function workerCommand() {
  const seat = props.room.seats.find(item => item.id === invite.value?.seatId)
  if (!seat || seat.runtime === 'mcp') return ''
  // PowerShell single quotes keep paths and URLs as literal arguments.
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`
  return `fl roundtable worker --url ${quoted(coordinatorUrl.value)} --room ${quoted(props.room.id)} --runtime ${seat.runtime} --workspace ${quoted(workspace.value || copy('参与端本地工作区', 'LOCAL_WORKSPACE'))}${allowWrite.value && seat.role === 'implementer' && seat.execution?.permission === 'workspace-write' ? ' --allow-write' : ''}${seat.runtime === 'a2a' ? ` --a2a-url ${quoted(a2aUrl.value || 'https://A2A_ENDPOINT')}` : ''}${seat.runtime === 'pi' ? ` --model ${quoted(piModel.value || 'LOCAL_MODEL')}` : ''}`
}
function mcpUrl() { return `${coordinatorUrl.value.replace(/\/$/, '')}/roundtable-peer/v1/rooms/${encodeURIComponent(props.room.id)}/mcp` }
</script>

<template>
  <section class="rt-panel" aria-labelledby="rt-seats-title"><div class="rt-section-heading"><h2 id="rt-seats-title">{{ copy('圆桌席位', 'Seats') }}</h2><span>{{ room.seats.length }}</span></div>
    <p class="rt-muted">{{ copy('邀请仅授予一个席位的权限。加入记录是历史证据，当前在线状态由工作端轮询和回合回执确定。', 'An invitation grants access to one seat. Join records are historical evidence; worker polling and turn receipts determine current activity.') }}</p>
    <div class="rt-seats"><article v-for="seat in room.seats" :key="seat.id" class="rt-seat" :class="{ 'rt-seat-current': seat.id === activeSeatId }">
      <div class="rt-section-heading"><strong>{{ seat.name }}</strong><span class="rt-tag">{{ label(seat.role) }}</span></div>
      <p>{{ label(seat.runtime) }}</p><p class="rt-muted">{{ seat.identityKind === 'fuli' ? copy('已绑定 Fuli 身份', 'Bound Fuli identity') : copy('独立任务席位', 'Independent task seat') }}</p>
      <p class="rt-muted">{{ seat.joinedAt ? `${copy('加入于', 'Joined')} ${time(seat.joinedAt)}` : copy('尚无加入记录', 'No join recorded') }}</p>
      <p v-if="seat.execution" class="rt-muted">{{ label(seat.execution.permission) }} · {{ seat.execution.workspace }}</p>
      <div class="rt-actions"><button type="button" :disabled="!!pending" @click="issue(seat.id)"><GrowthLoading v-if="pending === `invite:${seat.id}`" variant="inline" label="创建席位邀请 · Creating seat invitation" /><span v-else>{{ copy('邀请参与', 'Invite participant') }}</span></button><button type="button" :disabled="!!pending" @click="revoke(seat.id)"><GrowthLoading v-if="pending === `revoke:${seat.id}`" variant="inline" label="撤销席位凭据 · Revoking seat credentials" /><span v-else>{{ copy('撤销凭据', 'Revoke credentials') }}</span></button></div>
    </article></div>
    <p v-if="error" class="rt-error" role="alert">{{ error }}</p>
    <section v-if="invite" class="rt-invite" aria-labelledby="rt-invite-title"><div class="rt-section-heading"><h3 id="rt-invite-title">{{ copy('席位邀请 · 仅此次显示', 'Seat invitation · shown once') }}</h3><button type="button" @click="invite = null; copied = ''">{{ copy('隐藏凭据', 'Hide credential') }}</button></div>
      <p>{{ room.seats.find(seat => seat.id === invite?.seatId)?.name }} · {{ copy('有效期至', 'Expires') }} {{ time(invite.expiresAt) }}</p>
      <label class="rt-field">{{ copy('席位访问凭据', 'Seat credential') }}<input :value="invite.seatToken" readonly autocomplete="off" spellcheck="false" type="password" data-testid="seat-token" @focus="($event.target as HTMLInputElement).select()" /></label>
      <button type="button" @click="copyValue(invite.seatToken, 'token')">{{ copied === 'token' ? copy('凭据已复制', 'Credential copied') : copy('复制凭据', 'Copy credential') }}</button>
      <p class="rt-muted">{{ copy('只发给这一席位的参与者。凭据仅保留在当前页面内存；关闭后重新创建邀请，或撤销此前凭据。', 'Share only with this seat’s participant. This page keeps the credential only in memory. After closing, create a new invite or revoke previous credentials.') }}</p>
      <label class="rt-field">{{ copy('参与者可访问的协调端地址', 'Coordinator URL reachable by participant') }}<input v-model="coordinatorUrl" type="url" /></label><p class="rt-muted">{{ copy('另一台电脑需要可访问的 HTTPS 地址，并在协调端设置 public-url；本机测试可使用回环地址。', 'Another computer needs a reachable HTTPS URL configured as public-url on the coordinator. Loopback works for local testing.') }}</p>
      <template v-if="room.seats.find(seat => seat.id === invite?.seatId)?.runtime !== 'mcp'">
        <label class="rt-field">{{ copy('参与端本地工作区', 'Worker local workspace') }}<input v-model="workspace" :placeholder="copy('填写参与者电脑上的路径', 'Path on the participant’s computer')" /></label>
        <label v-if="room.seats.find(seat => seat.id === invite?.seatId)?.execution?.permission === 'workspace-write'"><input v-model="allowWrite" type="checkbox" /> {{ copy('工作端用户明确允许写入此工作区', 'The worker’s user explicitly permits writing to this workspace') }}</label>
        <label v-if="room.seats.find(seat => seat.id === invite?.seatId)?.runtime === 'a2a'" class="rt-field">{{ copy('A2A 端点', 'A2A endpoint') }}<input v-model="a2aUrl" type="url" placeholder="https://…" /></label>
        <label v-if="room.seats.find(seat => seat.id === invite?.seatId)?.runtime === 'pi'" class="rt-field">{{ copy('参与电脑上的 Ollama 模型', 'Ollama model on participant computer') }}<input v-model="piModel" placeholder="fuli-roundtable-qwen3-32k:latest" /></label>
        <p>{{ copy('在参与端 PowerShell 中，先设置环境变量，再启动工作端：', 'In the worker’s PowerShell, set the environment variable and start the worker:') }}</p>
        <pre><code>$env:FULI_ROUNDTABLE_TOKEN = '&lt;{{ copy('粘贴席位凭据', 'PASTE_SEAT_CREDENTIAL') }}&gt;'
{{ workerCommand() }}</code></pre>
        <button type="button" @click="copyValue(workerCommand(), 'command')">{{ copied === 'command' ? copy('命令已复制', 'Command copied') : copy('复制工作端命令', 'Copy worker command') }}</button>
        <p class="rt-muted">{{ copy('默认只读。实施写入还需工作端用户明确授权。Grok 需要工作端配置 XAI_API_KEY；A2A 需要配置可验证的端点。', 'Workers default to read only. Writing also requires explicit permission from the worker’s user. Grok requires XAI_API_KEY on the worker; A2A requires a verified endpoint.') }}</p>
      </template>
      <template v-else><p class="rt-muted">{{ copy('在 MCP 客户端配置下面的远程地址，将席位凭据作为 Bearer 认证秘密保存。Grok Team Bot 可在官方自定义 MCP 设置中配置此地址。', 'Configure this remote URL in the MCP client and save the seat credential as a Bearer authentication secret. Grok Team Bots can configure it through their official custom MCP settings.') }}</p><pre><code>{{ mcpUrl() }}</code></pre><button type="button" @click="copyValue(mcpUrl(), 'mcp')">{{ copied === 'mcp' ? copy('地址已复制', 'URL copied') : copy('复制 MCP 地址', 'Copy MCP URL') }}</button><p class="rt-muted">{{ copy('主动调用 join_roundtable，再通过 read_roundtable、claim_roundtable_turn、submit_roundtable_turn 参与自己的回合；参数 roomId 为下面的圆桌 ID。MCP 不会后台唤醒现有聊天。', 'Actively call join_roundtable, then use read_roundtable, claim_roundtable_turn and submit_roundtable_turn for your own turns, passing the room ID below as roomId. MCP does not wake existing chats in the background.') }}</p></template>
      <p class="rt-muted">{{ copy('协调端地址', 'Coordinator URL') }}: {{ coordinatorUrl }} · {{ copy('圆桌', 'Room') }}: {{ room.id }} · {{ copy('席位', 'Seat') }}: {{ invite.seatId }}</p>
    </section>
  </section>
</template>
