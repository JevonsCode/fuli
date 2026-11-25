<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { deleteJson, getJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { formatRelativeTime } from '@/lib/relative-time'
import { currentLocale, t } from '@/i18n'
import RunnerPermissions from './RunnerPermissions.vue'

import { devicesShape, directoryShape, inventoryShape, inviteShape, moveProblem, moveShape, requestProblem,
  type Device, type Directory, type Move } from './runner-ownership-model'

const props = defineProps<{ projectIds: string[] }>()
const devices = ref<Device[]>([]), directory = ref<Directory>({ ready: false, projects: [], moves: [] })
const busy = ref(false), loading = ref(false), message = ref(''), invitation = ref('')
const retiring = ref<{ device: string, pairing: string } | null>(null)
const name = ref(''), access = ref('all'), chosen = ref<string[]>(['global']), selectedDevice = ref('')
const project = ref(''), target = ref(''), reason = ref('')
const root = '/api/runners', moves = root + '/project-moves'
let timer: ReturnType<typeof setTimeout> | undefined
let active = true
let retry: { key: string, id: string } | null = null
const live = computed(() => devices.value.filter(row => !row.revokedAt))
const scopes = computed(() => ['global', ...(directory.value.ready ? directory.value.projects.filter(row => row.writableHere).map(row => row.project) : props.projectIds).map(id => 'project:' + id)])
const selected = computed(() => directory.value.projects.find(row => row.project === project.value))
const destinations = computed(() => selected.value?.owner === directory.value.device ? live.value :
  selected.value && live.value.some(row => row.fingerprint === selected.value?.owner) && directory.value.device ?
    [{ name: t('ownership.here'), fingerprint: directory.value.device }] : [])
watch(destinations, choices => { if (!choices.some(row => row.fingerprint === target.value)) target.value = choices[0]?.fingerprint ?? '' })
const deviceName = (id: string) => id === directory.value.device ? t('ownership.here') :
  devices.value.find(row => row.fingerprint === id)?.name ?? id.slice(0, 12)
const canCancel = (row: Move) => !['committed','aborted'].includes(row.decision ?? '') &&
  ['requested','preparing','inspected','target_frozen','frozen','graph','board','received','verified'].includes(row.step)
function schedule() {
  clearTimeout(timer)
  if (active && !busy.value && directory.value.moves.some(row => !['done','aborted'].includes(row.step))) {
    timer = setTimeout(() => { if (!busy.value) void refresh() }, 4000)
  }
}
async function refresh(more = false) {
  if (!active || loading.value) return
  loading.value = true
  message.value = ''
  const prior = more ? directory.value.projects : []
  const cursor = prior.at(-1)?.project
  try {
    const [paired, page] = await Promise.all([getJson(root, devicesShape),
      getJson(root + '/project-ownership' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''), directoryShape)])
    if (active) {
      devices.value = paired.runners
      directory.value = { ...page, projects: [...prior, ...page.projects] }
      if (!live.value.some(row => row.fingerprint === selectedDevice.value)) selectedDevice.value = live.value[0]?.fingerprint ?? ''
    }
  } catch (e) { if (active) message.value = requestProblem(e) }
  finally { loading.value = false; schedule() }
}
async function submit(action: () => Promise<void>) {
  if (busy.value || loading.value) return
  busy.value = true
  message.value = ''
  try { await action(); await refresh() }
  catch (e) { message.value = requestProblem(e) }
  finally { busy.value = false; schedule() }
}
function invite() {
  invitation.value = ''
  return submit(async () => {
    const reply = await postJson(root + '/invitations', { name: name.value.trim(),
      ...(access.value === 'selected' ? { scopes: chosen.value.filter(scope => scopes.value.includes(scope)) } : {}) }, inviteShape)
    invitation.value = reply.invitation
  })
}
function checkInventory(id: string) {
  return submit(async () => {
    retiring.value = null
    const status = await getJson(root + '/' + id + '/historical-inventory', inventoryShape)
    if (status.revokedAt && status.pairing && !status.retiredAt && !status.checkedAt) {
      retiring.value = { device: id, pairing: status.pairing }
    } else throw new Error(t('ownership.inventoryComplete'))
  })
}
function retireInventory() {
  const selected = retiring.value
  if (!selected) return
  return submit(async () => {
    await postJson(root + '/' + selected.device + '/historical-inventory', { pairing: selected.pairing }, inventoryShape)
    retiring.value = null
  })
}
function transfer() {
  const key = JSON.stringify([project.value, target.value, reason.value.trim()])
  if (retry?.key !== key) retry = { key, id: crypto.randomUUID() }
  const input = { project: project.value, target: target.value, reason: reason.value.trim(), moveId: retry.id }
  return submit(async () => { await postJson(moves, input, moveShape); retry = null; reason.value = '' })
}
function cancel(row: Move) {
  return submit(async () => { await deleteJson(moves + '?' + new URLSearchParams({ project: row.project, id: row.moveId }), undefined, moveShape) })
}
onMounted(() => { void refresh() })
onBeforeUnmount(() => { active = false; clearTimeout(timer) })
</script>
<template>
  <Card class="runner-ownership settings-card">
    <CardHeader><CardTitle as="h2">{{ t('ownership.title') }}</CardTitle></CardHeader>
    <div class="runner-sections">
        <form @submit.prevent="invite">
          <label>{{ t('ownership.name') }}<input v-model="name" maxlength="80" /></label>
          <label>{{ t('ownership.access') }}<select v-model="access">
            <option value="all">{{ t('ownership.all') }}</option><option value="selected">{{ t('ownership.selected') }}</option>
          </select></label>
          <fieldset v-if="access === 'selected'"><legend>{{ t('ownership.selected') }}</legend>
            <label v-for="scope in scopes" :key="scope"><input v-model="chosen" type="checkbox" :value="scope" /> {{ scope === 'global' ? t('ownership.global') : scope.slice(8) }}</label>
          </fieldset>
          <Button type="submit" size="sm" :disabled="busy || loading">{{ t('ownership.invite') }}</Button>
          <label v-if="invitation">{{ t('ownership.invitation') }}<textarea readonly :value="invitation" /></label>
        </form>
        <GrowthLoading v-if="loading || busy" variant="compact" :label="t(busy ? 'ownership.saving' : 'ownership.load')" />
        <p v-if="message" role="alert">{{ message }}</p>
        <template v-if="devices.length">
          <section v-if="live.length"><h3>{{ t('ownership.grants') }}</h3>
            <label>{{ t('ownership.computer') }} <select v-model="selectedDevice"><option v-for="row in live" :key="row.fingerprint" :value="row.fingerprint">{{ row.name }}</option></select></label>
            <RunnerPermissions v-if="selectedDevice" :key="selectedDevice" :fingerprint="selectedDevice" :scopes="scopes" />
          </section>
          <section v-if="devices.some(row => row.revokedAt)"><h3>{{ t('ownership.retired') }}</h3>
            <article v-for="row in devices.filter(row => row.revokedAt)" :key="row.fingerprint">
              <strong>{{ row.name }}</strong>
              <template v-if="retiring?.device === row.fingerprint">
                <p>{{ t('ownership.retireEffect') }}</p>
                <Button size="sm" :disabled="busy" @click="retireInventory">{{ t('ownership.retire') }}</Button>
                <Button size="sm" variant="outline" @click="retiring = null">{{ t('ownership.keep') }}</Button>
              </template>
              <Button v-else size="sm" variant="outline" :disabled="busy" @click="checkInventory(row.fingerprint)">{{ t('ownership.inspectInventory') }}</Button>
            </article>
          </section>
          <section v-if="directory.ready"><h3>{{ t('ownership.projects') }}</h3>
            <article v-for="row in directory.projects" :key="row.project">
              <strong>{{ row.project }}</strong> · {{ deviceName(row.owner) }}
              <span>{{ row.state !== 'owned' ? t('ownership.' + row.state) : row.gate?.state === 'closed' ? t('ownership.closed') : t(row.writableHere ? 'ownership.writable' : 'ownership.readonly') }}</span>
              <small v-if="row.source?.syncedAt">{{ t('ownership.checked') }} {{ formatRelativeTime(row.source.syncedAt, currentLocale()) }}</small>
              <small v-if="row.source && row.state === 'owned'">{{ t('ownership.' + row.source.status) }}</small>
            </article>
            <Button v-if="directory.more" type="button" size="sm" variant="outline" @click="refresh(true)">{{ t('ownership.more') }}</Button>
          </section>
          <p v-else-if="live.length">{{ t('ownership.preparing') }}</p>
          <form v-if="directory.ready && live.length && directory.projects.length" @submit.prevent="transfer">
            <h3>{{ t('ownership.newMove') }}</h3>
            <label>{{ t('ownership.scope') }}<select v-model="project" required><option disabled value="">—</option>
              <option v-for="row in directory.projects.filter(p => p.state === 'owned')" :key="row.project" :value="row.project">{{ row.project }}</option></select></label>
            <label>{{ t('ownership.destination') }}<select v-model="target" required><option v-for="row in destinations" :key="row.fingerprint" :value="row.fingerprint">{{ row.name }}</option></select></label>
            <label>{{ t('ownership.reason') }}<input v-model="reason" maxlength="2000" required /></label>
            <Button type="submit" size="sm" :disabled="busy || loading || !target || !reason.trim()">{{ t('ownership.start') }}</Button>
          </form>
          <section v-if="directory.moves.length"><h3>{{ t('ownership.moves') }}</h3>
            <article v-for="row in directory.moves" :key="row.moveId">
              <strong>{{ row.project }}</strong> · {{ deviceName(row.source) }} → {{ deviceName(row.target) }}
              <span>{{ t('ownership.' + row.step) }}</span><small v-if="row.reason">{{ moveProblem(row.reason) }}</small>
              <Button v-if="canCancel(row)" size="sm" variant="outline" :disabled="busy || loading" @click="cancel(row)">{{ t('ownership.cancel') }}</Button>
            </article>
          </section>
        </template>
        <p v-else-if="!loading && !message">{{ t('ownership.empty') }}</p>
        <Button type="button" size="sm" variant="outline" :disabled="loading || busy" @click="refresh()">{{ t('ownership.refresh') }}</Button>
    </div>
  </Card>
</template>
<style scoped>
.runner-ownership { padding: 18px; }
.runner-sections, section, form, article { display: grid; gap: 10px; }
.runner-sections { margin-top: 16px; gap: 18px; }
label { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
form > button, section > button, .runner-sections > button, article > button { justify-self: start; }
input, select, textarea { max-width: 100%; }
textarea { width: 100%; }
article { gap: 3px; }
small { color: var(--color-muted); }
</style>
