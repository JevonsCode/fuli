<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import AgentName from '@/features/agent-profile/AgentName.vue'
import { currentLocale, t } from '@/i18n'
import { readProjectTeam, type ProjectTeam, type ProjectTeamPerson } from './project-team-api'

const props = defineProps<{ spaceId: string; projectId: string }>()

const team = ref<ProjectTeam | null>(null)
const loading = ref(false)
const failed = ref(false)
const expanded = ref(false)
const showInitialLoading = useMinimumLoadingDisplay(computed(() => loading.value && !team.value))
const showRefreshing = useMinimumLoadingDisplay(computed(() => loading.value && Boolean(team.value)))
let sequence = 0

const panelId = computed(() => `project-team-organization-${props.projectId}`)
// With sub-teams the members read as the reporting chain: each group under its
// sub-lead, then whoever reports to the lead directly.
const memberGroups = computed(() => {
  const value = team.value
  if (!value) return []
  const subTeams = value.subTeams ?? []
  if (!subTeams.length) return [{ key: 'members', title: t('projects.overview.members'), lead: null, unavailableLead: null, people: value.members }]
  const grouped = new Set(subTeams.flatMap(group => [group.lead?.agentId, ...group.members.map(person => person.agentId)]))
  return [
    ...subTeams.map(group => ({ key: `sub-${group.id}`, title: group.name, lead: group.lead, unavailableLead: group.unavailableLead,
      people: group.members.filter(person => person.agentId !== group.lead?.agentId) })),
    { key: 'direct', title: t('projects.overview.directReports'), lead: null, unavailableLead: null,
      people: value.members.filter(person => !grouped.has(person.agentId)) },
  ].filter(group => group.lead || group.unavailableLead || group.people.length)
})
const teamSettingsTo = computed(() => ({ path: '/project-agents/manage', query: { project: props.projectId } }))
const summary = computed(() => {
  const value = team.value
  if (!value) return ''
  const parts = []
  if (value.members.length) {
    const names = new Intl.ListFormat(currentLocale(), { type: 'conjunction' })
      .format(value.members.map(({ name }) => name))
    parts.push(`${t('projects.overview.memberCount', { count: value.members.length })} · ${names}`)
  }
  if (value.collaborators.length) {
    parts.push(t('projects.overview.collaboratorCount', { count: value.collaborators.length }))
  }
  if (value.peers.length) parts.push(t('projects.overview.peerCount', { count: value.peers.length }))
  return parts.length ? parts.join(currentLocale() === 'zh-CN' ? '；' : '; ') : t('projects.overview.noMembers')
})

watch(() => [props.spaceId, props.projectId], () => {
  team.value = null
  expanded.value = false
  void load()
}, { immediate: true })

async function load() {
  if (!props.spaceId || !props.projectId) return
  const current = ++sequence
  loading.value = true
  failed.value = false
  try {
    const value = await readProjectTeam(props.spaceId, props.projectId)
    if (current === sequence) team.value = value
  } catch {
    if (current === sequence) failed.value = true
  } finally {
    if (current === sequence) loading.value = false
  }
}

function initial(person: ProjectTeamPerson) {
  return person.occupationEmoji || [...person.name.trim()][0]?.toLocaleUpperCase() || '?'
}

function number(person: ProjectTeamPerson) {
  return person.employeeNumber ? t('projects.overview.employeeNumber', { number: person.employeeNumber }) : ''
}
</script>

