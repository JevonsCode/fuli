import { el } from './dom.js';
import { formatTime } from './graph-inspector.js';
import { profileAspectLabel, quadrantLabel } from './knowledge-taxonomy.js';
import { syncSearchableSelects } from './searchable-select.js';

const MANAGEMENT_TYPES = new Set([
  'ProjectSpace', 'PersonalSpace', 'PersonalProject', 'ProjectPurpose',
  'ProjectScope', 'ProjectSource', 'ProjectBoundary', 'ProjectAssessment',
  'AssessmentDimension', 'RelatedPersonalProject'
]);

export function knowledgeItems(graph) {
  if (!graph) return [];
  const names = new Map(graph.nodes.map((node) => [node.id, node.name]));
  const nodes = graph.nodes
    .filter((node) => !MANAGEMENT_TYPES.has(node.type))
    .map((node) => ({
      id: node.id,
      itemKind: 'entity',
      title: node.name,
      body: node.summary || '没有补充说明',
      type: node.type,
      originQuadrant: node.origin_quadrant ?? 'known_known',
      currentQuadrant: node.current_quadrant ?? 'known_known',
      epistemicStatus: node.epistemic_status ?? 'confirmed',
      confirmationStatus: node.confirmation_status ?? 'pending',
      confirmationBasis: node.confirmation_basis ?? null,
      reasoningSummary: node.reasoning_summary ?? '',
      profileAspect: node.profile_aspect ?? null,
      preferenceScope: node.preference_scope ?? (node.profile_aspect ? 'global' : null),
      preferenceProjectId: node.preference_project_id ?? null,
      invalidAt: node.invalid_at,
      createdAt: node.created_at,
      evidence: node.evidence ?? [],
      revisions: node.revisions ?? [],
      assignments: node.assignments ?? [],
      projectReferences: node.project_references ?? [],
      conflicts: node.conflicts ?? [],
      raw: node
    }));
  const edges = graph.edges
    .filter((edge) => !String(edge.id).startsWith('project-profile-edge:'))
    .filter((edge) => !String(edge.id).startsWith('space-edge:'))
    .filter((edge) => !String(edge.id).startsWith('personal-project-relation:'))
    .map((edge) => ({
      id: edge.id,
      itemKind: 'relationship',
      title: `${names.get(endpointId(edge.source)) ?? '未知实体'} → ` +
        `${names.get(endpointId(edge.target)) ?? '未知实体'}`,
      body: edge.fact || '没有关系说明',
      type: `关系 · ${edge.type}`,
      originQuadrant: edge.origin_quadrant ?? 'known_known',
      currentQuadrant: edge.current_quadrant ?? 'known_known',
      epistemicStatus: edge.epistemic_status ?? 'confirmed',
      confirmationStatus: edge.confirmation_status ?? 'pending',
      confirmationBasis: edge.confirmation_basis ?? null,
      reasoningSummary: edge.reasoning_summary ?? '',
      profileAspect: edge.profile_aspect ?? null,
      preferenceScope: edge.preference_scope ?? (edge.profile_aspect ? 'global' : null),
      preferenceProjectId: edge.preference_project_id ?? null,
      invalidAt: edge.invalid_at,
      createdAt: edge.created_at,
      evidence: edge.evidence ?? [],
      revisions: edge.revisions ?? [],
      assignments: edge.assignments ?? [],
      projectReferences: edge.project_references ?? [],
      conflicts: edge.conflicts ?? [],
      raw: edge
    }));
  return [...nodes, ...edges].sort((left, right) =>
    latestTime(right) - latestTime(left)
  );
}

export function configureKnowledgeTypeFilter(select, items) {
  const current = select.value || 'all';
  const types = [...new Set(items.map(({ type }) => type))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN')
  );
  select.replaceChildren(
    option('all', '全部类型'),
    ...types.map((type) => option(type, type))
  );
  select.value = types.includes(current) ? current : 'all';
  syncSearchableSelects(select);
}

