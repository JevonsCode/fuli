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

export type ProjectAgentStatus = 'active' | 'inactive' | 'archived'

export type ProjectAgentType = 'coordinator' | 'durable' | 'hr' | 'temporary'

export type ProjectAgentWorkStatus =
  | 'idle'
  | 'awaiting_recruitment'
  | 'queued'
  | 'running'
  | 'paused'
  | 'failed'
  | 'awaiting_review'
  | 'blocked'
  | 'ended'

export type ProjectAgentTaskStatus =
  | 'awaiting_recruitment'
  | 'queued'
  | 'running'
  | 'paused'
  | 'failed'
  | 'awaiting_review'
  | 'blocked'
  | 'completed'
  | 'cancelled'

export type ProjectAgentModelMode = 'adaptive' | 'fast' | 'balanced' | 'deep'
export type ProjectAgentReasoningEffort = 'default' | 'low' | 'medium' | 'high'
export type ProjectAgentModelSelectionMode = 'flexible' | 'locked'

export interface ProjectAgentExecutorModel {
  provider: string
  model: string
  capabilities?: string[]
  available?: boolean
  strategyModes?: string[]
  reasoningEfforts?: string[]
  observedAt?: string | null
  unavailableReason?: string | null
}

export interface ProjectAgentExecutorRef {
  executorId: string
  label?: string | null
  provider?: string | null
  model?: string | null
  client?: ConversationSourceApplication | null
  availabilityStatus?: string | null
  actualUse?: {
    count: number
    lastUsedAt: string | null
  } | null
  personalSpaceId?: string | null
  displayName?: string | null
  executorKind?: string | null
  capabilities?: string[]
  globalPriority?: number | null
  healthRequired?: boolean
  registrationStatus?: string | null
  permissionStatus?: string | null
  preflightStatus?: string | null
  healthStatus?: string | null
  workspacePermission?: boolean | null
  revision?: number
  permissionRevision?: number
  registeredAt?: string | null
  updatedAt?: string | null
  testSource?: string | null
  cleanupEligible?: boolean
  advertisedModels?: ProjectAgentExecutorModel[]
  availableModels?: ProjectAgentExecutorModel[]
}

export interface ProjectAgentModelStrategy {
  /** Provider-neutral intent; no provider/model is inferred from this field. */
  mode?: ProjectAgentModelMode | null
  reasoningEffort?: ProjectAgentReasoningEffort | null
  capabilityHints?: string[]
}

export interface ProjectAgentExecutorPolicy {
  mode: ProjectAgentModelSelectionMode
  lockedExecutorIds?: string[]
  preferredExecutorIds?: string[]
  /** Resolved directory entries used for display; API stores the ID arrays above. */
  allowList?: ProjectAgentExecutorRef[]
}

export interface ProjectAgentActualExecution {
  executor?: string | null
  provider?: string | null
  model?: string | null
  client?: ConversationSourceApplication | null
  rule?: string | null
  fallback?: string | null
  reportedAt?: string | null
}

export interface ProjectAgentProfile {
  name: string
  responsibility: string
  capabilities: string[]
  initialPreferences: string[]
  status: ProjectAgentStatus
  occupationEmoji?: string | null
  agentType?: ProjectAgentType
  workKinds?: string[]
  defaultModelStrategy?: ProjectAgentModelStrategy | null
  executorPolicy?: ProjectAgentExecutorPolicy | null
  allowedClients?: ConversationSourceApplication[]
  testSource?: string | null
  cleanupEligible?: boolean
}

export type ProjectAgentAssignmentStatus =
  | 'active'
  | 'ended'
  | 'unassigned'
  | 'replaced'

export interface ProjectAgentAssignmentRecord {
  assignmentId: string
  personalSpaceId: string
  personalProjectId: string
  agentId: string
  responsibility: string
  scope?: string | null
  workKinds?: string[]
  capabilities?: string[]
  modelStrategyOverride?: ProjectAgentModelStrategy | null
  executorPolicyOverride?: ProjectAgentExecutorPolicy | null
  reason?: string | null
  status: ProjectAgentAssignmentStatus
  revision?: number
  sourceApplication?: ConversationSourceApplication | null
  sourceSessionId?: string | null
  assignedAt: string
  updatedAt: string
  endedAt?: string | null
  endReason?: string | null
  replacedByAssignmentId?: string | null
}