<template>
  <section class="project-team" aria-labelledby="project-team-heading">
    <header class="project-team-header">
      <h3 id="project-team-heading">{{ t('projects.overview.team') }}</h3>
      <GrowthLoading v-if="showRefreshing" variant="inline" :label="t('projects.overview.refreshingTeam')" />
      <p v-else-if="failed && team" class="project-team-stale" role="alert">
        {{ t('projects.overview.refreshFailed') }}
        <Button size="sm" variant="ghost" @click="load">{{ t('projects.overview.retry') }}</Button>
      </p>
      <Button size="icon-sm" variant="ghost"
        :aria-label="t('projects.overview.refresh')"
        :title="t('projects.overview.refresh')"
        :disabled="loading"
        @click="load"
      >
        <svg class="project-team-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>
      </Button>
    </header>

    <GrowthLoading v-if="showInitialLoading" variant="compact" :label="t('projects.overview.loadingTeam')" />
    <div v-else-if="failed && !team" class="project-team-state" role="alert">
      <p>{{ t('projects.overview.teamFailed') }}</p>
      <Button size="sm" variant="ghost" @click="load">{{ t('projects.overview.retry') }}</Button>
    </div>

    <template v-else-if="team">
      <button
        v-if="team.lead"
        class="project-team-lead"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="panelId"
        :aria-label="`${t('projects.overview.lead')} ${team.lead.name}. ${expanded ? t('projects.overview.hideOrganization') : t('projects.overview.showOrganization')}`"
        @click="expanded = !expanded"
      >
        <span class="project-team-avatar" aria-hidden="true">{{ initial(team.lead) }}</span>
        <span class="project-team-lead-text">
          <span class="project-team-lead-name">
            <strong>{{ team.lead.name }}</strong>
            <span class="ui-meta">{{ t('projects.overview.lead') }}<template v-if="number(team.lead)"> · {{ number(team.lead) }}</template></span>
          </span>
          <span v-if="team.lead.responsibility" class="project-team-responsibility">{{ team.lead.responsibility }}</span>
          <span class="ui-meta project-team-preview">{{ summary }}</span>
        </span>
        <svg class="project-team-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>

      <div v-else class="project-team-state" role="status">
        <p>
          <template v-if="team.status === 'lead_unavailable'">
            {{ team.unavailableLead?.name
              ? t('projects.overview.leadUnavailable', { name: team.unavailableLead.name })
              : t('projects.overview.leadUnavailableUnnamed') }}
          </template>
          <template v-else>{{ t('projects.overview.noLead') }}</template>
        </p>
        <Button as-child>
          <RouterLink :to="teamSettingsTo">
            {{ team.status === 'lead_unavailable' ? t('projects.overview.changeLead') : t('projects.overview.setLead') }}
          </RouterLink>
        </Button>
      </div>

      <div v-show="expanded || !team.lead" :id="panelId" class="project-team-organization">
        <ul v-if="team.lead" class="project-team-list">
          <li>
            <AgentName :space-id="spaceId" :agent-id="team.lead.agentId" :name="team.lead.name" />
            <span class="ui-meta">{{ t('projects.overview.lead') }}<template v-if="number(team.lead)"> · {{ number(team.lead) }}</template></span>
          </li>
        </ul>
        <div v-for="group in memberGroups" :key="group.key" class="project-team-group" :class="[`is-${group.key}`, { 'is-sub-team': group.lead || group.unavailableLead }]" :data-team-group="group.key">
          <h4>{{ group.title }}</h4>
          <p v-if="group.lead" class="project-team-sub-lead">
            <span class="project-team-avatar is-small" aria-hidden="true">{{ initial(group.lead) }}</span>
            <AgentName :space-id="spaceId" :agent-id="group.lead.agentId" :name="group.lead.name" />
            <span class="ui-meta">{{ t('projects.overview.subLead') }}</span>
          </p>
          <p v-else-if="group.unavailableLead" class="ui-meta project-team-sub-lead is-unavailable" role="status">
            {{ t('projects.overview.subLeadUnavailable', { name: group.unavailableLead.name ?? '' }) }}
          </p>
          <ul v-if="group.people.length" class="project-team-list">
            <li v-for="person in group.people" :key="person.agentId">
              <span class="project-team-avatar is-small" aria-hidden="true">{{ initial(person) }}</span>
              <span class="project-team-person">
                <span>
                  <AgentName :space-id="spaceId" :agent-id="person.agentId" :name="person.name" />
                  <span v-if="number(person)" class="ui-meta"> · {{ number(person) }}</span>
                </span>
                <span v-if="person.responsibility" class="project-team-responsibility">{{ person.responsibility }}</span>
              </span>
            </li>
          </ul>
        </div>
        <p v-if="team.subTeamSuggestion?.suggested" class="ui-meta project-team-suggestion" data-sub-team-suggestion>
          {{ t('projects.overview.subTeamSuggestion', { count: team.subTeamSuggestion.memberCount }) }}
          <RouterLink :to="teamSettingsTo">{{ t('projects.overview.subTeamSuggestionLink') }}</RouterLink>
        </p>
        <template v-for="group in [
          { key: 'collaborators', title: t('projects.overview.collaborators'), people: team.collaborators },
          { key: 'peers', title: t('projects.overview.peers'), people: team.peers },
        ]" :key="group.key">
          <div v-if="group.people.length" class="project-team-group" :class="`is-${group.key}`">
            <h4>{{ group.title }}</h4>
            <ul class="project-team-list">
              <li v-for="person in group.people" :key="person.agentId">
                <span class="project-team-avatar is-small" aria-hidden="true">{{ initial(person) }}</span>
                <span class="project-team-person">
                  <span>
                    <AgentName :space-id="spaceId" :agent-id="person.agentId" :name="person.name" />
                    <span v-if="number(person)" class="ui-meta"> · {{ number(person) }}</span>
                  </span>
                  <span v-if="person.responsibility" class="project-team-responsibility">{{ person.responsibility }}</span>
                </span>
              </li>
            </ul>
          </div>
        </template>
        <p v-if="team.unavailableMemberIds.length" class="ui-meta">
          {{ t('projects.overview.unavailableMembers', { count: team.unavailableMemberIds.length }) }}
          <RouterLink :to="teamSettingsTo">{{ t('projects.overview.unavailableMembersLink') }}</RouterLink>
        </p>
      </div>
    </template>
  </section>
</template>
