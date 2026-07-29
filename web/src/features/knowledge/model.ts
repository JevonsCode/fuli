import type {
  ConfirmationActor,
  ConfirmationStatus,
  EvidenceRecord,
  KnowledgeConfirmationGroup,
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeItem,
  KnowledgeNode,
  HumanChangeStatus,
} from '@/types'

const MANAGEMENT_TYPES = new Set([
  'ProjectSpace',
  'PersonalSpace',
  'PersonalProject',
  'ProjectPurpose',
  'ProjectScope',
  'ProjectSource',
  'ProjectBoundary',
  'ProjectAssessment',
  'AssessmentDimension',
  'RelatedPersonalProject',
])

const PROJECT_MATERIAL_TYPE_LABELS: Record<string, string> = {
  ProjectSpace: '项目空间',
  PersonalSpace: '个人空间',
  PersonalProject: '项目档案',
  ProjectPurpose: '项目目标',
  ProjectScope: '项目范围',
  TechnicalSummary: '技术说明',
  ProjectSource: '资料来源',
  ProjectBoundary: '项目边界',
  ProjectAssessment: '档案评估',
  AssessmentDimension: '评估维度',
  RelatedPersonalProject: '关联项目',
}

export const QUADRANT_LABELS: Record<string, string> = {
  known_known: '已知的已知',
  known_unknown: '已知的未知',
  unknown_known: '未知的已知',
  unknown_unknown: '未知的未知',
  unclassified: '待分类',
}

export const EPISTEMIC_LABELS: Record<string, string> = {
  confirmed: '旧版确认标记',
  observed: '旧版观察标记',
  exploratory: '旧版探索标记',
  unreviewed: '待复核',
}

export const QUADRANT_DESCRIPTIONS: Record<string, string> = {
  known_known: '被明确表达出来的知识或结论。',
  known_unknown: '被明确提出、但仍在等待答案的问题。',
  unknown_known: '从行为、案例、反馈或反应中提炼出的隐性知识。',
  unknown_unknown: '在探索过程中发现、仍需判断的潜在盲点。',
  unclassified: '旧内容还没有明确记录发现时所属象限。',
}

export const REVIEW_STATE_LABELS: Record<KnowledgeReviewState, string> = {
  confirmed: '已确认',
  agent_confirmed: 'Agent 已确认',
  pending: '待确认',
}

export const CONFIRMATION_ACTOR_LABELS: Record<string, string> = {
  user: '用户',
  agent: 'Agent',
  authoritative_source: '权威来源',
  import: '导入记录',
}

export const PROFILE_LABELS: Record<string, string> = {
  taste: '品味',
  personality: '个性',
  judgment_preference: '判断偏好',
}

export const REVISION_ACTION_LABELS: Record<string, string> = {
  confirm: '确认',
  update: '内容纠正',
  invalidate: '标记失效',
  link_replacement: '补充替代关联',
  restore: '恢复有效',
  scope_change: '调整生效范围',
  batch_confirm: '批量确认',
}

export const HUMAN_CHANGE_STATUS_LABELS: Record<HumanChangeStatus, string> = {
  none: '没有人工变更',
  unseen: '人工改动 · Agent 未查看',
  viewed: 'Agent 已查看 · 待审核',
  reviewed: 'Agent 已审核',
}

export const KNOWLEDGE_AUDIT_ACTION_LABELS: Record<string, string> = {
  human_change: '人工修改',
  agent_view: 'Agent 查看',
  agent_review: 'Agent 审核',
  knowledge_used: 'Agent 实际使用',
}

export function quadrantLabel(value?: string | null) {
  return QUADRANT_LABELS[value ?? 'unclassified'] ?? value ?? QUADRANT_LABELS.unclassified
}

export function quadrantDescription(value?: string | null) {
  return QUADRANT_DESCRIPTIONS[value ?? 'unclassified']
    ?? '这是一个自定义认知阶段；请结合形成过程与来源判断。'
}

