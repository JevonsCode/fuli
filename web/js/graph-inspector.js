import { el } from './dom.js';
import {
  CONFIRMATION_STATUS_LABELS,
  profileAspectLabel,
  QUADRANT_DESCRIPTIONS,
  quadrantLabel
} from './knowledge-taxonomy.js';
import {
  copySourceSession,
  sourceAnchorLabel,
  sourceApplicationLabel,
  sourceLinkForEvidence
} from './source-adapters.js';

export function renderNodeInspector(container, node, graph, options = {}) {
  const {
    onEdit,
    onProject,
    onOpenProject,
    onPublishProject,
    preferenceConflicts = [],
    projectNames = new Map()
  } = options;
  const related = graph.edges.filter((edge) =>
    endpointId(edge.source) === node.id || endpointId(edge.target) === node.id
  );
  const nodeNames = new Map(graph.nodes.map((item) => [item.id, item.name]));
  const relationshipList = el('div', 'inspector-relations');
  for (const edge of related.slice(0, 12)) {
    const sourceId = endpointId(edge.source);
    const targetId = endpointId(edge.target);
    const otherId = sourceId === node.id ? targetId : sourceId;
    relationshipList.append(el('div', 'inspector-relation', null, [
      el('span', 'relation-type', edge.type),
      el('span', 'relation-target', nodeNames.get(otherId) ?? otherId)
    ]));
  }
  const children = [
    el('p', 'eyebrow', 'ENTITY'),
    el('h3', '', node.name),
    identityRow('节点 ID', node.id),
    el('p', 'muted', node.summary || '没有摘要'),
    el('dl', 'inspector-meta', null, [
      meta('类型', node.type),
      ...epistemicMeta(node, projectNames),
      meta('关系', String(related.length)),
      meta('图谱空间', graphGroupLabel(node.group_id))
    ])
  ];
  appendAttributes(children, node.attributes);
  appendReasoning(children, node);
  appendNodeActions(children, node, {
    onEdit, onProject, onOpenProject, onPublishProject
  });
  if (related.length) children.push(el('h4', 'inspector-subtitle', '关联关系'), relationshipList);
  appendEvidence(children, node.evidence);
  appendSuspectedConflicts(children, node.id, preferenceConflicts, projectNames);
  appendAssignments(children, node.assignments);
  appendProjectReferences(children, node.project_references);
  appendConflicts(children, node.conflicts);
  appendRevisions(children, node.revisions);
  container.replaceChildren(...children);
}

export function renderEdgeInspector(container, edge, graph, options = {}) {
  const { onEdit, preferenceConflicts = [], projectNames = new Map() } = options;
  const nodeNames = new Map(graph.nodes.map((node) => [node.id, node.name]));
  const sourceId = endpointId(edge.source);
  const targetId = endpointId(edge.target);
  const children = [
    el('p', 'eyebrow', 'RELATIONSHIP'),
    el('h3', '', edge.type),
    identityRow('关系 ID', edge.id),
    el('p', 'muted', edge.fact || '没有关系说明'),
    el('dl', 'inspector-meta', null, [
      meta('来源', nodeNames.get(sourceId) ?? sourceId),
      meta('目标', nodeNames.get(targetId) ?? targetId),
      ...epistemicMeta(edge, projectNames),
      meta('生效时间', formatTime(edge.valid_at)),
      meta('状态', edge.invalid_at ? `历史 · ${formatTime(edge.invalid_at)}` : '当前有效'),
      meta('来源记录', String(edge.episodes?.length ?? 0))
    ])
  ];
  appendAttributes(children, edge.attributes);
  appendReasoning(children, edge);
  appendEditAction(children, edge, onEdit);
  appendEvidence(children, edge.evidence);
  appendSuspectedConflicts(children, edge.id, preferenceConflicts, projectNames);
  appendAssignments(children, edge.assignments);
  appendProjectReferences(children, edge.project_references);
  appendConflicts(children, edge.conflicts);
  appendRevisions(children, edge.revisions);
  container.replaceChildren(...children);
}

export function resetGraphInspector(container) {
  container.replaceChildren(
    el('p', 'eyebrow', '内容详情'),
    el('h3', '', '选择一个节点或关系'),
    el('p', 'muted', '点击后查看完整说明、登记资料、来源证据和关联关系。')
  );
}

