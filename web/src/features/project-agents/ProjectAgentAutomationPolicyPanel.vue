<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { computed, ref, watch } from 'vue'
import { getJson, patchJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { agentResponsibility } from '@/features/agent-profile/profile-model'
import type { ProjectAgentCoordinationPolicy, ProjectAgentRecord, ProjectSubTeamPolicy } from '@/types'
import { OptionCombobox } from '@/components/ui/combobox'

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
const subTeams = ref<ProjectSubTeamPolicy[]>([])
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
const leaderOptions = computed(() => [
  ...(!policy.value.teamLeadAgentId ? [{ value: '', label: t('projectAgents.team.noLead') }] : []),
  ...leaders.value.map(agent => ({ value: agent.agentId, label: label(agent) })),
])
const members = computed(() => eligible.value.filter(agent => agent.agentId !== teamLead.value))
const unavailableMembers = computed(() => teamMembers.value.filter(id => !members.value.some(agent => agent.agentId === id))
  .map(id => ({ id, name: (props.agents ?? []).find(agent => agent.agentId === id)?.profile.displayName
    || (props.agents ?? []).find(agent => agent.agentId === id)?.profile.name
    || t('projectAgents.team.unavailableMember') })))
const selectedLead = computed(() => eligible.value.find(agent => agent.agentId === policy.value.teamLeadAgentId))
const selectedMembers = computed(() => eligible.value.filter(agent => policy.value.teamMemberAgentIds?.includes(agent.agentId)))
const teamDirty = computed(() => teamLead.value !== (policy.value.teamLeadAgentId ?? '')
  || JSON.stringify([...teamMembers.value].sort()) !== JSON.stringify([...(policy.value.teamMemberAgentIds ?? [])].sort())
  || JSON.stringify(subTeams.value) !== JSON.stringify(policy.value.subTeams ?? []))
// Groups need a name and a sub-lead; each member sits in at most one group.
const subTeamsValid = computed(() => subTeams.value.every(group => group.name.trim() && group.leadAgentId))
const teamMemberOptions = computed(() => members.value.filter(agent => teamMembers.value.includes(agent.agentId)))
const takenElsewhere = (group: ProjectSubTeamPolicy) => new Set(subTeams.value.filter(other => other !== group)
  .flatMap(other => [other.leadAgentId, ...other.memberAgentIds]))
const subLeadOptions = (group: ProjectSubTeamPolicy) => [
  { value: '', label: t('projectAgents.team.chooseSubLead') },
  ...teamMemberOptions.value.filter(agent => !takenElsewhere(group).has(agent.agentId)).map(agent => ({ value: agent.agentId, label: label(agent) })),
]
const groupMemberOptions = (group: ProjectSubTeamPolicy) => teamMemberOptions.value
  .filter(agent => agent.agentId !== group.leadAgentId && !takenElsewhere(group).has(agent.agentId))
function addSubTeam() {
  subTeams.value = [...subTeams.value, { id: `group-${Date.now().toString(36)}`, name: '', leadAgentId: '', memberAgentIds: [] }]
}
function removeSubTeam(group: ProjectSubTeamPolicy) { subTeams.value = subTeams.value.filter(other => other !== group) }
// A promoted member stops being a member of the group they now lead.
function setSubLead(group: ProjectSubTeamPolicy, agentId: string) {
  group.leadAgentId = agentId
  group.memberAgentIds = group.memberAgentIds.filter(id => id !== agentId)
}
// Leaving the team also leaves its group; a departed sub-lead empties the group's lead.
watch(teamMembers, ids => {
  subTeams.value = subTeams.value.map(group => ({ ...group,
    leadAgentId: ids.includes(group.leadAgentId) ? group.leadAgentId : '',
    memberAgentIds: group.memberAgentIds.filter(id => ids.includes(id)) }))
})
watch(teamLead, lead => { teamMembers.value = lead ? teamMembers.value.filter(id => id !== lead) : [] })
// Collapsed view: the current switches and lead in one line, so the Agent list stays above the fold.
const policySummary = computed(() => {
  const state = (on: boolean | undefined) => t(`projectAgents.coordination.${on ? 'on' : 'off'}`)
  return [
    `${t('projectAgents.coordination.autoReuse')} ${state(policy.value.autoReusePreviousAgent)}`,
    `${t('projectAgents.coordination.askBeforeRecruitment')} ${state(policy.value.askBeforeRecruitment)}`,
    `${t('projectAgents.team.autoGrow')} ${state(policy.value.autoGrowTeam)}`,
    `${t('projectAgents.team.lead')} ${selectedLead.value ? label(selectedLead.value) : t('projectAgents.team.noLead')}`,
  ].join(' · ')
})
function label(agent: ProjectAgentRecord) { return agent.profile.displayName || agent.profile.name }
function resetTeam() {
  teamLead.value = policy.value.teamLeadAgentId ?? ''
  teamMembers.value = [...(policy.value.teamMemberAgentIds ?? [])]
  subTeams.value = (policy.value.subTeams ?? []).map(group => ({ ...group, memberAgentIds: [...group.memberAgentIds] }))
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
  checked: boolean,
) {
  if (busy.value || loadError.value) return
  const previous = { ...policy.value }
  policy.value = { ...policy.value, [field]: checked }
  await persistPolicy(previous)
}

async function saveTeam() {
  if (busy.value || loadError.value || !teamDirty.value || !teamLead.value || !subTeamsValid.value) return
  await persistPolicy({ ...policy.value }, {
    teamLeadAgentId: teamLead.value || null,
    teamMemberAgentIds: [...teamMembers.value],
    subTeams: subTeams.value.map(group => ({ ...group, name: group.name.trim() })),
  })
}

async function persistPolicy(previous: ProjectAgentCoordinationPolicy, team?: {
  teamLeadAgentId: string | null; teamMemberAgentIds: string[]; subTeams?: ProjectSubTeamPolicy[]
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
    subTeams: (Array.isArray(record.subTeams ?? record.sub_teams) ? (record.subTeams ?? record.sub_teams) as Record<string, unknown>[] : [])
      .map(group => ({ id: String(group.id ?? ''), name: String(group.name ?? ''),
        leadAgentId: String(group.leadAgentId ?? group.lead_agent_id ?? ''),
        memberAgentIds: (Array.isArray(group.memberAgentIds ?? group.member_agent_ids) ? (group.memberAgentIds ?? group.member_agent_ids) as string[] : []) })),
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
    <details class="project-agent-policy-disclosure" :open="Boolean(loadError || saveError)">
    <summary>
      <h3>{{ t('projectAgents.coordination.title') }}</h3>
      <span class="project-agent-policy-project">{{ projectName }}</span>
      <GrowthLoading v-if="loading" variant="inline" :label="t('projectAgents.coordination.loading')" />
      <span v-if="!loading" class="project-agent-policy-state" data-policy-summary>{{ policySummary }}</span>
    </summary>
    <div class="project-agent-policy-body">

    <div v-if="!loading" class="project-agent-policy-options">
      <label>
        <span>
          <strong>{{ t('projectAgents.coordination.autoReuse') }}</strong>
          <small>{{ t('projectAgents.coordination.autoReuseMeta') }}</small>
        </span>
        <Switch :model-value="policy.autoReusePreviousAgent" :disabled="busy || !!loadError"
          @update:model-value="updatePolicy('autoReusePreviousAgent', $event)" />
      </label>
      <label>
        <span>
          <strong>{{ t('projectAgents.coordination.askBeforeRecruitment') }}</strong>
          <small>{{ t('projectAgents.coordination.askBeforeRecruitmentMeta') }}</small>
        </span>
        <Switch :model-value="policy.askBeforeRecruitment" :disabled="busy || !!loadError"
          @update:model-value="updatePolicy('askBeforeRecruitment', $event)" />
      </label>
      <label>
        <span>
          <strong>{{ t('projectAgents.team.autoGrow') }}</strong>
          <small>{{ t('projectAgents.team.autoGrowMeta') }}</small>
        </span>
        <Switch :model-value="policy.autoGrowTeam" :disabled="busy || !!loadError"
          @update:model-value="updatePolicy('autoGrowTeam', $event)" />
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
        <li v-for="member in selectedMembers" :key="member.agentId"><button type="button" @click="emit('select', member.agentId)"><strong>{{ label(member) }}</strong><span>{{ agentResponsibility(member) }}</span></button></li>
      </ul>
      <details>
        <summary>{{ t('projectAgents.team.edit') }}</summary>
        <OptionCombobox v-model="teamLead" class="team-lead-field" field :label="t('projectAgents.team.lead')" :options="leaderOptions" :disabled="busy" />
        <fieldset :disabled="busy || !teamLead">
          <legend>{{ t('projectAgents.team.members') }}</legend>
          <label v-for="member in unavailableMembers" :key="member.id" class="unavailable-team-member">
            <input type="checkbox" checked @change="teamMembers = teamMembers.filter(id => id !== member.id)" />
            {{ member.name }} · {{ t('projectAgents.team.removeUnavailable') }}
          </label>
          <label v-for="agent in members" :key="agent.agentId"><input v-model="teamMembers" type="checkbox" :value="agent.agentId" />{{ label(agent) }}</label>
        </fieldset>
        <fieldset v-if="teamMembers.length > 1" class="sub-team-editor" :disabled="busy || !teamLead" data-sub-team-editor>
          <legend>{{ t('projectAgents.team.subTeams') }}</legend>
          <p class="sub-team-hint">{{ t('projectAgents.team.subTeamsHint') }}</p>
          <div v-for="group in subTeams" :key="group.id" class="sub-team-row" data-sub-team-row>
            <input v-model="group.name" class="sub-team-name" type="text" maxlength="40" :placeholder="t('projectAgents.team.subTeamName')" :aria-label="t('projectAgents.team.subTeamName')" />
            <OptionCombobox :model-value="group.leadAgentId" field @update:model-value="setSubLead(group, $event)" :label="t('projectAgents.team.subLead')" :options="subLeadOptions(group)" />
            <div class="sub-team-members">
              <label v-for="agent in groupMemberOptions(group)" :key="agent.agentId"><input v-model="group.memberAgentIds" type="checkbox" :value="agent.agentId" />{{ label(agent) }}</label>
            </div>
            <Button size="sm" variant="ghost" @click="removeSubTeam(group)">{{ t('projectAgents.team.removeSubTeam') }}</Button>
          </div>
          <Button variant="outline" size="sm" data-sub-team-add @click="addSubTeam">{{ t('projectAgents.team.addSubTeam') }}</Button>
        </fieldset>
        <Button size="sm" :disabled="busy || !teamDirty || !teamLead || !subTeamsValid" @click="saveTeam">{{ t('projectAgents.team.save') }}</Button>
      </details>
    </div>
    <div class="project-agent-policy-feedback" aria-live="polite">
      <p v-if="loadError || saveError" role="alert">
        {{ loadError || saveError }}
        <Button v-if="loadError" size="sm" variant="ghost" :disabled="busy" @click="loadPolicy">
          {{ t('projectAgents.retry') }}
        </Button>
      </p>
      <GrowthLoading
        v-else-if="saving"
        variant="compact"
        :label="t('projectAgents.coordination.saving')"
      />
      <p v-else-if="saved" role="status">{{ t('projectAgents.coordination.saved') }}</p>
    </div>
    </div>
    </details>
  </section>
</template>

<style scoped>
.project-team { min-width: 0; padding-block: 12px; border-top: 1px solid var(--color-border); }
.project-team-peers { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.project-team-peers > * { padding: 7px 10px; background: var(--color-surface-subtle); border: 1px solid var(--color-border-strong); border-radius: 6px; color: var(--color-ink); font-size: 12px; }
.project-team-summary { margin: 9px 0; color: var(--color-muted); font-size: 12px; }
.project-team-members { margin: 10px 0 16px 18px; padding: 0; display: grid; gap: 9px; list-style: none; }
.project-team-members button { display: grid; gap: 3px; text-align: start; max-width: 100%; background: transparent; border: 0; color: var(--color-ink); }
.project-team-members span { color: var(--color-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.project-team summary { cursor: pointer; font-size: 12px; }
.team-lead-field { max-width: 360px; margin-block: 14px; }
.project-team fieldset { display: flex; gap: 12px; flex-wrap: wrap; border: 0; padding: 0; margin-bottom: 14px; }
.project-team fieldset label { display: flex; gap: 5px; align-items: center; font-size: 12px; }
.project-team legend { margin-bottom: 8px; font-size: 12px; }
.project-agent-automation-policy { border-block: 1px solid var(--color-border); }
.project-agent-policy-disclosure > summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  padding: 10px 0;
  cursor: pointer;
  list-style: none;
}
.project-agent-policy-disclosure > summary::-webkit-details-marker { display: none; }
.project-agent-policy-disclosure > summary::before { content: '▸'; color: var(--color-muted); transition: transform 140ms ease-out; }
.project-agent-policy-disclosure[open] > summary::before { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .project-agent-policy-disclosure > summary::before { transition: none; } }
:global(:root[data-motion="reduced"]) .project-agent-policy-disclosure > summary::before { transition: none; }
.project-agent-policy-disclosure h3 { display: inline; color: var(--color-ink); font-size: 13px; line-height: 1.35; }
.project-agent-policy-project { color: var(--color-muted); font-size: 12px; }
.project-agent-policy-disclosure > summary .project-agent-policy-state { min-width: 0; overflow-wrap: anywhere; }
.project-agent-policy-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding-bottom: 12px; }
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
.project-agent-policy-options label + label { border-inline-start: 1px solid var(--color-border); }
.project-agent-policy-options label > span { min-width: 0; display: grid; gap: 3px; }
.project-agent-policy-options strong { color: var(--color-ink); font-size: 12px; line-height: 1.4; }
.project-agent-policy-options small {
  max-width: 54ch;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.project-agent-policy-feedback {
  min-height: 14px;
  padding-inline: 16px;
}
.project-agent-policy-state, .project-agent-policy-feedback p {
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.45;
}
.project-agent-policy-feedback p[role='alert'] { color: var(--color-danger); }
.project-agent-policy-feedback [data-slot="button"] { margin-inline-start: 6px; }
@media (max-width: 760px) {
  .project-agent-policy-options { grid-template-columns: minmax(0, 1fr); }
  .project-agent-policy-options label { padding: 8px 0; }
  .project-agent-policy-options label + label { border-inline-start: 0; border-block-start: 1px solid var(--color-border); }
  .project-agent-policy-feedback { padding-inline: 0; }
}
.sub-team-editor { display: grid; gap: 10px; }
.sub-team-hint { margin: 0; color: var(--color-muted); font-size: 12px; }
.sub-team-row { display: grid; gap: 8px; padding: 10px 12px; border-radius: var(--radius-control); background: var(--color-surface-subtle); }
.sub-team-name { width: 100%; box-sizing: border-box; }
.sub-team-members { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; }
</style>
