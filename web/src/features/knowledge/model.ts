import { currentLocale, t } from '@/i18n'
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

export type KnowledgeReviewState = 'confirmed' | 'agent_confirmed' | 'pending'

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
  'ExternalKnowledgeSource',
])

const PROJECT_MATERIAL_TYPES = new Set([
  'ProjectSpace',
  'PersonalSpace',
  'PersonalProject',
  'ProjectPurpose',
  'ProjectScope',
  'TechnicalSummary',
  'ProjectSource',
  'ProjectBoundary',
  'ProjectAssessment',
  'AssessmentDimension',
  'RelatedPersonalProject',
  'ExternalKnowledgeSource',
])

const QUADRANTS = new Set([
  'known_known',
  'known_unknown',
  'unknown_known',
  'unknown_unknown',
  'unclassified',
])

const PROFILE_ASPECTS = new Set(['taste', 'personality', 'judgment_preference'])
const REVISION_ACTIONS = new Set([
  'confirm',
  'update',
  'invalidate',
  'link_replacement',
  'restore',
  'scope_change',
  'batch_confirm',
])
const KNOWLEDGE_AUDIT_ACTIONS = new Set([
  'human_change',
  'agent_view',
  'agent_review',
  'knowledge_used',
])
const CONFIRMATION_ACTORS = new Set([
  'user',
  'agent',
  'authoritative_source',
  'import',
])

export function quadrantLabel(value?: string | null) {
  const normalized = value ?? 'unclassified'
  return QUADRANTS.has(normalized)
    ? t(`knowledge.domain.quadrants.${normalized}`)
    : normalized
}

export function quadrantDescription(value?: string | null) {
  const normalized = value ?? 'unclassified'
  return QUADRANTS.has(normalized)
    ? t(`knowledge.domain.quadrants.descriptions.${normalized}`)
    : t('knowledge.domain.quadrants.customDescription')
}

export function profileAspectLabel(value?: string | null) {
  const normalized = value ?? ''
  return PROFILE_ASPECTS.has(normalized)
    ? t(`knowledge.domain.profiles.${normalized}`)
    : normalized
}

export function revisionActionLabel(value?: string | null) {
  const normalized = value ?? ''
  if (REVISION_ACTIONS.has(normalized)) {
    return t(`knowledge.domain.revisions.${normalized}`)
  }
  return normalized || t('knowledge.domain.revisions.fallback')
}

export function humanChangeStatusLabel(value?: HumanChangeStatus | null) {
  return t(`knowledge.domain.humanChanges.${value ?? 'none'}`)
}

export function knowledgeAuditActionLabel(value?: string | null) {
  const normalized = value ?? ''
  if (KNOWLEDGE_AUDIT_ACTIONS.has(normalized)) {
    return t(`knowledge.domain.auditActions.${normalized}`)
  }
  return normalized || t('knowledge.domain.auditActions.fallback')
}

export function confirmationActorLabel(actor?: ConfirmationActor | null) {
  if (!actor) return t('knowledge.domain.actors.notRecorded')
  return actor.label || (
    CONFIRMATION_ACTORS.has(actor.kind)
      ? t(`knowledge.domain.actors.${actor.kind}`)
      : actor.kind
  )
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
    body: node.summary || t('common.status.noDescription'),
    type: node.type,
    ...commonItem(node),
    raw: node,
  }
}

