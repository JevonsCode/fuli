<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ApiError, getJson, postJson, putJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { t } from '@/i18n'

type ClientId = 'codex' | 'claude_code'

type Shareable = {
  projectId: string
  projectName: string
  lead: { agentId: string; name: string } | null
  clients: ClientId[]
}

type Share = {
  projectId: string
  projectName: string
  agentId: string
  clients: ClientId[]
  workingDirectory?: string | null
  state: 'shared' | 'lead_changed' | 'lead_unavailable'
}

type Device = {
  nodeId: string
  name: string
  shortFingerprint: string
  self?: boolean
  status: string
  online?: boolean
}

type PeerStatus = {
  beta: boolean
  remoteRemovalPending?: boolean
  role: 'coordinator' | 'member' | null
  device: { fingerprint: string; shortFingerprint: string } | null
  coordinator: { name: string; url: string; shortFingerprint: string; listening: boolean } | null
  addresses: string[]
  devices: Device[]
  openInvitations: number
  shares: Share[]
  shareable: Shareable[]
}

type ShareDraft = { selected: boolean; clients: ClientId[]; folder: string }

const status = ref<PeerStatus | null>(null)
const loading = ref(false)
const error = ref('')
const busy = ref('')
const hostAddress = ref('')
const hostName = ref('')
const joinInvitation = ref('')
const joinName = ref('')
const invitation = ref<{ invitation: string; fingerprint?: string; expiresAt?: string } | null>(null)
const inviteFeedback = ref<'copied' | 'manual' | ''>('')
const joiningDevice = ref<{ name: string; url: string; shortFingerprint: string } | null>(null)
const drafts = reactive<Record<string, ShareDraft>>({})

const addressOptions = computed(() => (status.value?.addresses ?? []).map((value) => ({ value, label: value })))
const paired = computed(() => Boolean(status.value?.role))
const coordinator = computed(() => status.value?.role === 'coordinator')
const otherDevices = computed(() => (status.value?.devices ?? []).filter((device) => !device.self))
watch(joinInvitation, () => { joiningDevice.value = null })

function apiMessage(caught: unknown, fallback: string) {
  if (caught instanceof ApiError && caught.detail) {
    try {
      const body = JSON.parse(caught.detail) as { message?: string }
      if (typeof body.message === 'string' && body.message.trim()) return body.message
    } catch { /* use fallback */ }
  }
  return fallback
}

function clientLabel(client: ClientId) {
  return client === 'claude_code' ? t('settings.peer.clientsClaude') : t('settings.peer.clientsCodex')
}

function applyStatus(next: PeerStatus) {
  status.value = next
  if (!hostAddress.value && next.addresses[0]) hostAddress.value = next.addresses[0]
  const known = new Set(next.shareable.map((project) => project.projectId))
  for (const key of Object.keys(drafts)) if (!known.has(key)) delete drafts[key]
  for (const project of next.shareable) {
    const existing = next.shares.find((share) => share.projectId === project.projectId)
    drafts[project.projectId] ??= {
      selected: Boolean(existing),
      clients: existing?.clients?.length ? existing.clients : project.clients.slice(0, 1),
      folder: existing?.workingDirectory ?? '',
    }
  }
}

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { applyStatus(await getJson<PeerStatus>('/api/peer')) }
  catch (caught) { error.value = apiMessage(caught, t('settings.peer.loadError')) }
  finally { loading.value = false }
}

function opened(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !status.value && !loading.value && !error.value) void load()
}

async function run(kind: string, work: () => Promise<PeerStatus | void>) {
  if (busy.value) return
  busy.value = kind
  error.value = ''
  try {
    const next = await work()
    if (next) applyStatus(next)
  } catch (caught) { error.value = apiMessage(caught, t('settings.peer.loadError')) }
  finally { busy.value = '' }
}

function host() {
  return run('host', () => postJson<PeerStatus>('/api/peer/coordinator', {
    host: hostAddress.value, port: 0, name: hostName.value.trim() || undefined,
  }))
}

