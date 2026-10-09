<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
import { employeeTemplates, refreshEmployeeCatalog } from './catalog'
import { employeeAvatarUrl } from './avatars'
import { agentProfilePath } from '@/features/agent-profile/profile-model'
import AgentHand from '@/features/project-agents/AgentHand.vue'
const props = defineProps<{ personalSpaceId: string }>()
watch(() => props.personalSpaceId, (id) => { void refreshEmployeeCatalog(id === 'current' ? '' : id) }, { immediate: true })
const employees = computed(() => employeeTemplates.value.filter((entry) => entry.agentId && entry.agentStatus === 'active'
  && (entry.runtime || entry.workbench?.kind === 'native')))
</script>

<template>
  <template v-if="employees.length">
    <p class="nav-section-label">{{ t('employees.directory') }}</p>
    <div v-for="employee in employees" :key="employee.id" class="employee-nav-row">
    <RouterLink :to="agentProfilePath(personalSpaceId, employee.agentId!)" class="space-nav-button employee-nav" active-class="is-active">
      <span class="employee-nav-mark" aria-hidden="true">
        <img v-if="employeeAvatarUrl(employee.id)" :src="employeeAvatarUrl(employee.id)" alt="" />
        <template v-else>{{ employee.name.slice(0, 1) }}</template>
      </span>
      <span class="nav-copy"><strong>{{ employee.name }}</strong></span>
    </RouterLink>
    <RouterLink class="employee-workbench-link" :to="`/employees/${encodeURIComponent(employee.id)}`" :aria-label="`${employee.name} · ${t('agentProfiles.workbench')}`" :title="t('agentProfiles.workbench')"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M3 4h14v12H3zM3 8h14M8 8v8" fill="none" stroke="currentColor" stroke-width="1.4" /></svg></RouterLink>
    <AgentHand :agent-id="employee.agentId!" />
    </div>
  </template>
</template>

<style scoped>
.employee-workbench-link { display: grid; place-items: center; width: 32px; min-height: 36px; flex: 0 0 32px; color: var(--color-muted); padding: 6px; border-radius: var(--radius-control); }
.employee-workbench-link:hover { color: var(--color-accent); background: var(--color-accent-soft); }
.employee-nav-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.employee-nav-row > .employee-nav { flex: 1; min-width: 0; grid-template-columns: 26px minmax(0, 1fr); padding-inline: 8px; }
.employee-nav-row > .agent-hand { width: auto; margin-inline-end: 4px; }
.employee-nav-mark { display: grid; flex: 0 0 26px; height: 26px; place-items: center; overflow: hidden; border-radius: var(--radius-control); background: var(--color-surface-subtle); color: var(--color-ink); font-size: 15px; font-weight: 650; }
.employee-nav-mark img { width: 100%; height: 100%; object-fit: cover; }
</style>
