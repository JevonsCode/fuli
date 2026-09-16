<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getJson, patchJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import type { ProjectAgentCoordinationPolicy, ProjectAgentRecord } from '@/types'

const props = defineProps<{
  personalSpaceId: string
  personalProjectId: string
  projectName: string
  agents?: ProjectAgentRecord[]
}>()
const emit = defineEmits<{ select: [agentId: string] }>()

const policy = ref<ProjectAgentCoordinationPolicy>(defaultPolicy())
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const saveError = ref('')
const saved = ref(false)
const teamLead = ref('')
const teamMembers = ref<string[]>([])
let loadVersion = 0

const busy = computed(() => loading.value || saving.value)
const eligible = computed(() => (props.agents ?? []).filter(agent =>
  agent.profile.status === 'active'
  && (agent.profile.agentType ?? 'durable') === 'durable'
  && !agent.agentId.startsWith('employee.')
  && !agent.profile.capabilities.some(cap => cap.startsWith('fuli.employee:'))
  && agent.assignments?.some(assignment => assignment.status === 'active'
    && assignment.personalProjectId === props.personalProjectId)))
const leaders = eligible
const members = computed(() => eligible.value.filter(agent => agent.agentId !== teamLead.value))
const unavailableMembers = computed(() => teamMembers.value.filter(id => !members.value.some(agent => agent.agentId === id))
  .map(id => ({ id, name: (props.agents ?? []).find(agent => agent.agentId === id)?.profile.displayName
    || (props.agents ?? []).find(agent => agent.agentId === id)?.profile.name
    || t('projectAgents.team.unavailableMember') })))
const selectedLead = computed(() => eligible.value.find(agent => agent.agentId === policy.value.teamLeadAgentId))
const selectedMembers = computed(() => eligible.value.filter(agent => policy.value.teamMemberAgentIds?.includes(agent.agentId)))
const teamDirty = computed(() => teamLead.value !== (policy.value.teamLeadAgentId ?? '')
  || JSON.stringify([...teamMembers.value].sort()) !== JSON.stringify([...(policy.value.teamMemberAgentIds ?? [])].sort()))
watch(teamLead, lead => { teamMembers.value = lead ? teamMembers.value.filter(id => id !== lead) : [] })
function label(agent: ProjectAgentRecord) { return agent.profile.displayName || agent.profile.name }
function resetTeam() {
  teamLead.value = policy.value.teamLeadAgentId ?? ''
  teamMembers.value = [...(policy.value.teamMemberAgentIds ?? [])]
}

watch(
  () => [props.personalSpaceId, props.personalProjectId] as const,
  () => void loadPolicy(),
  { immediate: true },
)

async function loadPolicy() {
  const version = ++loadVersion
  policy.value = defaultPolicy()
  resetTeam()
  saving.value = false
  loading.value = false
  saved.value = false
  saveError.value = ''
  if (!props.personalSpaceId || !props.personalProjectId) return
  loading.value = true
  loadError.value = ''
  try {
    const query = new URLSearchParams({
      personalSpaceId: props.personalSpaceId,
      personalProjectId: props.personalProjectId,
    })
    const value = await getJson<unknown>(`/api/project-agent-coordination-policy?${query}`)
    if (version === loadVersion) {
      policy.value = normalizePolicy(value)
      resetTeam()
    }
  } catch (cause) {
    if (version === loadVersion) {
      loadError.value = cause instanceof Error
        ? cause.message
        : t('projectAgents.coordination.loadFailed')
    }
  } finally {
    if (version === loadVersion) loading.value = false
  }
}

async function updatePolicy(
  field: 'askBeforeRecruitment' | 'autoReusePreviousAgent' | 'autoGrowTeam',
  event: Event,
) {
  if (busy.value || loadError.value) return
  const previous = { ...policy.value }
  const checked = (event.currentTarget as HTMLInputElement).checked
  policy.value = { ...policy.value, [field]: checked }
  await persistPolicy(previous)
}

async function saveTeam() {
  if (busy.value || loadError.value || !teamDirty.value) return
  await persistPolicy({ ...policy.value }, {
    teamLeadAgentId: teamLead.value || null,
    teamMemberAgentIds: [...teamMembers.value],
  })
}

async function persistPolicy(previous: ProjectAgentCoordinationPolicy, team?: {
  teamLeadAgentId: string | null; teamMemberAgentIds: string[]
}) {
  const version = loadVersion
  saving.value = true
  saved.value = false
  saveError.value = ''
  try {
    const value = await patchJson<unknown>('/api/project-agent-coordination-policy', {
      personalSpaceId: props.personalSpaceId,
      personalProjectId: props.personalProjectId,
      askBeforeRecruitment: policy.value.askBeforeRecruitment,
      autoReusePreviousAgent: policy.value.autoReusePreviousAgent,
      autoGrowTeam: policy.value.autoGrowTeam ?? true,
      expectedUpdatedAt: previous.updatedAt,
      ...team,
    })
    if (version !== loadVersion) return
    policy.value = normalizePolicy(value)
    if (team) resetTeam()
    saved.value = true
  } catch (cause) {
    if (version !== loadVersion) return
    policy.value = previous
    saveError.value = cause instanceof Error
      ? cause.message
      : t('projectAgents.coordination.saveFailed')
  } finally {
    if (version === loadVersion) saving.value = false
  }
}