function join() {
  if (!joiningDevice.value) return run('preview', async () => {
    const text = joinInvitation.value.trim()
    const preview = await postJson<{ name: string; url: string; shortFingerprint: string }>('/api/peer/invitations/preview', { invitation: text })
    if (joinInvitation.value.trim() === text) joiningDevice.value = preview
  })
  return run('join', () => postJson<PeerStatus>('/api/peer/join', {
    invitation: joinInvitation.value.trim(), name: joinName.value.trim() || undefined,
  }))
}

async function invite() {
  await run('invite', async () => {
    invitation.value = await postJson('/api/peer/invitations', {})
    inviteFeedback.value = ''
  })
}

async function copyInvite() {
  const text = invitation.value?.invitation
  if (!text) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(text)
    if (invitation.value?.invitation === text) inviteFeedback.value = 'copied'
  } catch { if (invitation.value?.invitation === text) inviteFeedback.value = 'manual' }
}

function toggleProject(project: Shareable, selected: boolean) {
  const draft = drafts[project.projectId]
  if (!draft) return
  draft.selected = selected
  if (selected && !draft.clients.length) draft.clients = project.clients.slice(0, 1)
}

function toggleClient(projectId: string, client: ClientId, selected: boolean) {
  const draft = drafts[projectId]
  if (!draft) return
  draft.clients = selected ? [...new Set([...draft.clients, client])] : draft.clients.filter((item) => item !== client)
}

function saveShares() {
  const shares = (status.value?.shareable ?? []).flatMap((project) => {
    const draft = drafts[project.projectId]
    if (!draft?.selected || !project.lead) return []
    return [{
      projectId: project.projectId,
      clients: draft.clients,
      ...(draft.folder.trim() ? { workingDirectory: draft.folder.trim() } : {}),
    }]
  })
  return run('shares', () => putJson<PeerStatus>('/api/peer/shares', { shares }))
}

function revoke(nodeId: string) {
  return run(`revoke:${nodeId}`, () => postJson<PeerStatus>(`/api/peer/devices/${nodeId}/revoke`, {}))
}

function disable() {
  return run('disable', async () => {
    const next = await postJson<PeerStatus>('/api/peer/disable', {})
    invitation.value = null
    joinInvitation.value = ''
    return next
  })
}

function shareState(projectId: string) {
  return status.value?.shares.find((share) => share.projectId === projectId)?.state ?? null
}
</script>