export function profileAspectLabel(value?: string | null) {
  return PROFILE_LABELS[value ?? ''] ?? value ?? ''
}

export function revisionActionLabel(value?: string | null) {
  return REVISION_ACTION_LABELS[value ?? ''] ?? value ?? '修订'
}

export function humanChangeStatusLabel(value?: HumanChangeStatus | null) {
  return HUMAN_CHANGE_STATUS_LABELS[value ?? 'none']
}

export function knowledgeAuditActionLabel(value?: string | null) {
  return KNOWLEDGE_AUDIT_ACTION_LABELS[value ?? ''] ?? value ?? '审计记录'
}

export function confirmationActorLabel(actor?: ConfirmationActor | null) {
  if (!actor) return '尚未记录'
  return actor.label || CONFIRMATION_ACTOR_LABELS[actor.kind] || actor.kind
}

export function endpointId(endpoint: string | KnowledgeNode) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint
}

export function currentKnowledgeGraph(graph: KnowledgeGraph): KnowledgeGraph {
  const nodes = graph.nodes.filter((node) => !node.invalid_at)
  const nodeIds = new Set(nodes.map(({ id }) => id))
  const edges = graph.edges.filter(
    (edge) =>
      !edge.invalid_at
      && nodeIds.has(endpointId(edge.source))
      && nodeIds.has(endpointId(edge.target)),
  )
  return { ...graph, nodes, edges }
}

export function knowledgeItems(graph: KnowledgeGraph | null): KnowledgeItem[] {
  if (!graph) return []
  const names = new Map(graph.nodes.map((node) => [node.id, node.name]))
  const nodes: KnowledgeItem[] = graph.nodes
    .filter((node) => !isManagementNode(node))
    .map((node) => knowledgeItemFromNode(node))
  const edges: KnowledgeItem[] = graph.edges
    .filter((edge) => !isManagementEdge(edge))
    .map((edge) => knowledgeItemFromEdge(edge, names))
  return [...nodes, ...edges].sort((left, right) => latestTime(right) - latestTime(left))
}

export function managementKnowledgeItems(graph: KnowledgeGraph | null): KnowledgeItem[] {
  if (!graph) return []
  const names = new Map(graph.nodes.map((node) => [node.id, node.name]))
  const nodes = graph.nodes
    .filter(isManagementNode)
    .map((node) => knowledgeItemFromNode(node))
  const edges = graph.edges
    .filter(isManagementEdge)
    .map((edge) => knowledgeItemFromEdge(edge, names))
  return [...nodes, ...edges]
}

export function knowledgeItemFromNode(node: KnowledgeNode): KnowledgeItem {
  return {
    id: node.id,
    itemKind: 'entity',
    title: node.name,
    body: node.summary || '没有补充说明',
    type: node.type,
    ...commonItem(node),
    raw: node,
  }
}

export function knowledgeItemFromEdge(
  edge: KnowledgeEdge,
  names: Map<string, string>,
): KnowledgeItem {
  return {
    id: edge.id,
    itemKind: 'relationship',
    title: `${names.get(endpointId(edge.source)) ?? '未知实体'} → ${
      names.get(endpointId(edge.target)) ?? '未知实体'
    }`,
    body: edge.fact || '没有关系说明',
    type: `关系 · ${edge.type}`,
    ...commonItem(edge),
    raw: edge,
  }
}

export function isManagementKnowledgeItem(item: KnowledgeItem | null) {
  if (!item) return false
  return MANAGEMENT_TYPES.has(item.type)
    || isManagementId(item.id)
}

export function projectMaterialTypeLabel(item: KnowledgeItem) {
  if (item.itemKind === 'relationship') return '项目资料关系'
  return PROJECT_MATERIAL_TYPE_LABELS[item.type] ?? item.type
}