function defaultPolicy(): ProjectAgentCoordinationPolicy {
  return {
    personalSpaceId: props.personalSpaceId,
    personalProjectId: props.personalProjectId,
    askBeforeRecruitment: true,
    autoReusePreviousAgent: true,
    autoGrowTeam: true,
    updatedAt: null,
    teamLeadAgentId: null,
    teamMemberAgentIds: [],
  }
}

function normalizePolicy(value: unknown): ProjectAgentCoordinationPolicy {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  return {
    personalSpaceId: stringValue(record.personalSpaceId ?? record.personal_space_id)
      || props.personalSpaceId,
    personalProjectId: stringValue(record.personalProjectId ?? record.personal_project_id)
      || props.personalProjectId,
    askBeforeRecruitment: booleanValue(
      record.askBeforeRecruitment ?? record.ask_before_recruitment,
      true,
    ),
    autoReusePreviousAgent: booleanValue(
      record.autoReusePreviousAgent ?? record.auto_reuse_previous_agent,
      true,
    ),
    updatedAt: stringValue(record.updatedAt ?? record.updated_at),
    autoGrowTeam: booleanValue(record.autoGrowTeam ?? record.auto_grow_team, true),
    teamLeadAgentId: stringValue(record.teamLeadAgentId ?? record.team_lead_agent_id),
    teamMemberAgentIds: Array.isArray(record.teamMemberAgentIds ?? record.team_member_agent_ids)
      ? (record.teamMemberAgentIds ?? record.team_member_agent_ids) as string[] : [],
  }
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : null
}
</script>

<template>
  <section
    class="project-agent-automation-policy"
    :aria-label="t('projectAgents.coordination.aria', { project: projectName })"
    :aria-busy="busy"
  >
    <header>
      <h3>{{ t('projectAgents.coordination.title') }}</h3>
      <span>{{ projectName }}</span>
    </header>

    <GrowthLoading
      v-if="loading"
      variant="compact"
      :label="t('projectAgents.coordination.loading')"
    />
    <div v-else class="project-agent-policy-options">
      <label>
        <span>
          <strong>{{ t('projectAgents.coordination.autoReuse') }}</strong>
          <small>{{ t('projectAgents.coordination.autoReuseMeta') }}</small>
        </span>
        <input
          :checked="policy.autoReusePreviousAgent"
          :disabled="busy || !!loadError"
          type="checkbox"
          role="switch"
          @change="updatePolicy('autoReusePreviousAgent', $event)"
        />
      </label>
      <label>
        <span>
          <strong>{{ t('projectAgents.coordination.askBeforeRecruitment') }}</strong>
          <small>{{ t('projectAgents.coordination.askBeforeRecruitmentMeta') }}</small>
        </span>
        <input
          :checked="policy.askBeforeRecruitment"
          :disabled="busy || !!loadError"
          type="checkbox"
          role="switch"
          @change="updatePolicy('askBeforeRecruitment', $event)"
        />
      </label>
      <label>
        <span>
          <strong>{{ t('projectAgents.team.autoGrow') }}</strong>
          <small>{{ t('projectAgents.team.autoGrowMeta') }}</small>
        </span>
        <input :checked="policy.autoGrowTeam" :disabled="busy || !!loadError"
          type="checkbox" role="switch" @change="updatePolicy('autoGrowTeam', $event)" />
      </label>
    </div>

    <div v-if="agents && !loading && !loadError" class="project-team">
      <div class="project-team-peers">
        <span>{{ t('projectAgents.team.hr') }}</span>
        <span>{{ t('projectAgents.team.manager') }}</span>
        <button v-if="selectedLead" type="button" @click="emit('select', selectedLead.agentId)">{{ t('projectAgents.team.lead') }} · {{ label(selectedLead) }}</button>
        <span v-else-if="policy.teamLeadAgentId">{{ t('projectAgents.team.unavailable') }}</span>
        <span v-else>{{ t('projectAgents.team.noLead') }}</span>
      </div>
      <p class="project-team-summary">{{ t('projectAgents.team.summary') }}</p>
      <ul v-if="selectedMembers.length" class="project-team-members">
        <li v-for="member in selectedMembers" :key="member.agentId"><button type="button" @click="emit('select', member.agentId)"><strong>{{ label(member) }}</strong><span>{{ member.profile.responsibility }}</span></button></li>
      </ul>
      <details>
        <summary>{{ t('projectAgents.team.edit') }}</summary>
        <label class="team-lead-field">{{ t('projectAgents.team.lead') }}
          <select v-model="teamLead" :disabled="busy">
            <option value="">{{ t('projectAgents.team.noLead') }}</option>
            <option v-for="agent in leaders" :key="agent.agentId" :value="agent.agentId">{{ label(agent) }}</option>
          </select>
        </label>
        <fieldset :disabled="busy || !teamLead">
          <legend>{{ t('projectAgents.team.members') }}</legend>
          <label v-for="member in unavailableMembers" :key="member.id" class="unavailable-team-member">
            <input type="checkbox" checked @change="teamMembers = teamMembers.filter(id => id !== member.id)" />
            {{ member.name }} · {{ t('projectAgents.team.removeUnavailable') }}
          </label>
          <label v-for="agent in members" :key="agent.agentId"><input v-model="teamMembers" type="checkbox" :value="agent.agentId" />{{ label(agent) }}</label>
        </fieldset>
        <button type="button" :disabled="busy || !teamDirty" @click="saveTeam">{{ t('projectAgents.team.save') }}</button>
      </details>
    </div>
    <div class="project-agent-policy-feedback" aria-live="polite">
      <p v-if="loadError || saveError" role="alert">
        {{ loadError || saveError }}
        <button v-if="loadError" type="button" :disabled="busy" @click="loadPolicy">
          {{ t('projectAgents.retry') }}
        </button>
      </p>
      <GrowthLoading
        v-else-if="saving"
        variant="compact"
        :label="t('projectAgents.coordination.saving')"
      />
      <p v-else-if="saved" role="status">{{ t('projectAgents.coordination.saved') }}</p>
    </div>
  </section>