export interface ProjectAgentTaskParticipant {
  agentId: string
  assignmentId?: string | null
  role: 'lead' | 'collaborator' | string
  status: ProjectAgentTaskStatus
  assignmentSummary?: string | null
  joinedAt?: string | null
  updatedAt?: string | null
  endedAt?: string | null
}

export interface ProjectAgentTaskExecutionSummary {
  agentId?: string | null
  agentName?: string | null
  occupationEmoji?: string | null
  workerId?: string | null
  workerLabel?: string | null
  workerOccupationEmoji?: string | null
  participantRole?: string | null
  executor?: string | null
  executorId?: string | null
  sourceApplication?: ConversationSourceApplication | null
  actualModelProvider?: string | null
  actualModel?: string | null
  workSummary?: string | null
  status?: string | null
}

export interface ProjectAgentParallelPlan {
  enabled?: boolean | null
  independentVerification?: boolean | null
  conflictFreeScopes?: boolean | null
  reason?: string | null
  workstreamBoundaries?: string[]
}

export interface ProjectAgentTaskEvent {
  eventId: string
  taskId: string
  agentId?: string | null
  status: ProjectAgentTaskStatus
  actorKind?: 'agent' | 'human' | 'system' | 'hr' | string
  summary: string
  sourceApplication?: ConversationSourceApplication | null
  sourceSessionId?: string | null
  actualExecution?: ProjectAgentActualExecution | null
  actualModelProvider?: string | null
  actualModel?: string | null
  workerId?: string | null
  workerLabel?: string | null
  workerOccupationEmoji?: string | null
  workerStatus?: ProjectAgentTaskStatus | string | null
  createdAt: string
}

export interface ProjectAgentRoutingDecision {
  decisionId?: string
  taskId?: string
  coordinatorAgentId?: string | null
  complexity?: string | number | null
  complexityBasis?: string[]
  outcome?: string | null
  reason?: string | null
  matchBasis?: string[]
  candidateAgentIds?: string[]
  optimizationPriority?: string[]
  parallelPlan?: ProjectAgentParallelPlan | null
  selectedModelStrategy?: ProjectAgentModelStrategy | null
  modelStrategySource?: 'agent' | 'assignment' | 'task' | 'coordinator' | string
  ruleId?: string | null
  fallback?: string | null
}

export interface ProjectAgentTaskRecord {
  taskId: string
  personalSpaceId?: string
  personalProjectId?: string | null
  title: string
  objective?: string | null
  workKind?: string | null
  status: ProjectAgentTaskStatus
  runId?: string | null
  executionId?: string | null
  ownerAgentId?: string | null
  leadAgentId?: string | null
  coordinatorAgentId?: string | null
  hrAgentId?: string | null
  recruitmentId?: string | null
  participants: ProjectAgentTaskParticipant[]
  sourceApplication?: ConversationSourceApplication | null
  sourceSessionId?: string | null
  resultSummary?: string | null
  failureReason?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
  staffingIntent?: string | null
  routingOutcome?: string | null
  routingReason?: string | null
  routingExplanation?: string | null
  matchBasis?: string[]
  complexity?: string | number | null
  complexityBasis?: string[]
  effectiveModelStrategy?: ProjectAgentModelStrategy | null
  effectiveExecutorPolicy?: ProjectAgentExecutorPolicy | null
  modelStrategySource?: 'agent' | 'assignment' | 'task' | 'coordinator' | string
  actualExecution?: ProjectAgentActualExecution | null
  executionSummary?: ProjectAgentTaskExecutionSummary[]
  routingDecision?: ProjectAgentRoutingDecision | null
  events?: ProjectAgentTaskEvent[]
}

export interface ProjectAgentActivityTask {
  taskId: string
  title: string
  status: 'completed' | 'failed' | 'cancelled'
  summary: string
  occurredAt: string
  personalProjectId?: string | null
  assignmentId?: string | null
  collaborators?: ProjectAgentTaskParticipant[]
  sourceApplication?: ConversationSourceApplication | null
  actualExecution?: ProjectAgentActualExecution | null
  actualModelProvider?: string | null
  actualModel?: string | null
}

export interface ProjectAgentActivityDay {
  date: string
  completed: number
  failed: number
  cancelled: number
  total: number
  tasks?: ProjectAgentActivityTask[]
}

export interface ProjectAgentActivityResult {
  agentId: string
  personalSpaceId: string
  fromDate?: string
  toDate?: string
  days: ProjectAgentActivityDay[]
}