export function personalProjectIdForItem(item: KnowledgeItem | null) {
  if (!item || item.itemKind !== 'entity') return null
  const attributes = item.raw.attributes
  const projectId = attributes?.projectId
  return typeof projectId === 'string' && projectId ? projectId : null
}

function isManagementNode(node: KnowledgeNode) {
  return MANAGEMENT_TYPES.has(node.type) || isManagementId(node.id)
}

function isManagementEdge(edge: KnowledgeEdge) {
  return isManagementId(edge.id)
}

function isManagementId(id: string) {
  return String(id).startsWith('project-profile:')
    || String(id).startsWith('project-profile-edge:')
    || String(id).startsWith('space-edge:')
    || String(id).startsWith('personal-project-relation:')
}

export function filterKnowledgeItems(
  items: KnowledgeItem[],
  filters: {
    query?: string
    type?: string
    quadrant?: string
    profile?: string
    status?: string
    humanChange?: string
  },
) {
  const needle = filters.query?.trim().toLocaleLowerCase() ?? ''
  return items.filter((item) => {
    if (filters.type && filters.type !== 'all' && item.type !== filters.type) return false
    if (
      filters.quadrant
      && filters.quadrant !== 'all'
      && item.originQuadrant !== filters.quadrant
    ) return false
    if (filters.profile === 'profile' && !item.profileAspect) return false
    if (filters.profile === 'regular' && item.profileAspect) return false
    if (filters.status === 'current' && item.invalidAt) return false
    if (filters.status === 'historical' && !item.invalidAt) return false
    if (
      filters.humanChange === 'human_changed'
      && !item.humanEdited
    ) return false
    if (
      filters.humanChange
      && !['all', 'human_changed'].includes(filters.humanChange)
      && item.humanChangeStatus !== filters.humanChange
    ) return false
    return !needle || searchableText(item).toLocaleLowerCase().includes(needle)
  })
}

export function personalProfileItems(graph: KnowledgeGraph | null) {
  const items = knowledgeItems(graph).filter(({ profileAspect }) => profileAspect)
  const relatedEntityIds = new Set(
    items
      .filter(({ itemKind }) => itemKind === 'relationship')
      .flatMap(({ raw }) => {
        const edge = raw as KnowledgeEdge
        return [endpointId(edge.source), endpointId(edge.target)]
      }),
  )
  return items.filter(
    ({ id, itemKind }) => itemKind === 'relationship' || !relatedEntityIds.has(id),
  )
}

export function personalProfileGraph(
  graph: KnowledgeGraph,
  activeProjectId: string | null = null,
): KnowledgeGraph {
  const edges = graph.edges.filter(
    (edge) => edge.profile_aspect && preferenceApplies(edge, activeProjectId),
  )
  const nodeIds = new Set(
    edges.flatMap((edge) => [endpointId(edge.source), endpointId(edge.target)]),
  )
  for (const node of graph.nodes) {
    if (node.profile_aspect && preferenceApplies(node, activeProjectId)) nodeIds.add(node.id)
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: edges.filter(
      (edge) => nodeIds.has(endpointId(edge.source)) && nodeIds.has(endpointId(edge.target)),
    ),
  }
}

export function mergeKnowledgeGraphs(graphs: Array<KnowledgeGraph | null>): KnowledgeGraph {
  const available = graphs.filter((graph): graph is KnowledgeGraph => Boolean(graph))
  return {
    ...(available[0] ?? { space_id: null }),
    nodes: mergeItems(available.flatMap((graph) => graph.nodes)),
    edges: mergeItems(available.flatMap((graph) => graph.edges)),
    truncated: available.some(({ truncated }) => truncated),
  }
}

export function latestItemValue(item: KnowledgeItem) {
  return (
    (item.revisions.at(0)?.created_at as string | undefined)
    ?? item.createdAt
    ?? item.evidence.at(0)?.created_at
    ?? item.evidence.at(0)?.reference_time
    ?? null
  )
}

