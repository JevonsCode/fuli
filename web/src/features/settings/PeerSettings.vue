<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { getJson, postJson, putJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import { currentLocale, t } from '@/i18n'
import { OptionSelect } from '@/components/ui/select'
import UiNotice from '@/ui/UiNotice.vue'
import PeerNearby from './PeerNearby.vue'
import PeerSharePicker from './PeerSharePicker.vue'
import { autoSharedNames, peerApiMessage, peerStatusShape, shareRows, unsharedSuggestions, type ClientId, type PeerStatus, type Shareable } from './peer-model'
import { RECENT_READS, readAsker, readQuestion, visitorReadsShape, type VisitorRead } from './visitor-reads'
import { formatRelativeTime } from '@/lib/relative-time'

type ShareDraft = { selected: boolean; clients: ClientId[]; folder: string }

// While nearby pairing is on, the list and a pairing's state come from the other computer;
// after a pairing, until its shares land (status.autoSharePending).
const NEARBY_REFRESH_MS = 2_000

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
// Projects picked from 「添加项目」 in this visit; they stay, ticked or not, until a save or reload.
const added = ref<Shareable[]>([])
// 「最近被问」: read with the card, so the list never appears under content already shown.
const reads = ref<VisitorRead[]>([])
const readsFailed = ref(false)
let refresh: ReturnType<typeof setInterval> | null = null

const addressOptions = computed(() => (status.value?.addresses ?? []).map((value) => ({ value, label: value })))
const rows = computed(() => (status.value ? shareRows(status.value, added.value) : []))
const rowIds = computed(() => rows.value.map((project) => project.projectId))
const suggestions = computed(() => (status.value ? unsharedSuggestions(status.value) : []))
const sharedAtPairing = computed(() => (status.value
  ? new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(autoSharedNames(status.value)) : ''))
const paired = computed(() => Boolean(status.value?.role))
const coordinator = computed(() => status.value?.role === 'coordinator')
const otherDevices = computed(() => (status.value?.devices ?? []).filter((device) => !device.self))
const projectNames = computed(() => new Map((status.value?.shares ?? []).map((share) => [share.projectId, share.projectName])))
watch(joinInvitation, () => { joiningDevice.value = null })

function clientLabel(client: ClientId) {
  return client === 'claude_code' ? t('settings.peer.clientsClaude') : t('settings.peer.clientsCodex')
}

function sameProjectNames(project: Shareable) {
  return (project.sameProjectOn ?? []).map((device) => device.name).join(', ')
}

function applyStatus(next: PeerStatus) {
  status.value = next
  if (!hostAddress.value && next.addresses[0]) hostAddress.value = next.addresses[0]
  const known = new Set(shareRows(next, added.value).map((project) => project.projectId))
  for (const key of Object.keys(drafts)) if (!known.has(key)) delete drafts[key]
  for (const project of next.shareable) {
    const existing = next.shares.find((share) => share.projectId === project.projectId)
    // A refresh never changes a draft: what is saved is only what the person ticked.
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
  try {
    const next = await getJson('/api/peer', peerStatusShape)
    const recent = next.role ? await readRecent() : []
    applyStatus(next)
    applyReads(recent)
  }
  catch (caught) { error.value = peerApiMessage(caught, t('settings.peer.loadError')) }
  finally { loading.value = false }
}

// 「最近被问」, read with the card so it never appears under content already shown;
// null when it cannot be read, which the card says instead of an empty list.
function readRecent() {
  return getJson(`/api/visitor-access/reads?limit=${RECENT_READS}`, visitorReadsShape).then((answer) => answer.reads, () => null)
}

function applyReads(recent: VisitorRead[] | null) {
  readsFailed.value = recent === null
  reads.value = recent ?? []
}

// Quietly again with the card's own refresh, and when the person comes back to the page.
async function refreshReads() {
  if (status.value?.role && !loading.value) applyReads(await readRecent())
}

// A quiet re-read: the loaded card stays as it is while it runs.
async function refreshNearby() {
  if (busy.value || loading.value) return
  try { applyStatus(await getJson('/api/peer', peerStatusShape)) } catch { /* the next refresh retries */ }
  await refreshReads()
}

watch(() => Boolean(status.value?.nearby?.on || status.value?.autoSharePending), (on) => {
  if (refresh) clearInterval(refresh)
  refresh = on ? setInterval(refreshNearby, NEARBY_REFRESH_MS) : null
})

onMounted(() => {
  window.addEventListener('focus', refreshReads)
  return load()
})
onUnmounted(() => {
  if (refresh) clearInterval(refresh)
  window.removeEventListener('focus', refreshReads)
})

async function run(kind: string, work: () => Promise<PeerStatus | void>) {
  if (busy.value) return
  busy.value = kind
  error.value = ''
  try {
    const next = await work()
    if (next) applyStatus(next)
  } catch (caught) { error.value = peerApiMessage(caught, t('settings.peer.loadError')) }
  finally { busy.value = '' }
}

function host() {
  return run('host', () => postJson('/api/peer/coordinator', {
    host: hostAddress.value, port: 0, name: hostName.value.trim() || undefined,
  }, peerStatusShape))
}

function join() {
  if (!joiningDevice.value) return run('preview', async () => {
    const text = joinInvitation.value.trim()
    const preview = await postJson<{ name: string; url: string; shortFingerprint: string }>('/api/peer/invitations/preview', { invitation: text })
    if (joinInvitation.value.trim() === text) joiningDevice.value = preview
  })
  return run('join', () => postJson('/api/peer/join', {
    invitation: joinInvitation.value.trim(), name: joinName.value.trim() || undefined,
  }, peerStatusShape))
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
  // A folder FULI knows is a checkout of this project's own repository (the server checks its origin).
  if (selected && !draft.folder && project.knownFolder) draft.folder = project.knownFolder
}

function toggleClient(projectId: string, client: ClientId, selected: boolean) {
  const draft = drafts[projectId]
  if (!draft) return
  draft.clients = selected ? [...new Set([...draft.clients, client])] : draft.clients.filter((item) => item !== client)
}

// A project picked from 「添加项目」 becomes a ticked row, exactly as ticking it in the list.
function addProject(project: Shareable) {
  if (!rowIds.value.includes(project.projectId)) added.value = [...added.value, project]
  drafts[project.projectId] ??= { selected: false, clients: [], folder: '' }
  toggleProject(project, true)
}

function saveShares(kind = 'shares') {
  const shares = rows.value.flatMap((project) => {
    const draft = drafts[project.projectId]
    if (!draft?.selected || !project.lead) return []
    return [{
      projectId: project.projectId,
      clients: draft.clients,
      ...(draft.folder.trim() ? { workingDirectory: draft.folder.trim() } : {}),
    }]
  })
  return run(kind, async () => {
    const next = await putJson('/api/peer/shares', { shares }, peerStatusShape)
    added.value = []
    return next
  })
}

// 「共享这 N 个相同的项目」: the person's one click ticks every suggestion and saves.
function shareSuggestions() {
  for (const project of suggestions.value) toggleProject(project, true)
  return saveShares('suggestions')
}

function revoke(nodeId: string) {
  return run(`revoke:${nodeId}`, () => postJson(`/api/peer/devices/${nodeId}/revoke`, {}, peerStatusShape))
}

function disable() {
  return run('disable', async () => {
    const next = await postJson('/api/peer/disable', {}, peerStatusShape)
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
  <Card as="section" id="peer" class="settings-card peer-settings" aria-labelledby="settings-peer-title" data-peer-settings>
    <CardHeader>
      <CardTitle id="settings-peer-title" as="h2">{{ t('settings.peer.title') }}<AiHelpButton term="task.peer" /></CardTitle>
      <CardDescription>{{ t('settings.peer.description') }}</CardDescription>
    </CardHeader>
    <div class="peer-body">
      <GrowthLoading v-if="loading" variant="compact" :label="t('settings.peer.loading')" />
      <div v-if="error" class="peer-alert" role="alert">
        <span>{{ error }}</span>
        <Button variant="outline" size="sm" data-retry-peer :loading="loading" :loading-label="t('settings.peer.loading')" @click="load">
          {{ t('settings.peer.retry') }}
        </Button>
      </div>

      <PeerNearby v-if="status?.nearby" :nearby="status.nearby" :coordinator-name="status.coordinator?.name ?? null"
        @status="applyStatus" />

      <template v-if="status && !paired">
        <p>{{ t('settings.peer.off') }}</p>
        <p v-if="status.remoteRemovalPending" role="status">{{ t('settings.peer.removalPending') }}</p>
        <section class="peer-block">
          <h3 class="ui-group-label">{{ t('settings.peer.host') }}</h3>
          <p v-if="!status.addresses.length">{{ t('settings.peer.noAddress') }}</p>
          <div v-else class="peer-fields">
            <OptionSelect control-id="peer-host-address" :model-value="hostAddress" :options="addressOptions"
              :label="t('settings.peer.hostAddress')" @update:model-value="hostAddress = $event" />
            <label>
              <span>{{ t('settings.peer.hostName') }}</span>
              <input v-model="hostName" type="text" maxlength="60" :disabled="Boolean(busy)" />
            </label>
            <Button data-host-peer :disabled="!hostAddress"
              :loading="busy === 'host'" :loading-label="t('settings.peer.hosting')" @click="host">
              {{ t('settings.peer.hostAction') }}
            </Button>
          </div>
        </section>
        <section class="peer-block">
          <h3 class="ui-group-label">{{ t('settings.peer.join') }}</h3>
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
          <p v-if="joiningDevice" data-share-on-pair>{{ t('settings.peer.shareOnPair') }}</p>
          <!-- The joining computer is always a member of the other's group. -->
          <p v-if="joiningDevice" data-member-trust>{{ t('settings.peer.memberTrust') }}</p>
          <Button size="sm" data-join-peer :disabled="!joinInvitation.trim() || status.remoteRemovalPending"
            :loading="busy === 'join' || busy === 'preview'" :loading-label="t(joiningDevice ? 'settings.peer.joining' : 'settings.peer.previewing')" @click="join">
            {{ t(joiningDevice ? 'settings.peer.joinAction' : 'settings.peer.previewAction') }}
          </Button>
        </section>
      </template>

      <template v-if="status && paired">
        <UiNotice v-if="status.coordinator?.listenFailure" tone="warning" data-listen-failure>
          {{ t('settings.peer.listenFailure', { address: status.coordinator.listenFailure.address, code: status.coordinator.listenFailure.code }) }}
        </UiNotice>
        <dl class="peer-identity">
          <div>
            <dt>{{ t('settings.peer.fingerprint') }}</dt>
            <dd>{{ status.device?.shortFingerprint }}</dd>
          </div>
          <!-- The computer that coordinates is this one when it hosts: its own fingerprint is not shown twice. -->
          <div v-if="!coordinator" data-other-fingerprint>
            <dt>{{ t('settings.peer.coordinatorFingerprint') }}</dt>
            <dd>{{ status.coordinator?.shortFingerprint }}</dd>
          </div>
        </dl>

        <section v-if="coordinator" class="peer-block">
          <Button variant="outline" size="sm" data-invite-peer :loading="busy === 'invite'" :loading-label="t('settings.peer.inviting')" @click="invite">
            {{ t('settings.peer.invite') }}
          </Button>
          <p>{{ t('settings.peer.inviteHint') }}</p>
          <template v-if="invitation">
            <textarea :value="invitation.invitation" readonly rows="4" spellcheck="false" :aria-label="t('settings.peer.invitation')" />
            <div class="peer-actions">
              <Button variant="outline" size="sm" data-copy-invite @click="copyInvite">{{ t('settings.peer.copyInvite') }}</Button>
              <p v-if="inviteFeedback" role="status">{{ t(`settings.peer.${inviteFeedback === 'copied' ? 'copied' : 'copyManual'}`) }}</p>
            </div>
          </template>
        </section>

        <section class="peer-block">
          <h3 class="ui-group-label">{{ t('settings.peer.shares') }}</h3>
          <p>{{ t('settings.peer.sharesHint') }}</p>
          <UiNotice v-if="sharedAtPairing" tone="info" data-auto-shared>
            <span class="peer-notice-line">{{ t('settings.peer.autoShared', { projects: sharedAtPairing }) }}</span>
            <!-- A member cannot check the group: the coordinator says who else is in it. -->
            <span v-if="status.role === 'member'" class="peer-notice-line" data-member-group-limit>{{ t('settings.peer.memberGroupLimit') }}</span>
          </UiNotice>
          <p v-if="!rows.length" data-shares-empty>{{ t('settings.peer.noProjects') }}</p>
          <div v-if="suggestions.length" class="peer-actions">
            <Button size="sm" variant="outline" data-share-suggestions :disabled="Boolean(busy) && busy !== 'suggestions'"
              :loading="busy === 'suggestions'" :loading-label="t('settings.peer.savingShares')" @click="shareSuggestions">
              {{ t('settings.peer.shareCommon', { count: suggestions.length }) }}
            </Button>
            <p v-if="(status.groupSize ?? 0) > 2" data-group-shares>{{ t('settings.peer.groupShares') }}</p>
          </div>
          <ul v-if="rows.length" class="peer-shares">
            <li v-for="project in rows" :key="project.projectId" :data-share-row="project.projectId">
              <label class="peer-share-title" :title="project.lead ? `${project.projectName} · ${t('settings.peer.lead', { name: project.lead.name })}` : project.projectName">
                <input type="checkbox" :checked="drafts[project.projectId]?.selected"
                  :disabled="!project.lead || Boolean(busy)"
                  @change="toggleProject(project, ($event.target as HTMLInputElement).checked)" />
                <strong>{{ project.projectName }}</strong>
                <small>{{ project.lead ? t('settings.peer.lead', { name: project.lead.name }) : t('settings.peer.noLead') }}</small>
              </label>
              <p v-if="project.sameProjectOn?.length && project.lead" data-same-project>
                {{ t('settings.peer.sameProject', { devices: sameProjectNames(project) }) }}
              </p>
              <p v-if="shareState(project.projectId) === 'lead_changed'" class="peer-note">{{ t('settings.peer.leadChanged') }}</p>
              <p v-if="shareState(project.projectId) === 'lead_unavailable'" class="peer-note">{{ t('settings.peer.leadUnavailable') }}</p>
              <p v-if="shareState(project.projectId) === 'team_unreadable'" class="peer-note">{{ t('settings.peer.teamUnreadable') }}</p>
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
                <small v-if="project.sameProjectOn?.length && !project.knownFolder && !drafts[project.projectId].folder" class="peer-note"
                  data-folder-unknown>{{ t('settings.peer.folderUnknown') }}</small>
                <small v-else>{{ t('settings.peer.folderHint') }}</small>
              </label>
            </li>
          </ul>
          <PeerSharePicker :listed="rowIds" :disabled="Boolean(busy)" @pick="addProject" />
          <UiNotice v-if="status.lastPublish?.error" tone="warning" data-publish-error>
            {{ t('settings.peer.publishFailed', { reason: status.lastPublish.error }) }}
          </UiNotice>
          <div v-if="rows.length" class="peer-actions">
            <Button size="sm" data-save-shares
              :loading="busy === 'shares'" :loading-label="t('settings.peer.savingShares')" @click="saveShares()">
              {{ t('settings.peer.saveShares') }}
            </Button>
          </div>
          <template v-if="reads.length || readsFailed">
            <h3 class="ui-group-label">{{ t('settings.peer.recentReads') }}</h3>
            <p v-if="readsFailed" data-reads-unavailable>{{ t('settings.peer.readsUnavailable') }}</p>
            <ul v-else class="peer-devices peer-reads" data-recent-reads>
              <li v-for="read in reads" :key="read.id">
                <div>
                  <strong>{{ readAsker(read) }}</strong>
                  <small :title="readQuestion(read, projectNames)">{{ readQuestion(read, projectNames) }}</small>
                </div>
                <small>{{ formatRelativeTime(read.at, currentLocale()) }}</small>
              </li>
            </ul>
          </template>
        </section>

        <section v-if="coordinator && otherDevices.length" class="peer-block">
          <h3 class="ui-group-label">{{ t('settings.peer.devices') }}</h3>
          <ul class="peer-devices">
            <li v-for="device in otherDevices" :key="device.nodeId">
              <div>
                <strong>{{ device.name }}</strong>
                <small>{{ device.shortFingerprint }} · {{ device.online ? t('settings.peer.online') : t('settings.peer.offline') }}</small>
              </div>
              <Button size="sm" variant="destructive" :data-revoke="device.nodeId"
                :loading="busy === `revoke:${device.nodeId}`" :loading-label="t('settings.peer.revoking')"
                @click="revoke(device.nodeId)">
                {{ t('settings.peer.revoke') }}
              </Button>
            </li>
          </ul>
        </section>

        <p>{{ t('settings.peer.disableHint') }}</p>
        <Button variant="outline" size="sm" data-disable-peer :loading="busy === 'disable'" :loading-label="t('settings.peer.disabling')" @click="disable">
          {{ t('settings.peer.disable') }}
        </Button>
      </template>
    </div>
  </Card>
</template>

<style scoped>
.peer-body { padding-inline: 24px; }
.peer-body > :first-child { margin-top: 0; }
.peer-body > :last-child { margin-bottom: 0; }
.peer-body p, .peer-body small { color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.peer-body p { margin: 12px 0; }
.peer-alert, .peer-actions, .peer-identity, .peer-fields, .peer-share-title, .peer-devices li {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
}
.peer-block { display: grid; gap: 12px; margin: 16px 0; min-width: 0; }
.peer-fields { align-items: end; }
.peer-fields :deep(:is([data-slot=option-select], [data-slot=option-combobox])) { min-width: 0; flex: 1 1 180px; }
.peer-identity { margin: 12px 0; }
.peer-identity div { min-width: 0; flex: 1 1 160px; }
.peer-identity dt { color: var(--color-muted); font-size: 12px; }
.peer-identity dd, .peer-identity code, .peer-identity strong, .peer-identity p { overflow-wrap: anywhere; }
.peer-identity dd { margin: 0; font-family: var(--font-mono); font-size: 13px; }
.peer-settings label { display: grid; gap: 6px; min-width: 0; color: var(--color-muted); font-size: 12px; }
.peer-settings input[type='text'], .peer-settings textarea {
  box-sizing: border-box; width: 100%; min-width: 0; overflow-wrap: anywhere;
}
.peer-settings textarea { resize: vertical; font: 12px/1.65 var(--font-mono); }
.peer-shares, .peer-devices { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
.peer-shares { gap: 0; }
.peer-shares li, .peer-devices li {
  min-width: 0; padding: 12px 0; border-top: 1px solid var(--color-border);
}
.peer-shares li { display: grid; gap: 8px; padding: 8px 0; }
.peer-shares li p { margin: 0; }
/* One line per project: checkbox, name, then its lead, muted; both cut with … (the full text is the title). */
.peer-settings .peer-share-title {
  display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 30px; cursor: pointer; user-select: none;
}
.peer-share-title strong, .peer-share-title small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.peer-share-title strong { flex: 0 1 auto; color: var(--color-ink); font-size: 14px; font-weight: 500; }
.peer-share-title small { flex: 1 1 0; }
.peer-shares fieldset { display: flex; flex-wrap: wrap; gap: 12px 16px; border: 0; padding: 0 0 0 24px; }
.peer-shares li > label:not(.peer-share-title), .peer-shares li > p { padding-left: 24px; }
.peer-shares fieldset label { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
.peer-devices li { justify-content: space-between; }
.peer-devices strong, .peer-devices small { display: block; overflow-wrap: anywhere; }
/* One line per read: who asked, then what, cut with … (the full text is the title); the time stays whole. */
.peer-reads { gap: 0; }
.peer-reads li { flex-wrap: nowrap; padding: 8px 0; }
.peer-reads div { min-width: 0; flex: 1 1 auto; }
.peer-reads div small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.peer-reads > li > small { flex: none; }
.peer-note { color: var(--color-warning); }
.peer-notice-line { display: block; }
</style>
