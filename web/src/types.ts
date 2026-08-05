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

export interface ExternalKnowledgeConnector {
  type: 'mcp' | 'notion' | 'feishu' | 'custom' | string
  name: string
  capabilities: string[]
  status?: string
  trust?: string
  description?: string
  limitations?: string[]
}

export type ExternalKnowledgeMode = 'hybrid' | 'live' | 'mirror'

export interface ExternalKnowledgeBindingTarget {
  id: string
  personalSpaceId: string
  personalProjectId: string
  mode: ExternalKnowledgeMode
  status: string
  sync?: {
    lastSyncedAt?: string | null
    error?: string | null
    skippedCredentials?: number
  }
}

export interface ExternalKnowledgeBinding {
  id: string
  name: string
  connectorType: string
  mode: ExternalKnowledgeMode
  status: string
  target: {
    personalSpaceId: string
    personalProjectId: string
  }
  targets: ExternalKnowledgeBindingTarget[]
  sync?: {
    lastSyncedAt?: string | null
    error?: string | null
    skippedCredentials?: number
  }
}

export interface KnowledgeConflictPolicy {
  personalProjectId: string
  mode: 'ask_human' | 'agent_decide'
  updatedAt?: string | null
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

export interface RuntimePorts {
  console: number
  personalProvider: number
  personalNeo4jHttp: number
  personalNeo4jBolt: number
  workspaceProvider: number
  workspaceNeo4jHttp: number
  workspaceNeo4jBolt: number
}

export type ConversationSourceApplication =
  | 'codex'
  | 'claude_code'
  | 'cursor'
  | 'gemini_cli'
  | 'kiro'
  | 'other'

export type ConversationIdFormat = 'any' | 'uuid'

export interface ConversationLauncherRule {
  enabled: boolean
  idFormat: ConversationIdFormat
  appName: string
  urlTemplate: string
}

export type ConversationLauncherConfiguration = Record<
  ConversationSourceApplication,
  ConversationLauncherRule
>

export interface RuntimeSettings {
  version: 1
  ports: RuntimePorts
  lanAccess: boolean
  resourceRefreshSeconds: 5 | 10 | 30 | 60
  conversationLaunchers: ConversationLauncherConfiguration
}

export interface SystemSettingsResult {
  configured: RuntimeSettings
  active: RuntimeSettings
  restartRequired: boolean
}

export interface ResourceComponent {
  id: string
  label: string
  kind?: 'process' | 'container'
  status: string
  bytes: number
}

export interface ResourceMeasure {
  usedBytes: number
  hostTotalBytes: number | null
  hostFreeBytes: number | null
  complete: boolean
  components: ResourceComponent[]
}

export interface ResourceSnapshot {
  sampledAt: string
  status: 'ready' | 'partial'
  memory: ResourceMeasure
  disk: ResourceMeasure & {
    measuredAt: string
    temporaryBytes: number | null
  }
  exclusions: string[]
}

export interface EvidenceRecord {
  id?: string
  name?: string
  summary?: string
  source_description?: string
  source_kind?: string
  source_uri?: string
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
  source_name?: string | null
  target_name?: string | null
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
  next_offset?: number | null
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

export type WritingTasteProfileStatus = 'collecting' | 'preview_ready' | 'active'
export type WritingTasteEvidenceStatus = 'Confirmed' | 'Observed' | 'Working hypothesis'

export interface WritingTasteRule {
  item_id: string
  item_kind: 'entity' | 'relationship'
  preference_key: string
  title: string
  instruction: string
  reason: string
  evidence_status: WritingTasteEvidenceStatus
  confirmation_status: ConfirmationStatus
  preference_scope: 'global' | 'project'
  preference_project_id: string | null
  contexts: string[]
  evidence: EvidenceRecord[]
  evidence_count: number
  session_count: number
  confirmed_at: string | null
  updated_at: string | null
  origin_quadrant: string
  has_conflict: boolean
}

export interface WritingTasteReadinessCriterion {
  key: 'rules' | 'evidence' | 'sessions' | 'days' | 'confirmed' | 'conflicts'
  current: number
  target: number
  met: boolean
}

export interface WritingTasteProfile {
  status: WritingTasteProfileStatus
  ready: boolean
  generated_at: string
  generated_from: 'personal_profile_graph'
  scope: {
    personal_space_id: string | null
    personal_project_id: string | null
  }
  readiness: {
    rule_count: number
    evidence_count: number
    session_count: number
    observation_day_count: number
    confirmed_rule_count: number
    observed_rule_count: number
    working_hypothesis_count: number
    conflict_count: number
    standard_path_ready: boolean
    confirmed_path_ready: boolean
    thresholds: {
      rule_count: number
      evidence_count: number
      session_count: number
      observation_day_count: number
      confirmed_rule_count: number
    }
    criteria: WritingTasteReadinessCriterion[]
  }
  conflicts: Array<{
    id: string
    preference_key: string | null
    item_ids: string[]
    source: 'recorded' | 'same_key'
  }>
  rules: WritingTasteRule[]
  skill_name: 'user-writing-taste' | null
  skill_version: string | null
  profile_markdown: string | null
  agent_markdown: string | null
}
