import { el } from './dom.js';
import {
  discoverPersonalProjectResults,
  personalProjectSearchHref
} from './personal-project-search.js';
import { setViewDescription } from './view-header.js';

export function createKnowledgeWorkspace({
  ui,
  getJson,
  getState,
  getSpace,
  browser,
  onError,
  onRouteChange
}) {
  const contextByProject = new Map();
  let activePickerProjectId = null;
  let searchSequence = 0;

  ui.graphSpace.addEventListener('change', () => {
    searchSequence += 1;
    configureContextPicker();
    load();
  });
  ui.graphSearchForm.addEventListener('submit', search);

  return {
    configureContextPicker,
    load,
    search,
    selectedContextIds,
    setSelectedContextIds
  };

  function configureContextPicker() {
    const space = getSpace();
    const activeProjectId = space?.personalProjectId ?? null;
    activePickerProjectId = activeProjectId;
    const projects = getState()?.personalProjects ?? [];
    const choices = projects.filter(({ project_id: projectId }) =>
      projectId !== activeProjectId
    );
    const selected = contextByProject.get(activeProjectId) ?? new Set();
    for (const id of [...selected]) {
      if (!choices.some(({ project_id: projectId }) => projectId === id)) selected.delete(id);
    }
    if (activeProjectId) contextByProject.set(activeProjectId, selected);
    ui.personalContextPicker.hidden = !activeProjectId || choices.length === 0;
    ui.personalContextList.replaceChildren(...choices.map((project) => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = project.project_id;
      input.checked = selected.has(project.project_id);
      input.addEventListener('change', () => {
        if (input.checked) selected.add(input.value);
        else selected.delete(input.value);
        updateContextCount(selected.size);
        onRouteChange?.();
        load();
      });
      return el('label', 'personal-context-option', null, [
        input,
        el('span', '', null, [
          el('strong', '', project.profile.name),
          el('small', '', '仅加入当前查看和查询')
        ])
      ]);
    }));
    updateContextCount(selected.size);
    if (!activeProjectId) ui.personalContextPicker.open = false;
  }

  async function load({ focusNames = null, focusProjectNodes = false } = {}) {
    const space = getSpace();
    if (!space) return;
    browser.clear('正在读取知识…');
    try {
      const graph = space.personalProjectId
        ? await loadPersonalProjectContext(space)
        : await readGraph(space);
      browser.render(graph, { focusNames, focusProjectNodes });
    } catch (error) {
      browser.clear('知识读取失败');
      onError(error);
    }
  }

  async function loadPersonalProjectContext(space) {
    const state = getState();
    const contextIds = selectedContextIds();
    const [active, personal, ...contextGraphs] = await Promise.all([
      readGraph(space, space.personalProjectId),
      readGraph(space),
      ...contextIds.map((projectId) => readGraph(space, projectId))
    ]);
    const profile = personalProfileGraph(personal, space.personalProjectId);
    const graph = mergeKnowledgeGraphs([active, profile, ...contextGraphs]);
    const contextNames = contextIds.map((projectId) =>
      state.personalProjects.find((project) => project.project_id === projectId)?.profile.name ??
      projectId
    );
    setViewDescription(ui, [
      space.projectName,
      '项目知识与按任务相关性生效的协作偏好',
      contextNames.length ? `借鉴 ${contextNames.join('、')}` : null
    ].filter(Boolean).join(' · '));
    return graph;
  }

  async function readGraph(space, personalProjectId = null) {
    const query = new URLSearchParams({ spaceId: space.id, limit: '360' });
    if (space.providerUrl) query.set('providerUrl', space.providerUrl);
    if (personalProjectId) query.set('personalProjectId', personalProjectId);
    return getJson(`/api/graph?${query}`);
  }

  async function search(event) {
    event?.preventDefault?.();
    const queryText = ui.graphSearch.value.trim();
    if (browser.searchDirectory()) return;
    const state = getState();
    if (!queryText) {
      searchSequence += 1;
      browser.clearGraphSearch();
      onRouteChange?.();
      return;
    }
    if (!state?.activePersonalSpaceId) return;
    const sequence = ++searchSequence;
    const query = new URLSearchParams({
      personalSpaceId: state.activePersonalSpaceId,
      q: queryText,
      limit: '30'
    });
    const selectedSpace = getSpace();
    if (selectedSpace?.personalProjectId) {
      query.set('personalProjectId', selectedSpace.personalProjectId);
      for (const projectId of selectedContextIds()) {
        query.append('contextPersonalProjectId', projectId);
      }
    }
    if (selectedSpace?.providerUrl) query.append('projectId', selectedSpace.id);
    try {
      const result = await getJson(`/api/search?${query}`);
      if (sequence !== searchSequence) return;
      const facts = result.facts ?? [];
      const names = new Set([
        ...(result.entities ?? []).map(({ name }) => name),
        ...facts.flatMap((fact) => [fact.source_entity, fact.target_entity])
      ]);
      const count = browser.focusByNames(
        names,
        `找到 ${result.entities?.length ?? 0} 个实体 · ${facts.length} 条关系`
      );
      onRouteChange?.();
      if (count) return;

      const canDiscoverProjects = isAggregatePersonalSpace(selectedSpace);
      browser.showNoResults({
        query: queryText,
        checking: canDiscoverProjects
      });
      if (!canDiscoverProjects) return;
      const discovery = await discoverPersonalProjectResults({
        getJson,
        personalSpaceId: state.activePersonalSpaceId,
        projects: (state.personalProjects ?? []).filter(({ personal_space_id: spaceId }) =>
          spaceId === state.activePersonalSpaceId
        ),
        query: queryText,
        baseline: result
      });
      if (sequence !== searchSequence) return;
      browser.showNoResults({
        query: queryText,
        ...discovery,
        discoveryAttempted: true,
        matches: discovery.matches.map((match) => ({
          ...match,
          href: personalProjectSearchHref({
            personalSpaceId: state.activePersonalSpaceId,
            projectId: match.project.project_id,
            query: queryText
          })
        }))
      });
      return;
    } catch (error) {
      onError(error);
    }
  }

  function selectedContextIds() {
    if (!activePickerProjectId) return [];
    return [...(contextByProject.get(activePickerProjectId) ?? [])];
  }

  function setSelectedContextIds(projectIds) {
    const activeProjectId = getSpace()?.personalProjectId ?? null;
    if (!activeProjectId) return;
    const available = new Set((getState()?.personalProjects ?? [])
      .map(({ project_id: projectId }) => projectId)
      .filter((projectId) => projectId !== activeProjectId));
    contextByProject.set(
      activeProjectId,
      new Set(projectIds.filter((projectId) => available.has(projectId)))
    );
    activePickerProjectId = activeProjectId;
  }

  function updateContextCount(count) {
    ui.personalContextCount.textContent = count ? `已选 ${count}` : '未选择';
  }
}

