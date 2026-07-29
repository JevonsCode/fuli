export type CapabilityName =
  | 'browsePublicProjects'
  | 'publishProject'
  | 'reviewProposals'
  | 'submitKnowledge'
  | 'subscribeProject'

export interface CapturePolicy {
  enabled: boolean
  updatedAt?: string | null
}

export interface AgentAccessPolicy {
  enabled: boolean
  updatedAt?: string | null
}

export interface PersonalSpace {
  id: string
  name: string
  [key: string]: unknown
}

export interface ProjectProfile {
  name: string
  purpose?: string
  scope?: string
  technical_summary?: string
  lifecycle?: string
  sources?: Array<Record<string, unknown>>
  boundaries?: string[]
  assessment?: {
    score: number
    confirmed: string[]
    inferred: string[]
    dimensions?: Array<{ evidence?: unknown[] }>
  }
}

export interface PersonalProject {
  project_id: string
  personal_space_id: string
  publication_key?: string | null
  profile: ProjectProfile
}

export interface ProjectRelease {
  version: string
  publisher_name?: string
  published_at?: string
  update_summary?: string
}

export interface PublicProject {
  id: string
  name: string
  description?: string
  providerUrl: string
  publication_key?: string | null
  role?: string
  isOwner?: boolean
  can_manage?: boolean
  profile?: ProjectProfile
  current_release?: ProjectRelease | null
}

export interface Subscription {
  project_id: string
  provider_url: string
  project_name?: string
  [key: string]: unknown
}

export interface ProviderStatus {
  status: string
  providerUrl?: string
  name?: string
  [key: string]: unknown
}

export interface ConsoleState {
  mode: 'personal_only' | 'degraded' | 'connected' | 'graphiti' | string
  activePersonalSpaceId?: string | null
  personalSpaces: PersonalSpace[]
  personalProjects?: PersonalProject[]
  projects: PublicProject[]
  subscriptions: Subscription[]
  capturePolicy?: CapturePolicy
  agentAccessPolicy?: AgentAccessPolicy
  capabilities?: Partial<Record<CapabilityName, boolean>>
  providers?: {
    personal?: ProviderStatus
    workspaces?: ProviderStatus[]
  }
}

export interface EvidenceRecord {
  id?: string
  name?: string
  summary?: string
  source_description?: string
  source_kind?: string
  source_application?: string
  source_excerpt?: string
  session_id?: string
  source_turn_id?: string
  reference_time?: string
  created_at?: string
  personal_project_id?: string
  [key: string]: unknown
}

export interface ConfirmationActor {
  kind: 'user' | 'agent' | 'authoritative_source' | 'import' | string
  label?: string | null
}

export interface ConfirmationBasis {
  existence_reason: string
  quadrant_reason: string
  proposed_by: ConfirmationActor
  confirmed_by?: ConfirmationActor | null
  confirmed_at?: string | null
  agent_policy_version?: string | null
}

export type ConfirmationStatus = 'pending' | 'agent_confirmed' | 'confirmed'
export type KnowledgeInheritanceMode =
  | 'local_only'
  | 'descendants'
  | 'selected_projects'

export type HumanChangeStatus = 'none' | 'unseen' | 'viewed' | 'reviewed'

export interface KnowledgeAuditRecord {
  id: string
  item_id: string
  item_kind: 'entity' | 'relationship'
  action: 'human_change' | 'agent_view' | 'agent_review' | 'knowledge_used'
  human_change_version: number
  reason: string
  tool_name?: string | null
  task_id?: string | null
  session_id?: string | null
  use_kind?: 'cited' | 'applied' | null
  usage_generation?: number | null
  conflict_check?: 'no_conflict' | 'conflict' | null
  classification_check?: 'reasonable' | 'needs_change' | null
  outcome?: 'pending_review' | 'requires_attention' | 'reviewed' | 'agent_confirmed' | null
  created_at: string
}

