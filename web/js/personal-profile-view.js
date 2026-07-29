import { el } from './dom.js';
import { formatTime, renderEdgeInspector, renderNodeInspector } from './graph-inspector.js';
import { knowledgeItems } from './knowledge-directory.js';
import { profileAspectLabel, quadrantLabel } from './knowledge-taxonomy.js';
import { conflictsForItem, detectPreferenceConflicts } from './preference-conflicts.js';

const STATUS_LABELS = {
  confirmed: '已确认',
  pending: '待确认'
};

export function createPersonalProfileView({ ui, getJson, getState, editor, onError }) {
  let graph = null;
  let activeAspect = 'all';
  let selectedItemId = null;
  let conflictsOnly = false;

  for (const button of ui.personalProfileFilters) {
    button.addEventListener('click', () => {
      activeAspect = button.dataset.profileAspect;
      render();
    });
  }
  ui.personalProfileConflicts.addEventListener('click', () => {
    conflictsOnly = !conflictsOnly;
    ui.personalProfileConflicts.setAttribute('aria-pressed', String(conflictsOnly));
    render();
  });

  return { load, render };

  async function load() {
    const state = getState();
    if (!state?.activePersonalSpaceId) return;
    ui.personalProfileEmpty.hidden = false;
    ui.personalProfileEmpty.textContent = '正在读取协作偏好…';
    try {
      const query = new URLSearchParams({
        spaceId: state.activePersonalSpaceId,
        limit: '500'
      });
      graph = await getJson(`/api/graph?${query}`);
      render();
    } catch (error) {
      ui.personalProfileList.replaceChildren();
      ui.personalProfileEmpty.hidden = false;
      ui.personalProfileEmpty.textContent = '协作偏好读取失败';
      onError(error);
    }
  }

  function render() {
    const items = profileKnowledgeItems(graph);
    const conflicts = detectPreferenceConflicts(items);
    const conflictingIds = new Set(conflicts.flatMap(({ left, right }) => [left.id, right.id]));
    let visible = activeAspect === 'all'
      ? items
      : items.filter(({ profileAspect }) => profileAspect === activeAspect);
    if (conflictsOnly) visible = visible.filter(({ id }) => conflictingIds.has(id));
    for (const button of ui.personalProfileFilters) {
      const selected = button.dataset.profileAspect === activeAspect;
      button.setAttribute('aria-pressed', String(selected));
    }
    ui.personalProfileConfirmed.textContent = items.filter(
      ({ confirmationStatus }) => confirmationStatus === 'confirmed'
    ).length;
    ui.personalProfileObserved.textContent = items.filter(
      ({ confirmationStatus }) => confirmationStatus !== 'confirmed'
    ).length;
    ui.personalProfileConflicts.querySelector('strong').textContent = conflicts.length;
    ui.personalProfileCount.textContent = visible.length === items.length
      ? `${items.length} 条个人理解`
      : `显示 ${visible.length} / ${items.length}`;
    ui.personalProfileList.replaceChildren(...visible.map((item) =>
      profileRow(item, conflictsForItem(conflicts, item.id))
    ));
    const selected = visible.find(({ id }) => id === selectedItemId);
    if (selected) showInspector(selected, conflicts);
    else {
      selectedItemId = null;
      resetInspector();
    }
    ui.personalProfileEmpty.hidden = visible.length > 0;
    if (!visible.length) {
      ui.personalProfileEmpty.textContent = conflictsOnly
        ? '当前没有检测到生效范围重叠的疑似冲突'
        : items.length
          ? '这个维度还没有内容'
          : '会话中出现稳定偏好与判断后，会在这里形成可纠正的协作偏好。';
    }
  }

  function profileRow(item, itemConflicts) {
    const row = el('button', 'personal-profile-row');
    row.type = 'button';
    if (item.id === selectedItemId) row.classList.add('selected');
    row.append(
      el('span', `profile-aspect-mark ${item.profileAspect}`, profileAspectLabel(item.profileAspect)),
      el('span', 'personal-profile-copy', null, [
        el('strong', '', item.title),
        el('small', '', item.body)
      ]),
      el('span', 'personal-profile-origin', null, [
        el('strong', itemConflicts.length ? 'has-conflict' : '', itemConflicts.length
          ? `${STATUS_LABELS[item.confirmationStatus] ?? '待确认'} · 疑似冲突`
          : STATUS_LABELS[item.confirmationStatus] ?? '待确认'),
        el('small', '', [
          quadrantLabel(item.originQuadrant),
          scopeLabel(item, getState().personalProjects ?? []),
          sourceSummary(item)
        ].join(' · '))
      ]),
      el('time', '', formatTime(latestValue(item)))
    );
    row.addEventListener('click', () => {
      for (const sibling of ui.personalProfileList.children) sibling.classList.remove('selected');
      row.classList.add('selected');
      selectedItemId = item.id;
      showInspector(item, detectPreferenceConflicts(profileKnowledgeItems(graph)));
    });
    return row;
  }

  function showInspector(item, conflicts) {
    const projectNames = new Map((getState().personalProjects ?? []).map((project) =>
      [project.project_id, project.profile.name]
    ));
    const actions = {
      preferenceConflicts: conflicts,
      projectNames,
      onEdit: () => editor.open(item, {
        personalSpaceId: getState().activePersonalSpaceId,
        personalProjectId: null,
        projects: getState().personalProjects ?? []
      })
    };
    if (item.itemKind === 'entity') {
      renderNodeInspector(ui.personalProfileInspector, item.raw, graph, actions);
    } else {
      renderEdgeInspector(ui.personalProfileInspector, item.raw, graph, actions);
    }
  }

  function resetInspector() {
    ui.personalProfileInspector.replaceChildren(
      el('p', 'eyebrow', 'PERSONAL LENS'),
      el('h3', '', '选择一条偏好或判断'),
      el('p', 'muted', '查看来源会话、生效范围、确认状态和可能冲突。')
    );
  }
}

function scopeLabel(item, projects = []) {
  const projectName = projects.find(({ project_id: id }) => id === item.preferenceProjectId)
    ?.profile?.name;
  return item.preferenceScope === 'project' && item.preferenceProjectId
    ? `仅 ${projectName ?? item.preferenceProjectId}`
    : '个人全局';
}

export function profileKnowledgeItems(graph) {
  const items = knowledgeItems(graph).filter(({ profileAspect }) => profileAspect);
  const relatedEntityIds = new Set(items
    .filter(({ itemKind }) => itemKind === 'relationship')
    .flatMap(({ raw }) => [endpointId(raw.source), endpointId(raw.target)]));
  return items.filter(({ id, itemKind }) =>
    itemKind === 'relationship' || !relatedEntityIds.has(id)
  );
}

function sourceSummary(item) {
  const count = item.evidence.length;
  return count ? `${count} 个来源` : '暂无来源记录';
}

function latestValue(item) {
  return item.revisions.at(0)?.created_at ?? item.createdAt ??
    item.evidence.at(0)?.created_at ?? item.evidence.at(0)?.reference_time ?? null;
}

function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
}