export function formatTime(value?: string | null) {
  if (!value) return '未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

export type KnowledgeReviewState = 'confirmed' | 'agent_confirmed' | 'pending'

export function knowledgeReviewState(item: KnowledgeItem): KnowledgeReviewState {
  const basis = item.confirmationBasis
  if (
    !item.confirmationExplicit
    || !basis?.confirmed_by
    || !basis.confirmed_at
  ) return 'pending'
  if (
    item.confirmationStatus === 'confirmed'
    && ['user', 'authoritative_source'].includes(basis.confirmed_by.kind)
  ) return 'confirmed'
  if (
    item.confirmationStatus === 'agent_confirmed'
    && basis.confirmed_by.kind === 'agent'
    && Boolean(basis.agent_policy_version)
  ) return 'agent_confirmed'
  return 'pending'
}

export function reviewStateLabel(item: KnowledgeItem) {
  return REVIEW_STATE_LABELS[knowledgeReviewState(item)]
}

export function batchConfirmationGroups(
  items: KnowledgeItem[],
): KnowledgeConfirmationGroup[] {
  const groups = new Map<string, KnowledgeConfirmationGroup>()
  const candidates = items.filter(
    (item) =>
      !item.invalidAt
      && item.classificationExplicit
      && knowledgeReviewState(item) !== 'confirmed',
  )
  for (const item of candidates) {
    for (const evidence of item.evidence) {
      if (evidence.id) {
        addConfirmationGroup(groups, {
          kind: 'source',
          value: evidence.id,
          label: evidenceLabel(evidence),
          description: evidence.source_description || evidence.summary || '同一条来源记录',
        }, item)
      }
      if (evidence.session_id) {
        addConfirmationGroup(groups, {
          kind: 'session',
          value: evidence.session_id,
          label: sessionLabel(evidence),
          description: evidence.source_description || evidence.summary || '同一次来源会话',
        }, item)
      }
    }
  }
  return [...groups.values()]
    .filter(({ items: groupedItems }) => groupedItems.length >= 2)
    .sort(
      (left, right) =>
        right.items.length - left.items.length
        || left.label.localeCompare(right.label, 'zh-CN'),
    )
}

export function batchConfirmationBasis(
  item: KnowledgeItem,
  group: Pick<KnowledgeConfirmationGroup, 'kind' | 'value' | 'label'>,
) {
  const evidence = item.evidence.find((candidate) =>
    group.kind === 'source'
      ? candidate.id === group.value
      : candidate.session_id === group.value,
  )
  const existing = item.confirmationBasis
  return {
    existenceReason: existing?.existence_reason
      || evidence?.source_description
      || evidence?.summary
      || `该内容由来源“${group.label}”支持。`,
    quadrantReason: existing?.quadrant_reason
      || item.reasoningSummary
      || `该内容在发现时符合“${quadrantLabel(item.originQuadrant)}”：${
        quadrantDescription(item.originQuadrant)
      }`,
    proposedBy: existing?.proposed_by || proposedByFromEvidence(evidence),
  }
}

export function confirmationBasisCount(item: KnowledgeItem) {
  return item.evidence.length + (item.confirmationBasis ? 1 : 0)
}

function addConfirmationGroup(
  groups: Map<string, KnowledgeConfirmationGroup>,
  group: Omit<KnowledgeConfirmationGroup, 'key' | 'items'>,
  item: KnowledgeItem,
) {
  const key = `${group.kind}:${group.value}`
  const existing = groups.get(key) ?? {
    key,
    ...group,
    items: [],
  }
  const itemKey = `${item.itemKind}:${item.id}`
  if (!existing.items.some((candidate) => `${candidate.itemKind}:${candidate.id}` === itemKey)) {
    existing.items.push(item)
  }
  groups.set(key, existing)
}

function evidenceLabel(evidence: EvidenceRecord) {
  return evidence.name
    || evidence.source_description
    || evidence.summary
    || '来源记录'
}

function sessionLabel(evidence: EvidenceRecord) {
  const application = {
    codex: 'Codex',
    claude_code: 'Claude Code',
    cursor: 'Cursor',
    kiro: 'Kiro',
    other: '其他来源',
  }[evidence.source_application ?? '']
  return application
    ? `${application} · ${evidence.name || evidence.source_kind || '会话'}`
    : evidence.name || evidence.source_kind || '来源会话'
}

function proposedByFromEvidence(evidence?: EvidenceRecord) {
  const application = {
    codex: 'Codex',
    claude_code: 'Claude Code',
    cursor: 'Cursor',
    kiro: 'Kiro',
    other: '其他 Agent',
  }[evidence?.source_application ?? '']
  return application
    ? { kind: 'agent', label: application }
    : { kind: 'import', label: '历史记录' }
}

export function classificationExplanation(item: KnowledgeItem) {
  if (!item.classificationExplicit) {
    return '这条旧内容没有显式记录发现时象限；保存前需要人工补充，系统不会自动归入“已知的已知”。'
  }
  const basis = item.confirmationBasis
  if (knowledgeReviewState(item) === 'confirmed' && basis) {
    return `${confirmationActorLabel(basis.confirmed_by)}于 ${formatTime(
      basis.confirmed_at,
    )} 确认；本次确认同时覆盖知识内容和象限归类。`
  }
  if (knowledgeReviewState(item) === 'agent_confirmed' && basis) {
    return `这条内容因跨任务实际使用达到策略阈值，于 ${formatTime(
      basis.confirmed_at,
    )} 标记为 Agent 已确认；它仍低于人工或权威来源确认。`
  }
  if (basis) {
    return `${confirmationActorLabel(basis.proposed_by)}提出了这条内容，当前仍等待确认；来源证据不会自动升级为确认。`
  }
  return '旧数据没有结构化的确认人和确认时间，已统一列入“待确认”，不会继续显示为已确认。'
}

export function confirmationBasisSummary(item: KnowledgeItem) {
  const basis = item.confirmationBasis
  if (!basis) return '旧数据 · 确认人和时间缺失'
  if (knowledgeReviewState(item) === 'confirmed') {
    return `${confirmationActorLabel(basis.confirmed_by)} · ${formatTime(basis.confirmed_at)}`
  }
  if (knowledgeReviewState(item) === 'agent_confirmed') {
    return `Agent 使用策略 · ${formatTime(basis.confirmed_at)}`
  }
  return `${confirmationActorLabel(basis.proposed_by)}提出 · ${basis.existence_reason}`
}

function commonItem(item: KnowledgeNode | KnowledgeEdge) {
  const classificationExplicit = item.epistemic_state_explicit === true
  const confirmationExplicit = item.confirmation_state_explicit === true
  return {
    originQuadrant: classificationExplicit ? item.origin_quadrant ?? 'known_known' : 'unclassified',
    currentQuadrant: classificationExplicit ? item.current_quadrant ?? 'known_known' : 'unclassified',
    epistemicStatus: classificationExplicit ? item.epistemic_status ?? 'confirmed' : 'unreviewed',
    classificationExplicit,
    confirmationStatus: normalizedConfirmationStatus(item.confirmation_status),
    confirmationExplicit,
    confirmationBasis: item.confirmation_basis ?? null,
    reasoningSummary: item.reasoning_summary ?? '',
    profileAspect: item.profile_aspect ?? null,
    preferenceScope: item.preference_scope ?? (item.profile_aspect ? 'global' : null),
    preferenceProjectId: item.preference_project_id ?? null,
    inheritanceMode: item.inheritance_mode ?? 'local_only',
    inheritedProjectIds: item.inherited_project_ids ?? [],
    humanEdited: item.human_edited === true,
    humanChangeStatus: item.human_change_status ?? 'none',
    humanChangeVersion: item.human_change_version ?? 0,
    lastHumanChangedAt: item.last_human_changed_at ?? null,
    lastAgentViewedAt: item.last_agent_viewed_at ?? null,
    lastAgentReviewedAt: item.last_agent_reviewed_at ?? null,
    utilityScore: item.utility_score ?? 0,
    confidenceScore: item.confidence_score ?? 0.5,
    qualifiedUseCount: item.qualified_use_count ?? 0,
    distinctTaskCount: item.distinct_task_count ?? 0,
    lastUsedAt: item.last_used_at ?? null,
    usageGeneration: item.usage_generation ?? 1,
    invalidAt: item.invalid_at,
    replacedByItemId: item.replaced_by_item_id ?? null,
    replacedByItemKind: item.replaced_by_item_kind ?? null,
    createdAt: item.created_at,
    evidence: item.evidence ?? [],
    revisions: item.revisions ?? [],
    assignments: item.assignments ?? [],
    projectReferences: item.project_references ?? [],
    conflicts: item.conflicts ?? [],
    auditEvents: item.audit_events ?? [],
  }
}

function normalizedConfirmationStatus(value?: string): ConfirmationStatus {
  return value === 'confirmed' || value === 'agent_confirmed'
    ? value
    : 'pending'
}

function searchableText(item: KnowledgeItem) {
  return [
    item.id,
    item.title,
    item.body,
    item.type,
    quadrantLabel(item.originQuadrant),
    profileAspectLabel(item.profileAspect),
    item.reasoningSummary,
    item.confirmationBasis?.existence_reason,
    item.confirmationBasis?.quadrant_reason,
    confirmationActorLabel(item.confirmationBasis?.proposed_by),
    confirmationActorLabel(item.confirmationBasis?.confirmed_by),
    humanChangeStatusLabel(item.humanChangeStatus),
    ...item.auditEvents.flatMap((event) => [
      knowledgeAuditActionLabel(event.action),
      event.reason,
      event.tool_name,
      event.conflict_check,
      event.classification_check,
      event.outcome,
    ]),
    ...item.evidence.flatMap((evidence: EvidenceRecord) => [
      evidence.name,
      evidence.summary,
      evidence.source_description,
      evidence.session_id,
      evidence.source_excerpt,
    ]),
  ]
    .filter(Boolean)
    .join(' ')
}

function latestTime(item: KnowledgeItem) {
  const value = latestItemValue(item)
  const time = value ? new Date(value).getTime() : 0
  return Number.isNaN(time) ? 0 : time
}

function preferenceApplies(item: KnowledgeNode | KnowledgeEdge, activeProjectId: string | null) {
  const scope = item.preference_scope ?? 'global'
  return scope === 'global'
    || (scope === 'project' && Boolean(activeProjectId) && item.preference_project_id === activeProjectId)
}

function mergeItems<T extends KnowledgeNode | KnowledgeEdge>(items: T[]): T[] {
  const merged = new Map<string, T>()
  for (const item of items) {
    const existing = merged.get(item.id)
    merged.set(item.id, existing ? mergeItem(existing, item) : item)
  }
  return [...merged.values()]
}

function mergeItem<T extends KnowledgeNode | KnowledgeEdge>(left: T, right: T): T {
  const value = { ...left, ...right } as T
  for (const key of [
    'evidence',
    'revisions',
    'assignments',
    'project_references',
    'conflicts',
    'audit_events',
    'episodes',
  ] as const) {
    const leftItems = left[key] as unknown[] | undefined
    const rightItems = right[key] as unknown[] | undefined
    if (!leftItems && !rightItems) continue
    ;(value as Record<string, unknown>)[key] = uniqueItems([
      ...(leftItems ?? []),
      ...(rightItems ?? []),
    ])
  }
  return value
}

function uniqueItems(items: unknown[]) {
  const seen = new Set<unknown>()
  return items.filter((item) => {
    const value = item as { id?: string }
    const key = typeof item === 'object' && item !== null
      ? value.id ?? JSON.stringify(item)
      : item
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
