import { ref } from 'vue'
import { getJson } from '@/api/client'
import { t } from '@/i18n'
import type { ProjectAgentAssignmentRecord, ProjectAgentRecord, ProjectAgentStatus } from '@/types'

export interface EmployeeTemplate {
  id: string
  version: string
  name: string
  role: string
  description: string
  capabilities: string[]
  permissions: string[]
  runtime: { apiVersion: number } | null
  runtimeStatus: 'ready' | 'install_required' | 'unavailable' | 'not_required'
  agentId: string | null
  agentStatus: ProjectAgentStatus | null
  assignments: ProjectAgentAssignmentRecord[]
  assignmentsVersion: string
  identityConflict: boolean
  defaultProjectScope?: 'all' | 'selected'
  management?: EmployeeManagement
  managedProjects?: { id: string; name: string }[]
}

export interface EmployeeManagement {
  revision?: number
  mode: 'all' | 'selected'
  projectIds: string[]
  excludedProjectIds: string[]
  titleMode: 'off' | 'suggest' | 'auto'
  titleStyle: 'text' | 'emoji'
}

export interface EmployeeRecruitmentResult {
  templateId: string
  agent: ProjectAgentRecord
  assignment: ProjectAgentAssignmentRecord | null
  assignments: ProjectAgentAssignmentRecord[]
  endedAssignments: ProjectAgentAssignmentRecord[]
  assignmentsVersion: string
  idempotent: boolean
  management?: EmployeeManagement
}

export interface EmployeeWorkspace {
  templateId: string
  name: string
  role: string
  project: { id: string; name: string }
  runtimeStatus: EmployeeTemplate['runtimeStatus']
  workbenchUrl: string
  agentCardUrl: string
}

// Presentation routing only. The host still verifies the template, identity and assignment.
export function employeeTemplateIdForAgent(agent: ProjectAgentRecord): string | null {
  const id = /^employee\.([a-z][a-z0-9-]{0,63})$/.exec(agent.agentId)?.[1]
  return id && agent.profile.capabilities.includes(`fuli.employee:${id}`) ? id : null
}

export const employeeTemplates = ref<EmployeeTemplate[]>([])
export const employeeCatalogLoading = ref(false)
export const employeeCatalogError = ref('')
let currentSpace = ''
let pending: Promise<void> | null = null
let generation = 0

export function refreshEmployeeCatalog(spaceId: string): Promise<void> {
  if (spaceId === currentSpace && pending) return pending
  const version = ++generation
  if (spaceId !== currentSpace) employeeTemplates.value = []
  currentSpace = spaceId
  employeeCatalogError.value = ''
  if (!spaceId) { employeeTemplates.value = []; employeeCatalogLoading.value = false; return Promise.resolve() }
  employeeCatalogLoading.value = true
  pending = getJson<{ templates: EmployeeTemplate[] }>(`/api/employee-templates?${new URLSearchParams({ personalSpaceId: spaceId })}`)
    .then((result) => { if (version === generation) employeeTemplates.value = Array.isArray(result.templates) ? result.templates : [] })
    .catch((error: unknown) => {
      if (version === generation) { employeeTemplates.value = []; employeeCatalogError.value = employeeErrorMessage(error) }
    })
    .finally(() => {
      if (version === generation) { employeeCatalogLoading.value = false; pending = null }
    })
  return pending
}

export function employeeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  try {
    const body = JSON.parse(message) as { code?: string; error?: string }
    if (body.code && ['runtime_unavailable', 'assignment_required', 'project_not_found', 'identity_conflict', 'reactivation_required', 'assignment_scope_conflict', 'assignment_update_incomplete'].includes(body.code)) {
      return t(`employees.errors.${body.code}`)
    }
    return body.error || t('employees.loadError')
  } catch { return message || t('employees.loadError') }
}
