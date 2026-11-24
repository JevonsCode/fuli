<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { agentResponsibility, profileProjectIds } from '@/features/agent-profile/profile-model'
import { currentLocale, t } from '@/i18n'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import { personalProjectsPath } from '@/router/paths'
import type { ProjectAgentAssignmentRecord, ProjectAgentRecord } from '@/types'

// 负责什么 (docs/fla-page.md): the responsibility in full — the one place on
// the page it appears — then the projects the FLA is on, each with its own
// responsibility when that differs. Earlier projects and how it was recruited
// fold away; why it left, if it did, stays in view.
const props = defineProps<{
  agent: ProjectAgentRecord
  assignments: ProjectAgentAssignmentRecord[] | undefined
  loading: boolean
  projectName: (id: string) => string
}>()

const SHOWN_PROJECTS = 4
const space = computed(() => props.agent.personalSpaceId)
const responsibility = computed(() => agentResponsibility(props.agent).trim())
const current = computed(() => profileProjectIds({ ...props.agent, assignments: props.assignments ?? props.agent.assignments }))
const previous = computed(() => (props.assignments ?? []).filter(item => item.status !== 'active'))
const hasHistory = computed(() => previous.value.length > 0 || Boolean(props.agent.recruitedAt || props.agent.recruitmentReason))
// A project's own responsibility, only where it says more than the FLA's own.
function projectResponsibility(projectId: string) {
  const own = props.assignments?.find(item => item.personalProjectId === projectId && item.status === 'active')?.responsibility?.trim()
  return own && own !== props.agent.profile.responsibility.trim() ? own : ''
}
const date = (value?: string | null) => formatDateTime(value, currentLocale(), DATE_ONLY, { missing: t('agentProfiles.timeUnknown') })
const joined = computed(() => t(props.agent.recruitedAt ? 'agentProfiles.joined' : 'agentProfiles.created'))
</script>

<template>
  <section class="duty" aria-labelledby="fla-duty-heading" data-fla-duty>
    <h2 id="fla-duty-heading" class="duty-label">{{ t('flaPage.duty.title') }}</h2>
    <div class="duty-card">
      <p v-if="responsibility" class="duty-text" data-fla-responsibility>{{ responsibility }}</p>
      <p v-else class="duty-muted">{{ t('flaPage.duty.none') }}</p>
      <p v-if="agent.archiveReason" class="duty-departure" data-profile-departure>
        <strong>{{ t('agentProfiles.departure') }}</strong> {{ agent.archiveReason }} <small>{{ date(agent.archivedAt) }}</small>
      </p>

      <div class="duty-block">
        <h3 class="duty-sub">{{ t('agentProfiles.projects') }} <span class="ui-num">{{ current.length }}</span></h3>
        <ul v-if="current.length" class="duty-projects agent-current-project-list">
          <li v-for="id in current.slice(0, SHOWN_PROJECTS)" :key="id" class="agent-project-item">
            <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', id)">{{ projectName(id) }}</RouterLink>
            <p v-if="projectResponsibility(id)" class="agent-project-responsibility">{{ projectResponsibility(id) }}</p>
          </li>
        </ul>
        <UiDisclosure v-if="current.length > SHOWN_PROJECTS" class="agent-project-overflow" :title="t('agentRedesign.projects.more', { count: current.length })">
          <ul class="duty-projects">
            <li v-for="id in current.slice(SHOWN_PROJECTS)" :key="id" class="agent-project-item">
              <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', id)">{{ projectName(id) }}</RouterLink>
              <p v-if="projectResponsibility(id)" class="agent-project-responsibility">{{ projectResponsibility(id) }}</p>
            </li>
          </ul>
        </UiDisclosure>
        <p v-if="!current.length && !loading" class="duty-muted">{{ t('agentProfiles.noProject') }}</p>
      </div>

      <UiDisclosure v-if="hasHistory" class="duty-history" :title="t('flaPage.duty.history')">
        <ol class="duty-timeline">
          <li v-for="item in previous" :key="item.assignmentId">
            <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', item.personalProjectId)">{{ projectName(item.personalProjectId) }}</RouterLink>
            <p>{{ item.responsibility }}</p>
            <small>{{ date(item.assignedAt) }} – {{ date(item.endedAt) }}</small>
          </li>
          <li v-if="agent.recruitedAt || agent.recruitmentReason">
            <strong>{{ t('agentProfiles.recruitment') }}</strong>
            <p v-if="agent.recruitmentReason">{{ agent.recruitmentReason }}</p>
            <small>{{ date(agent.recruitedAt) }}</small>
          </li>
        </ol>
      </UiDisclosure>
      <p class="duty-joined">{{ joined }} · {{ date(agent.recruitedAt || agent.createdAt) }}</p>
    </div>
  </section>
</template>

<style scoped>
.duty { display: grid; gap: 8px; }
.duty-label { margin: 0; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.duty-card { display: grid; gap: 16px; padding: 16px 20px; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.duty-text { margin: 0; color: var(--color-ink); font-size: var(--text-body); line-height: 1.7; white-space: pre-line; overflow-wrap: anywhere; }
.duty-muted { margin: 0; color: var(--color-muted); }
.duty-departure { margin: 0; color: var(--color-ink-soft); }
.duty-departure small, .duty-joined, .duty-timeline small { color: var(--color-muted); font-size: var(--text-meta); }
.duty-block { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--color-border); }
.duty-sub { display: flex; align-items: baseline; gap: 8px; margin: 0; color: var(--color-ink-soft); font-size: var(--text-meta); font-weight: var(--weight-strong); }
.duty-sub .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.duty-projects, .duty-timeline { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.duty-projects p, .duty-timeline p { margin: 2px 0 0; color: var(--color-ink-soft); font-size: var(--text-meta); }
.duty-history { padding-top: 12px; border-top: 1px solid var(--color-border); }
.duty-timeline { margin-top: 8px; }
.duty-joined { margin: 0; }
</style>