export function knowledgeItemFromEdge(
  edge: KnowledgeEdge,
  names: Map<string, string>,
): KnowledgeItem {
  const sourceName = names.get(endpointId(edge.source)) ?? edge.source_name
  const targetName = names.get(endpointId(edge.target)) ?? edge.target_name
  return {
    id: edge.id,
    itemKind: 'relationship',
    title: `${sourceName ?? t('knowledge.domain.items.unknownEntity')} → ${
      targetName ?? t('knowledge.domain.items.unknownEntity')
    }`,
    body: edge.fact || t('knowledge.domain.items.noRelationDescription'),
    type: t('knowledge.domain.items.relationshipType', { type: edge.type }),
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
  if (item.itemKind === 'relationship') {
    return t('knowledge.domain.materialTypes.relationship')
  }
  return PROJECT_MATERIAL_TYPES.has(item.type)
    ? t(`knowledge.domain.materialTypes.${item.type}`)
    : item.type
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
    || String(id).startsWith('external-knowledge-binding:')
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

export function appendKnowledgeGraphPage(
  current: KnowledgeGraph | null,
  page: KnowledgeGraph,
): KnowledgeGraph {
  const merged = mergeKnowledgeGraphs([current, page])
  return {
    ...merged,
    space_id: page.space_id ?? merged.space_id,
    truncated: page.truncated,
    next_offset: page.next_offset ?? null,
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
  if (!value) return t('knowledge.domain.items.notRecorded')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(currentLocale())
}

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
  return t(`knowledge.domain.reviewStates.${knowledgeReviewState(item)}`)
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
          description: evidence.source_description
            || evidence.summary
            || t('knowledge.domain.confirmation.sameSource'),
        }, item)
      }
      if (evidence.session_id) {
        addConfirmationGroup(groups, {
          kind: 'session',
          value: evidence.session_id,
          label: sessionLabel(evidence),
          description: evidence.source_description
            || evidence.summary
            || t('knowledge.domain.confirmation.sameSession'),
        }, item)
      }
    }
  }
  return [...groups.values()]
    .filter(({ items: groupedItems }) => groupedItems.length >= 2)
    .sort(
      (left, right) =>
        right.items.length - left.items.length
        || left.label.localeCompare(right.label, currentLocale()),
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
      || t('knowledge.domain.confirmation.sourceSupports', { label: group.label }),
    quadrantReason: existing?.quadrant_reason
      || item.reasoningSummary
      || t('knowledge.domain.confirmation.quadrantReason', {
        quadrant: quadrantLabel(item.originQuadrant),
        description: quadrantDescription(item.originQuadrant),
      }),
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
    || t('knowledge.domain.confirmation.sourceRecord')
}

function sessionLabel(evidence: EvidenceRecord) {
  const application = {
    codex: 'Codex',
    claude: 'Claude',
    claude_code: 'Claude Code',
    cursor: 'Cursor',
    kiro: 'Kiro',
    other: t('knowledge.domain.confirmation.otherSource'),
  }[evidence.source_application ?? '']
  return application
    ? `${application} · ${evidence.name || evidence.source_kind || t('knowledge.domain.confirmation.session')}`
    : evidence.name || evidence.source_kind || t('knowledge.domain.confirmation.sourceSession')
}

function proposedByFromEvidence(evidence?: EvidenceRecord) {
  const application = {
    codex: 'Codex',
    claude: 'Claude',
    claude_code: 'Claude Code',
    cursor: 'Cursor',
    kiro: 'Kiro',
    other: t('knowledge.domain.actors.otherAgent'),
  }[evidence?.source_application ?? '']
  return application
    ? { kind: 'agent', label: application }
    : { kind: 'import', label: t('knowledge.domain.actors.historicalRecord') }
}

export function classificationExplanation(item: KnowledgeItem) {
  if (!item.classificationExplicit) {
    return t('knowledge.domain.confirmation.legacyUnclassified')
  }
  const basis = item.confirmationBasis
  if (knowledgeReviewState(item) === 'confirmed' && basis) {
    return t('knowledge.domain.confirmation.confirmed', {
      actor: confirmationActorLabel(basis.confirmed_by),
      time: formatTime(basis.confirmed_at),
    })
  }
  if (knowledgeReviewState(item) === 'agent_confirmed' && basis) {
    return t('knowledge.domain.confirmation.agentConfirmed', {
      time: formatTime(basis.confirmed_at),
    })
  }
  if (basis) {
    return t('knowledge.domain.confirmation.pending', {
      actor: confirmationActorLabel(basis.proposed_by),
    })
  }
  return t('knowledge.domain.confirmation.legacyPending')
}

export function confirmationBasisSummary(item: KnowledgeItem) {
  const basis = item.confirmationBasis
  if (!basis) return t('knowledge.domain.confirmation.legacyBasisMissing')
  if (knowledgeReviewState(item) === 'confirmed') {
    return `${confirmationActorLabel(basis.confirmed_by)} · ${formatTime(basis.confirmed_at)}`
  }
  if (knowledgeReviewState(item) === 'agent_confirmed') {
    return t('knowledge.domain.confirmation.agentPolicy', {
      time: formatTime(basis.confirmed_at),
    })
  }
  return t('knowledge.domain.confirmation.proposed', {
    actor: confirmationActorLabel(basis.proposed_by),
    reason: basis.existence_reason,
  })
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