function isAggregatePersonalSpace(space) {
  return Boolean(space && !space.providerUrl && !space.personalProjectId);
}

export function personalProfileGraph(graph, activeProjectId = null) {
  const profileEdges = (graph.edges ?? []).filter((edge) =>
    edge.profile_aspect && preferenceApplies(edge, activeProjectId)
  );
  const nodeIds = new Set(
    profileEdges.flatMap((edge) => [endpointId(edge.source), endpointId(edge.target)])
  );
  for (const node of graph.nodes ?? []) {
    if (node.profile_aspect && preferenceApplies(node, activeProjectId)) nodeIds.add(node.id);
  }
  return {
    ...graph,
    nodes: (graph.nodes ?? []).filter((node) => nodeIds.has(node.id)),
    edges: profileEdges.filter((edge) =>
      nodeIds.has(endpointId(edge.source)) && nodeIds.has(endpointId(edge.target))
    )
  };
}

function preferenceApplies(item, activeProjectId) {
  const scope = item.preference_scope ?? 'global';
  return scope === 'global' || (
    scope === 'project' && Boolean(activeProjectId) &&
    item.preference_project_id === activeProjectId
  );
}

export function mergeKnowledgeGraphs(graphs) {
  const available = graphs.filter(Boolean);
  const nodes = mergeItems(available.flatMap((graph) => graph.nodes ?? []));
  const edges = mergeItems(available.flatMap((graph) => graph.edges ?? []));
  return {
    ...(available[0] ?? { space_id: null }),
    nodes,
    edges,
    truncated: available.some(({ truncated }) => truncated)
  };
}

function mergeItems(items) {
  const merged = new Map();
  for (const item of items) {
    const existing = merged.get(item.id);
    merged.set(item.id, existing ? mergeItem(existing, item) : item);
  }
  return [...merged.values()];
}

function mergeItem(left, right) {
  const value = { ...left, ...right };
  for (const key of [
    'evidence', 'revisions', 'assignments', 'project_references', 'conflicts', 'episodes'
  ]) {
    if (left[key] || right[key]) value[key] = uniqueItems([...(left[key] ?? []), ...(right[key] ?? [])]);
  }
  return value;
}

function uniqueItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = typeof item === 'object' && item !== null ? (item.id ?? JSON.stringify(item)) : item;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
}