export function localGraphMatches(graph, queryText) {
  const names = new Set();
  if (!graph) return names;
  const needle = queryText.toLocaleLowerCase();
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    const value = `${node.id} ${node.name} ${node.summary} ${JSON.stringify(node.attributes ?? {})}`
      .toLocaleLowerCase();
    if (value.includes(needle)) names.add(node.name);
  }
  for (const edge of graph.edges) {
    if (`${edge.id} ${edge.type} ${edge.fact}`.toLocaleLowerCase().includes(needle)) {
      const source = nodesById.get(endpointId(edge.source));
      const target = nodesById.get(endpointId(edge.target));
      if (source) names.add(source.name);
      if (target) names.add(target.name);
    }
  }
  return names;
}

export function formatTime(value) {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function appendAttributes(children, attributes = {}) {
  const entries = Object.entries(attributes).filter(([, value]) =>
    value !== null && value !== undefined && value !== ''
  );
  if (!entries.length) return;
  children.push(el('h4', 'inspector-subtitle', '内容详情'));
  children.push(el('dl', 'inspector-meta inspector-attributes', null,
    entries.map(([key, value]) => meta(attributeLabel(key), displayAttributeValue(value)))
  ));
}

function identityRow(label, value) {
  const identity = String(value ?? '未记录');
  const copy = el('button', 'inspector-identity-copy', '复制');
  copy.type = 'button';
  copy.setAttribute('aria-label', `复制${label}`);
  copy.addEventListener('click', async () => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) {
      copy.textContent = '不可复制';
      return;
    }
    try {
      await clipboard.writeText(identity);
      copy.textContent = '已复制';
      globalThis.setTimeout?.(() => { copy.textContent = '复制'; }, 1400);
    } catch {
      copy.textContent = '复制失败';
    }
  });
  const row = el('div', 'inspector-identity');
  row.append(
    el('span', '', label),
    el('code', '', identity),
    copy
  );
  return row;
}

function appendReasoning(children, item) {
  if (!item.reasoning_summary) return;
  children.push(el('h4', 'inspector-subtitle', '形成过程'));
  children.push(el('p', 'inspector-reasoning', item.reasoning_summary));
}

function epistemicMeta(item, projectNames) {
  const origin = item.origin_quadrant ?? 'known_known';
  const basis = item.confirmation_basis;
  const values = [
    meta('发现时象限', quadrantLabel(origin)),
    meta('象限含义', QUADRANT_DESCRIPTIONS[origin] ?? origin),
    meta(
      '确认状态',
      CONFIRMATION_STATUS_LABELS[item.confirmation_status] ?? '待确认'
    ),
  ];
  if (basis) {
    values.push(meta('为什么会有', basis.existence_reason));
    values.push(meta('为什么归入该象限', basis.quadrant_reason));
    values.push(meta('提出者', confirmationActorLabel(basis.proposed_by)));
    values.push(meta('确认者', confirmationActorLabel(basis.confirmed_by)));
    values.push(meta('确认时间', formatTime(basis.confirmed_at)));
  }
  if (item.profile_aspect) {
    values.push(meta('协作偏好', profileAspectLabel(item.profile_aspect)));
    values.push(meta('生效范围', preferenceScopeLabel(item, projectNames)));
  }
  return values;
}

function confirmationActorLabel(actor) {
  if (!actor) return '尚未记录';
  return actor.label ?? {
    user: '用户',
    agent: 'Agent',
    authoritative_source: '权威来源',
    import: '导入记录'
  }[actor.kind] ?? actor.kind;
}

function appendEvidence(children, evidence = []) {
  if (!evidence.length) return;
  children.push(el('h4', 'inspector-subtitle', '证据与来源'));
  const list = el('div', 'inspector-evidence');
  for (const item of evidence) {
    const card = el('article', 'evidence-card', null, [
      el('strong', '', item.name),
      el('p', '', item.summary || item.source_description),
      el('span', '', [
        sourceApplicationLabel(item),
        displayAttributeValue(item.source_kind),
        item.personal_project_id ? `项目 ${item.personal_project_id}` : '个人全局',
        item.session_id ? `会话 ${shortId(item.session_id)}` : null,
        item.source_turn_id ? `片段 ${shortId(item.source_turn_id)}` : null,
        formatTime(item.reference_time)
      ].filter(Boolean).join(' · '))
    ]);
    if (item.source_excerpt) {
      card.append(el('p', 'evidence-excerpt', item.source_excerpt));
    }
    const sourceAction = evidenceAction(item);
    if (sourceAction) card.append(sourceAction);
    list.append(card);
  }
  children.push(list);
}