<template>
  <UiDisclosure class="settings-card peer-settings" :title="t('settings.peer.title')" @toggle="opened">
    <p>{{ t('settings.peer.description') }}</p>
    <GrowthLoading v-if="loading" variant="compact" :label="t('settings.peer.loading')" />
    <div v-if="error" class="peer-alert" role="alert">
      <span>{{ error }}</span>
      <UiButton size="sm" data-retry-peer :busy="loading" :busy-label="t('settings.peer.loading')" @click="load">
        {{ t('settings.peer.retry') }}
      </UiButton>
    </div>

    <template v-if="status && !paired">
      <p>{{ t('settings.peer.off') }}</p>
      <p v-if="status.remoteRemovalPending" role="status">{{ t('settings.peer.removalPending') }}</p>
      <section class="peer-block">
        <h4>{{ t('settings.peer.host') }}</h4>
        <p v-if="!status.addresses.length">{{ t('settings.peer.noAddress') }}</p>
        <div v-else class="peer-fields">
          <UiSelect control-id="peer-host-address" :model-value="hostAddress" :options="addressOptions"
            :label="t('settings.peer.hostAddress')" @update:model-value="hostAddress = $event" />
          <label>
            <span>{{ t('settings.peer.hostName') }}</span>
            <input v-model="hostName" type="text" maxlength="60" :disabled="Boolean(busy)" />
          </label>
          <UiButton variant="primary" size="sm" data-host-peer :disabled="!hostAddress"
            :busy="busy === 'host'" :busy-label="t('settings.peer.hosting')" @click="host">
            {{ t('settings.peer.hostAction') }}
          </UiButton>
        </div>
      </section>
      <section class="peer-block">
        <h4>{{ t('settings.peer.join') }}</h4>
        <label>
          <span>{{ t('settings.peer.invitation') }}</span>
          <textarea v-model="joinInvitation" rows="3" spellcheck="false" :disabled="Boolean(busy)"
            :placeholder="t('settings.peer.invitationPlaceholder')" :aria-label="t('settings.peer.invitation')" />
        </label>
        <label>
          <span>{{ t('settings.peer.joinName') }}</span>
          <input v-model="joinName" type="text" maxlength="60" :disabled="Boolean(busy)" />
        </label>
        <div v-if="joiningDevice" class="peer-identity" data-invitation-preview>
          <div><strong>{{ joiningDevice.name }}</strong><p>{{ joiningDevice.url }}</p></div>
          <div><p>{{ t('settings.peer.coordinatorFingerprint') }}</p><code>{{ joiningDevice.shortFingerprint }}</code></div>
          <p>{{ t('settings.peer.compare') }}</p>
        </div>
        <UiButton variant="primary" size="sm" data-join-peer :disabled="!joinInvitation.trim() || status.remoteRemovalPending"
          :busy="busy === 'join' || busy === 'preview'" :busy-label="t(joiningDevice ? 'settings.peer.joining' : 'settings.peer.previewing')" @click="join">
          {{ t(joiningDevice ? 'settings.peer.joinAction' : 'settings.peer.previewAction') }}
        </UiButton>
      </section>
    </template>

    <template v-if="status && paired">
      <dl class="peer-identity">
        <div>
          <dt>{{ t('settings.peer.fingerprint') }}</dt>
          <dd>{{ status.device?.shortFingerprint }}</dd>
        </div>
        <div>
          <dt>{{ t('settings.peer.coordinatorFingerprint') }}</dt>
          <dd>{{ status.coordinator?.shortFingerprint }}</dd>
        </div>
      </dl>

      <section v-if="coordinator" class="peer-block">
        <UiButton size="sm" data-invite-peer :busy="busy === 'invite'" :busy-label="t('settings.peer.inviting')" @click="invite">
          {{ t('settings.peer.invite') }}
        </UiButton>
        <p>{{ t('settings.peer.inviteHint') }}</p>
        <template v-if="invitation">
          <textarea :value="invitation.invitation" readonly rows="4" spellcheck="false" :aria-label="t('settings.peer.invitation')" />
          <div class="peer-actions">
            <UiButton size="sm" data-copy-invite @click="copyInvite">{{ t('settings.peer.copyInvite') }}</UiButton>
            <p v-if="inviteFeedback" role="status">{{ t(`settings.peer.${inviteFeedback === 'copied' ? 'copied' : 'copyManual'}`) }}</p>
          </div>
        </template>
      </section>

      <section class="peer-block">
        <h4>{{ t('settings.peer.shares') }}</h4>
        <p>{{ t('settings.peer.sharesHint') }}</p>
        <p v-if="!status.shareable.length">{{ t('settings.peer.noProjects') }}</p>
        <ul v-else class="peer-shares">
          <li v-for="project in status.shareable" :key="project.projectId">
            <label class="peer-share-title">
              <input type="checkbox" :checked="drafts[project.projectId]?.selected"
                :disabled="!project.lead || Boolean(busy)"
                @change="toggleProject(project, ($event.target as HTMLInputElement).checked)" />
              <strong>{{ project.projectName }}</strong>
            </label>
            <small>{{ project.lead ? t('settings.peer.lead', { name: project.lead.name }) : t('settings.peer.noLead') }}</small>
            <p v-if="shareState(project.projectId) === 'lead_changed'" class="peer-note">{{ t('settings.peer.leadChanged') }}</p>
            <p v-if="shareState(project.projectId) === 'lead_unavailable'" class="peer-note">{{ t('settings.peer.leadUnavailable') }}</p>
            <fieldset v-if="drafts[project.projectId]?.selected && project.lead" :disabled="Boolean(busy)">
              <legend>{{ t('settings.peer.clients') }}</legend>
              <label v-for="client in project.clients" :key="client">
                <input type="checkbox" :checked="drafts[project.projectId]?.clients.includes(client)"
                  @change="toggleClient(project.projectId, client, ($event.target as HTMLInputElement).checked)" />
                {{ clientLabel(client) }}
              </label>
            </fieldset>
            <label v-if="drafts[project.projectId]?.selected && project.lead">
              <span>{{ t('settings.peer.folder') }}</span>
              <input v-model="drafts[project.projectId].folder" type="text" :disabled="Boolean(busy)" />
              <small>{{ t('settings.peer.folderHint') }}</small>
            </label>
          </li>
        </ul>
        <UiButton v-if="status.shareable.length" variant="primary" size="sm" data-save-shares
          :busy="busy === 'shares'" :busy-label="t('settings.peer.savingShares')" @click="saveShares">
          {{ t('settings.peer.saveShares') }}
        </UiButton>
      </section>

      <section v-if="coordinator && otherDevices.length" class="peer-block">
        <h4>{{ t('settings.peer.devices') }}</h4>
        <ul class="peer-devices">
          <li v-for="device in otherDevices" :key="device.nodeId">
            <div>
              <strong>{{ device.name }}</strong>
              <small>{{ device.shortFingerprint }} · {{ device.online ? t('settings.peer.online') : t('settings.peer.offline') }}</small>
            </div>
            <UiButton size="sm" variant="danger" :data-revoke="device.nodeId"
              :busy="busy === `revoke:${device.nodeId}`" :busy-label="t('settings.peer.revoking')"
              @click="revoke(device.nodeId)">
              {{ t('settings.peer.revoke') }}
            </UiButton>
          </li>
        </ul>
      </section>

      <p>{{ t('settings.peer.disableHint') }}</p>
      <UiButton size="sm" data-disable-peer :busy="busy === 'disable'" :busy-label="t('settings.peer.disabling')" @click="disable">
        {{ t('settings.peer.disable') }}
      </UiButton>
    </template>
  </UiDisclosure>