</template>

<style scoped>
.project-team { grid-column: 1 / -1; min-width: 0; padding-block: 12px; border-top: 1px solid #dfe5e0; }
.project-team-peers { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.project-team-peers > * { padding: 7px 10px; background: #edf3ee; border: 1px solid #cad9cd; border-radius: 6px; color: #31453a; font-size: 12px; }
.project-team-summary { margin: 9px 0; color: #53665a; font-size: 12px; }
.project-team-members { margin: 10px 0 16px 18px; padding: 0; display: grid; gap: 9px; list-style: none; }
.project-team-members button { display: grid; gap: 3px; text-align: start; max-width: 100%; background: transparent; border: 0; color: #31453a; }
.project-team-members span { color: #596b60; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.project-team summary { cursor: pointer; font-size: 12px; }
.team-lead-field { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-block: 14px; }
.team-lead-field select { max-width: 100%; padding: 7px; }
.project-team fieldset { display: flex; gap: 12px; flex-wrap: wrap; border: 0; padding: 0; margin-bottom: 14px; }
.project-team fieldset label { display: flex; gap: 5px; align-items: center; font-size: 12px; }
.project-team legend { margin-bottom: 8px; font-size: 12px; }
.project-agent-automation-policy {
  display: grid;
  grid-template-columns: minmax(110px, 150px) minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  padding: 11px 0;
  border-block: 1px solid #dfe5e0;
}
.project-agent-automation-policy > header { min-width: 0; }
.project-agent-automation-policy h3 { color: #31453a; font-size: 12px; line-height: 1.35; }
.project-agent-automation-policy header span {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: #68756d;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-agent-policy-options {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.project-agent-policy-options label {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 2px 16px;
  cursor: pointer;
}
.project-agent-policy-options label + label { border-inline-start: 1px solid #e2e7e3; }
.project-agent-policy-options label > span { min-width: 0; display: grid; gap: 3px; }
.project-agent-policy-options strong { color: #3d5045; font-size: 10px; line-height: 1.4; }
.project-agent-policy-options small {
  max-width: 54ch;
  color: #6d7971;
  font-size: 9px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.project-agent-policy-options input {
  position: relative;
  width: 34px;
  height: 19px;
  margin: 0;
  appearance: none;
  border: 1px solid #aeb8b1;
  border-radius: 999px;
  background: #e8ece9;
  cursor: pointer;
  transition: background-color 140ms ease-out, border-color 140ms ease-out;
}
.project-agent-policy-options input::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgb(36 55 44 / 22%);
  content: '';
  transition: transform 140ms ease-out;
}
.project-agent-policy-options input:checked { border-color: #3f7658; background: #4d8164; }
.project-agent-policy-options input:checked::after { transform: translateX(15px); }
.project-agent-policy-options input:focus-visible {
  outline: 2px solid #355f49;
  outline-offset: 3px;
}
.project-agent-policy-options input:disabled { cursor: wait; opacity: .62; }
.project-agent-policy-feedback {
  grid-column: 2;
  min-height: 14px;
  padding-inline: 16px;
}
.project-agent-policy-state, .project-agent-policy-feedback p {
  color: #66736b;
  font-size: 9px;
  line-height: 1.45;
}
.project-agent-policy-feedback p[role='alert'] { color: #874b43; }
.project-agent-policy-feedback button {
  margin-inline-start: 6px;
  border: 0;
  padding: 0;
  color: #355f49;
  background: transparent;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
@media (max-width: 760px) {
  .project-agent-automation-policy { grid-template-columns: minmax(0, 1fr); }
  .project-agent-policy-options { grid-template-columns: minmax(0, 1fr); }
  .project-agent-policy-options label { padding: 8px 0; }
  .project-agent-policy-options label + label { border-inline-start: 0; border-block-start: 1px solid #e2e7e3; }
  .project-agent-policy-feedback { grid-column: 1; padding-inline: 0; }
}
</style>