export type ProjectAgentRecruitmentPositionKind = 'durable' | 'temporary'

export interface ProjectAgentRecruitmentRecord {
  recruitmentId: string
  personalSpaceId: string
  personalProjectId: string
  taskId: string
  coordinatorAgentId: string
  hrAgentId?: string | null
  positionKind: ProjectAgentRecruitmentPositionKind | string
  workKind: string
  requiredCapabilities: string[]
  reasonCode: string
  reason: string
  status: string
  confirmationMode?: string | null
  proposedAgentId: string
  revision?: number
  recruitedAgentId?: string | null
  triggerSourceApplication?: ConversationSourceApplication | null
  triggerSourceSessionId?: string | null
  testSource?: string | null
  cleanupEligible?: boolean
  createdAt: string
  updatedAt: string
  fulfilledAt?: string | null
}

export interface ProjectAgentClientEvidence {
  client: ConversationSourceApplication
  allowed: boolean
  integrationStatus?: 'connected' | 'update_available' | 'not_connected' | 'unknown' | string
  actualUse?: {
    count: number
    lastUsedAt: string | null
  } | null
}

export type ProjectAgentRoutingRuleScope = 'global' | 'space' | 'project' | 'task'

export interface ProjectAgentRoutingRule {
  ruleId: string
  scope: ProjectAgentRoutingRuleScope
  priority: number
  personalProjectId?: string | null
  taskId?: string | null
  workKind?: string | null
  agentId?: string | null
  enabled: boolean
  description?: string | null
  executorIds?: string[]
  requiredCapabilities?: string[]
  modelStrategy?: ProjectAgentModelStrategy | null
  reason?: string | null
  revision?: number
  status?: string
  createdAt?: string | null
  updatedAt?: string | null
}

export type ProjectAgentRecruitmentConfirmationMode = 'automatic' | 'require_confirmation'

export interface ProjectAgentRecruitmentPolicy {
  personalSpaceId?: string | null
  confirmationMode: ProjectAgentRecruitmentConfirmationMode
  updatedAt?: string | null
}

export interface ProjectAgentCoordinationPolicy {
  personalSpaceId: string
  personalProjectId: string
  askBeforeRecruitment: boolean
  autoReusePreviousAgent: boolean
  updatedAt?: string | null
}

export interface ProjectAgentLearningEvidence {
  learningKey?: string
  evidenceId?: string
  personalProjectId?: string | null
  workKind?: string | null
  executor?: string | null
  model?: string | null
  modelStrategy?: ProjectAgentModelStrategy | null
  modelStrategyKey?: string | null
  sampleCount: number
  recentWeightedSamples?: number | null
  decayBasis?: string | null
  updatedAt?: string | null
  outcomes?: {
    success?: number
    rework?: number
    failure?: number
    explicitPraise?: number
    testOrAcceptance?: number
    scoreCount?: number
  }
  evidence?: Array<{
    evidenceId?: string
    kind: 'rework' | 'negative' | 'praise' | 'test' | 'acceptance' | 'score' | string
    count?: number
    summary?: string | null
    occurredAt?: string | null
  }>
  score?: number | null
  neutral?: boolean
}

export interface ProjectAgentRecord {
  agentId: string
  personalSpaceId: string
  personalProjectId?: string | null
  profile: ProjectAgentProfile
  createdAt: string
  updatedAt: string
  memoryScope?: 'reviewed_agent' | 'task_only' | string
  assignments?: ProjectAgentAssignmentRecord[]
  recruitmentId?: string | null
  temporaryTaskId?: string | null
  workStatus?: ProjectAgentWorkStatus
  openTaskCount?: number
  currentTaskId?: string | null
  observedClients?: ConversationSourceApplication[]
  recruitedAt?: string | null
  recruitmentReason?: string | null
  recruitmentSourceApplication?: ConversationSourceApplication | null
  tasks?: ProjectAgentTaskRecord[]
  recruitments?: ProjectAgentRecruitmentRecord[]
  recruitmentPolicy?: ProjectAgentRecruitmentPolicy | null
  activity?: ProjectAgentActivityResult | null
  clientEvidence?: ProjectAgentClientEvidence[]
  routingRules?: ProjectAgentRoutingRule[]
  learningEvidence?: Record<string, ProjectAgentLearningEvidence>
  isTestRole?: boolean
  executorDirectory?: ProjectAgentExecutorRef[]
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
  graphRuntimeMode: 'container' | 'native'
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