export function renderKnowledgeDirectory(container, empty, graph, {
  query = '',
  type = 'all',
  quadrant = 'all',
  profile = 'all',
  status = 'current',
  projectNames = new Map(),
  onSelect
} = {}) {
  const allItems = knowledgeItems(graph);
  const needle = query.trim().toLocaleLowerCase();
  const items = allItems.filter((item) => {
    if (type !== 'all' && item.type !== type) return false;
    if (quadrant !== 'all' && item.originQuadrant !== quadrant) return false;
    if (profile === 'profile' && !item.profileAspect) return false;
    if (profile === 'regular' && item.profileAspect) return false;
    if (status === 'current' && item.invalidAt) return false;
    if (status === 'historical' && !item.invalidAt) return false;
    if (!needle) return true;
    return searchableText(item).toLocaleLowerCase().includes(needle);
  });

  container.replaceChildren(...items.map((item) => {
    const row = el('button', 'knowledge-row');
    row.type = 'button';
    row.dataset.itemId = item.id;
    row.append(
      el('span', 'knowledge-row-content', null, [
        el('strong', '', item.title),
        el('small', '', item.profileAspect
          ? `${profileAspectLabel(item.profileAspect)} · ${item.body}`
          : item.body)
      ]),
      el('span', `knowledge-row-quadrant ${item.originQuadrant}`,
        quadrantLabel(item.originQuadrant)),
      el('span', 'knowledge-row-type', item.type),
      el('span', 'knowledge-row-source', sourceLabel(item, projectNames)),
      el('span', 'knowledge-row-time', formatTime(latestValue(item))),
      el('span', item.invalidAt ? 'knowledge-status historical' : 'knowledge-status current',
        item.invalidAt ? '已失效' : '有效')
    );
    row.addEventListener('click', () => {
      for (const sibling of container.children) sibling.classList.remove('selected');
      row.classList.add('selected');
      onSelect?.(item);
    });
    return row;
  }));
  empty.hidden = items.length > 0;
  if (!items.length) {
    empty.textContent = allItems.length
      ? '当前筛选条件下没有内容'
      : '这个空间还没有结构化知识内容';
  }
  return { visible: items.length, total: allItems.length, items: allItems };
}

function sourceLabel(item, projectNames) {
  if (item.profileAspect) {
    const scope = item.preferenceScope === 'project' && item.preferenceProjectId
      ? `项目 ${projectNames.get(item.preferenceProjectId) ?? item.preferenceProjectId}`
      : '个人全局';
    return `${scope} · ${item.evidence.length ? `${item.evidence.length} 个来源` : '无来源记录'}`;
  }
  const assignment = item.assignments.at(0);
  const evidenceProject = item.evidence.find(({ personal_project_id: id }) => id)
    ?.personal_project_id;
  const projectId = assignment?.project_id ?? evidenceProject;
  const project = projectId ? (projectNames.get(projectId) ?? projectId) : '个人全局';
  const references = item.projectReferences
    .filter(({ status: referenceStatus }) => referenceStatus === 'active')
    .map(({ project_id: referenceProjectId }) =>
      projectNames.get(referenceProjectId) ?? referenceProjectId
    );
  const count = item.evidence.length;
  return [
    `主要 ${project}`,
    references.length ? `引用 ${references.join('、')}` : null,
    count ? `${count} 个来源` : '无来源记录'
  ].filter(Boolean).join(' · ');
}

function searchableText(item) {
  return [
    item.id,
    item.title,
    item.body,
    item.type,
    quadrantLabel(item.originQuadrant),
    profileAspectLabel(item.profileAspect),
    item.reasoningSummary,
    ...item.evidence.flatMap((evidence) => [
      evidence.name,
      evidence.summary,
      evidence.source_description,
      evidence.session_id,
      evidence.source_excerpt
    ])
  ].filter(Boolean).join(' ');
}

function latestTime(item) {
  const value = latestValue(item);
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function latestValue(item) {
  return item.revisions.at(0)?.created_at ?? item.createdAt ??
    item.evidence.at(0)?.created_at ?? item.evidence.at(0)?.reference_time ?? null;
}

function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}