</template>

<style scoped>
.peer-settings p, .peer-settings small { color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.peer-settings p { margin: 12px 0; }
.peer-alert, .peer-actions, .peer-identity, .peer-fields, .peer-share-title, .peer-devices li {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
}
.peer-block { display: grid; gap: 12px; margin: 16px 0; min-width: 0; }
.peer-block h4 { font-size: 13px; font-weight: 650; }
.peer-fields { align-items: end; }
.peer-fields :deep(.ui-select) { min-width: 0; flex: 1 1 180px; }
.peer-identity { margin: 12px 0; }
.peer-identity div { min-width: 0; flex: 1 1 160px; }
.peer-identity dt { color: var(--color-muted); font-size: 12px; }
.peer-identity dd, .peer-identity code, .peer-identity strong, .peer-identity p { overflow-wrap: anywhere; }
.peer-identity dd { font-family: var(--font-mono); font-size: 13px; }
.peer-settings label { display: grid; gap: 6px; min-width: 0; color: var(--color-muted); font-size: 12px; }
.peer-settings input[type='text'], .peer-settings textarea {
  box-sizing: border-box; width: 100%; min-width: 0; overflow-wrap: anywhere;
}
.peer-settings textarea { resize: vertical; font: 12px/1.65 var(--font-mono); }
.peer-shares, .peer-devices { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
.peer-shares li, .peer-devices li {
  min-width: 0; padding: 12px 0; border-top: 1px solid var(--color-border);
}
.peer-share-title { display: flex; align-items: flex-start; gap: 8px; }
.peer-share-title strong { overflow-wrap: anywhere; color: var(--color-ink); font-size: 14px; }
.peer-shares fieldset { display: flex; flex-wrap: wrap; gap: 12px 16px; border: 0; padding: 0; }
.peer-shares fieldset label { display: flex; align-items: center; gap: 6px; }
.peer-devices li { justify-content: space-between; }
.peer-devices strong, .peer-devices small { display: block; overflow-wrap: anywhere; }
.peer-note { color: var(--color-warning); }
</style>