export interface KnowledgeNode {
  id: string
  name: string
  type: string
  summary?: string
  attributes?: Record<string, unknown>
  group_id?: string
  origin_quadrant?: string
  current_quadrant?: string
  epistemic_status?: string
  epistemic_state_explicit?: boolean
  confirmation_status?: string
  confirmation_state_explicit?: boolean
  confirmation_basis?: ConfirmationBasis | null
  reasoning_summary?: string
  profile_aspect?: string | null
  preference_scope?: string | null
  preference_project_id?: string | null
  inheritance_mode?: KnowledgeInheritanceMode
  inherited_project_ids?: string[]
  human_edited?: boolean
  human_change_status?: HumanChangeStatus
  human_change_version?: number
  last_human_changed_at?: string | null
  last_agent_viewed_at?: string | null
  last_agent_reviewed_at?: string | null
  utility_score?: number
  confidence_score?: number
  qualified_use_count?: number
  distinct_task_count?: number
  last_used_at?: string | null
  usage_generation?: number
  invalid_at?: string | null
  replaced_by_item_id?: string | null
  replaced_by_item_kind?: 'entity' | 'relationship' | null
  created_at?: string
  evidence?: EvidenceRecord[]
  revisions?: Array<Record<string, unknown>>
  assignments?: Array<Record<string, unknown>>
  project_references?: Array<Record<string, unknown>>
  conflicts?: Array<Record<string, unknown>>
  audit_events?: KnowledgeAuditRecord[]
  [key: string]: unknown
}

export interface KnowledgeEdge {
  id: string
  source: string | KnowledgeNode
  target: string | KnowledgeNode
  type: string
  fact?: string
  attributes?: Record<string, unknown>
  origin_quadrant?: string
  current_quadrant?: string
  epistemic_status?: string
  epistemic_state_explicit?: boolean
  confirmation_status?: string
  confirmation_state_explicit?: boolean
  confirmation_basis?: ConfirmationBasis | null
  reasoning_summary?: string
  profile_aspect?: string | null
  preference_scope?: string | null
  preference_project_id?: string | null
  inheritance_mode?: KnowledgeInheritanceMode
  inherited_project_ids?: string[]
  human_edited?: boolean
  human_change_status?: HumanChangeStatus
  human_change_version?: number
  last_human_changed_at?: string | null
  last_agent_viewed_at?: string | null
  last_agent_reviewed_at?: string | null
  utility_score?: number
  confidence_score?: number
  qualified_use_count?: number
  distinct_task_count?: number
  last_used_at?: string | null
  usage_generation?: number
  valid_at?: string
  invalid_at?: string | null
  replaced_by_item_id?: string | null
  replaced_by_item_kind?: 'entity' | 'relationship' | null
  created_at?: string
  evidence?: EvidenceRecord[]
  revisions?: Array<Record<string, unknown>>
  assignments?: Array<Record<string, unknown>>
  project_references?: Array<Record<string, unknown>>
  conflicts?: Array<Record<string, unknown>>
  audit_events?: KnowledgeAuditRecord[]
  episodes?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface KnowledgeGraph {
  space_id?: string | null
  nodes: KnowledgeNode[]
  edges: KnowledgeEdge[]
  truncated?: boolean
}

export type KnowledgeItem = {
  id: string
  itemKind: 'entity' | 'relationship'
  title: string
  body: string
  type: string
  originQuadrant: string
  currentQuadrant: string
  epistemicStatus: string
  classificationExplicit: boolean
  confirmationStatus: ConfirmationStatus
  confirmationExplicit: boolean
  confirmationBasis: ConfirmationBasis | null
  reasoningSummary: string
  profileAspect: string | null
  preferenceScope: string | null
  preferenceProjectId: string | null
  inheritanceMode: KnowledgeInheritanceMode
  inheritedProjectIds: string[]
  humanEdited: boolean
  humanChangeStatus: HumanChangeStatus
  humanChangeVersion: number
  lastHumanChangedAt: string | null
  lastAgentViewedAt: string | null
  lastAgentReviewedAt: string | null
  utilityScore: number
  confidenceScore: number
  qualifiedUseCount: number
  distinctTaskCount: number
  lastUsedAt: string | null
  usageGeneration: number
  invalidAt?: string | null
  replacedByItemId: string | null
  replacedByItemKind: 'entity' | 'relationship' | null
  createdAt?: string
  evidence: EvidenceRecord[]
  revisions: Array<Record<string, unknown>>
  assignments: Array<Record<string, unknown>>
  projectReferences: Array<Record<string, unknown>>
  conflicts: Array<Record<string, unknown>>
  auditEvents: KnowledgeAuditRecord[]
  raw: KnowledgeNode | KnowledgeEdge
}

export type KnowledgeConfirmationGroupKind = 'source' | 'session'

export interface KnowledgeConfirmationGroup {
  key: string
  kind: KnowledgeConfirmationGroupKind
  value: string
  label: string
  description: string
  items: KnowledgeItem[]
}