function evidenceAction(item) {
  if (!item.session_id) return null;
  const href = sourceLinkForEvidence(item);
  if (href) {
    const anchor = el('a', 'evidence-source-action', sourceAnchorLabel(item));
    anchor.href = href;
    return anchor;
  }
  const button = el('button', 'evidence-source-action', sourceAnchorLabel(item));
  button.type = 'button';
  button.addEventListener('click', async () => {
    const copied = await copySourceSession(item).catch(() => false);
    button.textContent = copied ? '会话 ID 已复制' : '无法复制会话 ID';
  });
  return button;
}

function appendSuspectedConflicts(children, itemId, conflicts, projectNames) {
  const related = conflicts.filter(({ left, right }) => left.id === itemId || right.id === itemId);
  if (!related.length) return;
  children.push(el('h4', 'inspector-subtitle conflict-title', '疑似冲突'));
  const list = el('div', 'inspector-history suspected-conflicts');
  for (const conflict of related) {
    const other = conflict.left.id === itemId ? conflict.right : conflict.left;
    list.append(el('article', 'history-row', null, [
      el('strong', '', other.title),
      el('p', '', conflict.reason),
      el('span', '', `${preferenceScopeLabel(other.raw, projectNames)} · ${other.body}`)
    ]));
  }
  children.push(list);
}

function preferenceScopeLabel(item, projectNames = new Map()) {
  if (item.preference_scope === 'project' && item.preference_project_id) {
    return `仅 ${projectNames.get(item.preference_project_id) ?? item.preference_project_id}`;
  }
  return '个人全局';
}

function appendEditAction(children, item, onEdit) {
  if (!onEdit || isManagementItem(item)) return;
  const button = el('button', 'inspector-edit-button primary-action', editActionLabel(item));
  button.type = 'button';
  button.addEventListener('click', () => onEdit(item));
  children.push(button);
}

function appendNodeActions(children, item, {
  onEdit, onProject, onOpenProject, onPublishProject
}) {
  const actions = el('div', 'inspector-actions');
  if (isProjectItem(item) && onOpenProject) {
    const open = el('button', 'primary-action', '进入这个项目');
    open.type = 'button';
    open.addEventListener('click', () => onOpenProject(item));
    actions.append(open);
  }
  if (isProjectItem(item) && onPublishProject) {
    const publish = el('button', 'secondary-action', '发布 / 同步到公共');
    publish.type = 'button';
    publish.addEventListener('click', () => onPublishProject(item));
    actions.append(publish);
  }
  if (isManagementItem(item)) {
    if (actions.children.length) children.push(actions);
    return;
  }
  if (onProject && !item.invalid_at && !item.profile_aspect) {
    const project = el('button', 'primary-action', '基于此创建项目');
    project.type = 'button';
    project.addEventListener('click', () => onProject(item));
    actions.append(project);
  }
  if (onEdit) {
    const edit = el('button', 'secondary-action', editActionLabel(item));
    edit.type = 'button';
    edit.addEventListener('click', () => onEdit(item));
    actions.append(edit);
  }
  if (actions.children.length) children.push(actions);
}

function editActionLabel(item) {
  return item.profile_aspect ? '纠正这条偏好' : '纠正或调整归属';
}

function appendAssignments(children, assignments = []) {
  if (!assignments.length) return;
  children.push(el('h4', 'inspector-subtitle', '主要归属记录'));
  const list = el('div', 'inspector-history');
  for (const assignment of assignments) {
    list.append(el('article', 'history-row', null, [
      el('strong', '', assignment.project_id),
      el('p', '', assignment.reason),
      el('span', '', `${assignment.previous_project_id ?? '未归类'} → ` +
        `${assignment.project_id} · ${formatTime(assignment.updated_at)}`)
    ]));
  }
  children.push(list);
}

function appendProjectReferences(children, references = []) {
  if (!references.length) return;
  const statusLabels = {
    active: '正在使用', pending_conflict: '冲突待处理',
    rejected: '保留目标内容', duplicate: '复用已有内容'
  };
  children.push(el('h4', 'inspector-subtitle', '项目引用'));
  const list = el('div', 'inspector-history');
  for (const reference of references) {
    list.append(el('article', 'history-row', null, [
      el('strong', '', reference.project_id),
      el('p', '', `${statusLabels[reference.status] ?? reference.status} · ${reference.reason}`),
      el('span', '', `主要归属 ${reference.source_project_id ?? '个人全局'} · ` +
        formatTime(reference.updated_at))
    ]));
  }
  children.push(list);
}

function appendConflicts(children, conflicts = []) {
  if (!conflicts.length) return;
  const resolutionLabels = {
    defer: '暂不生效', keep_target: '保留目标内容',
    use_source: '采用来源内容', coexist: '两者并存'
  };
  children.push(el('h4', 'inspector-subtitle', '知识冲突'));
  const list = el('div', 'inspector-history inspector-conflicts');
  for (const conflict of conflicts) {
    list.append(el('article', 'history-row', null, [
      el('strong', '', conflict.status === 'pending' ? '待处理' : '已处理'),
      el('p', '', `${resolutionLabels[conflict.resolution] ?? conflict.resolution} · ` +
        conflict.reason),
      el('span', '', `目标项目 ${conflict.target_project_id} · ` +
        formatTime(conflict.updated_at))
    ]));
  }
  children.push(list);
}

function appendRevisions(children, revisions = []) {
  if (!revisions.length) return;
  const labels = {
    update: '内容纠正', invalidate: '标记失效', restore: '恢复有效',
    scope_change: '调整生效范围', batch_confirm: '批量确认'
  };
  children.push(el('h4', 'inspector-subtitle', '修订历史'));
  const list = el('div', 'inspector-history');
  for (const revision of revisions) {
    list.append(el('article', 'history-row', null, [
      el('strong', '', labels[revision.action] ?? revision.action),
      el('p', '', revision.reason),
      el('span', '', formatTime(revision.created_at))
    ]));
  }
  children.push(list);
}

function attributeLabel(key) {
  return ({
    projectId: '项目 ID', lifecycle: '阶段', publicationKey: '发布标识',
    projectDefinition: '项目定义',
    kind: '资料类型', uri: '位置', sensitivity: '敏感度', score: '分数',
    label: '评估', analyzedAt: '分析时间', state: '状态', evidence: '已确认证据',
    confirmed: '已记录', inferred: '根据现有信息推断'
  })[key] ?? key;
}

function displayAttributeValue(value) {
  const labels = {
    active: '维护中', planned: '规划中', maintenance: '维护期', archived: '已归档',
    prd: 'PRD', product_document: '产品文档', technical_document: '技术文档',
    frontend_repository: '前端仓库', backend_repository: '后端仓库',
    repository: '代码仓库', normal: '普通', private: '私有', restricted: '受限',
    confirmed: '已确认', inferred: '推断',
    needs_clarification: '需要补充', partially_documented: '部分完备',
    well_documented: '资料完备'
  };
  if (Array.isArray(value)) return value.join('；') || '无';
  return labels[value] ?? String(value);
}

function graphGroupLabel(groupId) {
  if (String(groupId).includes('-personal-')) return '本机个人图谱';
  if (String(groupId).includes('-project-')) return '公共项目图谱';
  return 'Graphiti 图谱';
}

function isManagementItem(item) {
  return new Set([
    'ProjectSpace', 'PersonalSpace', 'PersonalProject', 'ProjectPurpose',
    'ProjectScope', 'ProjectSource', 'ProjectBoundary', 'ProjectAssessment',
    'AssessmentDimension', 'RelatedPersonalProject'
  ]).has(item.type) || String(item.id).startsWith('project-profile-edge:') ||
    String(item.id).startsWith('space-edge:') ||
    String(item.id).startsWith('personal-project-relation:');
}

function isProjectItem(item) {
  return item.type === 'PersonalProject' || item.type === 'RelatedPersonalProject';
}

function shortId(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
}

function meta(term, value) {
  const row = el('div');
  row.append(el('dt', '', term), el('dd', '', value));
  return row;
}
