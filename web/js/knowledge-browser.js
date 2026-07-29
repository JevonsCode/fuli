import { renderKnowledgeGraph } from './graph-view.js';
import {
  localGraphMatches,
  renderEdgeInspector,
  renderNodeInspector,
  resetGraphInspector
} from './graph-inspector.js';
import {
  configureKnowledgeTypeFilter,
  knowledgeItems,
  renderKnowledgeDirectory
} from './knowledge-directory.js';
import { currentKnowledgeGraph } from './knowledge-graph-projection.js';
import {
  clearGraphSearchStatus,
  renderGraphSearchStatus
} from './personal-project-search.js';

export function createKnowledgeBrowser({
  ui,
  getState,
  getSpace,
  editor,
  projectDialog,
  onOpenPersonalProject,
  onPublishPersonalProject,
  onRouteChange
}) {
  let mode = 'directory';
  let graph = null;
  let graphView = null;
  let graphController = null;

  ui.knowledgeDirectoryMode.addEventListener('click', () => changeMode('directory'));
  ui.knowledgeGraphMode.addEventListener('click', () => changeMode('graph'));
  for (const filter of [
    ui.knowledgeTypeFilter,
    ui.knowledgeQuadrantFilter,
    ui.knowledgeProfileFilter,
    ui.knowledgeStatusFilter
  ]) {
    filter.addEventListener('change', () => {
      renderDirectory();
      onRouteChange?.();
    });
  }

  return {
    render,
    clear,
    setMode,
    mode: () => mode,
    setDirectoryState,
    isDirectory: () => mode === 'directory',
    searchDirectory,
    openItem,
    localMatches: (query) => localGraphMatches(graphView, query),
    focusByNames: (names, message) => {
      const count = graphController?.focusByNames(names, { searchMatch: true }) ?? 0;
      ui.graphCount.textContent = count
        ? `${message} · 图中高亮 ${count} 个节点`
        : `${message} · 当前图中没有可定位节点`;
      ui.graphCount.classList.add('search-active');
      ui.graphSearchLegend.hidden = count === 0;
      ui.graphSearchLegendText.textContent = `搜索命中 · ${count} 个节点`;
      if (count) clearGraphSearchStatus(ui.graphSearchStatus);
      return count;
    },
    showNoResults: (status) => {
      ui.graphCount.textContent = '当前范围未检索到匹配结果';
      ui.graphCount.classList.add('search-active');
      ui.graphSearchLegend.hidden = true;
      renderGraphSearchStatus(ui.graphSearchStatus, status);
    },
    clearGraphSearch,
    zoomOut: () => graphController?.zoomOut(),
    zoomIn: () => graphController?.zoomIn(),
    fit: () => graphController?.fit(),
    reset: () => graphController?.reset()
  };

  function render(nextGraph, { focusNames = null, focusProjectNodes = false } = {}) {
    graph = nextGraph;
    graphView = currentKnowledgeGraph(nextGraph);
    clearSearchStatus();
    configureKnowledgeTypeFilter(ui.knowledgeTypeFilter, knowledgeItems(graph));
    renderDirectory();
    ui.graphEmpty.hidden = graphView.nodes.length > 0;
    if (!graphView.nodes.length) ui.graphEmpty.textContent = '这个空间还没有当前有效知识';
    graphController?.destroy();
    graphController = renderKnowledgeGraph(ui.graphSvg, graphView, {
      onNodeSelect: (node) => renderNodeInspector(
        ui.graphInspector, node, graphView, inspectorActions(node, 'entity')
      ),
      onEdgeSelect: (edge) => renderEdgeInspector(
        ui.graphInspector, edge, graphView, inspectorActions(edge, 'relationship')
      )
    });
    setMode(mode, { fit: !focusNames?.size });
    if (focusNames?.size) {
      requestAnimationFrame(() => graphController?.focusByNames(
        focusNames,
        { projectOnly: focusProjectNodes }
      ));
    }
  }

  function clear(message) {
    graphController?.destroy();
    graphController = null;
    graph = null;
    graphView = null;
    clearSearchStatus();
    ui.graphEmpty.hidden = false;
    ui.graphEmpty.textContent = message;
    ui.knowledgeDirectoryEmpty.hidden = false;
    ui.knowledgeDirectoryEmpty.textContent = message;
    ui.knowledgeDirectoryList.replaceChildren();
    ui.graphSvg.replaceChildren();
    resetGraphInspector(ui.graphInspector);
  }

  function searchDirectory() {
    if (mode !== 'directory') return false;
    renderDirectory();
    onRouteChange?.();
    return true;
  }

  function setDirectoryState({
    query = '',
    type = 'all',
    quadrant = 'all',
    profile = 'all',
    status = 'current'
  } = {}) {
    ui.graphSearch.value = query;
    setAvailableValue(ui.knowledgeTypeFilter, type, 'all');
    setAvailableValue(ui.knowledgeQuadrantFilter, quadrant, 'all');
    setAvailableValue(ui.knowledgeProfileFilter, profile, 'all');
    setAvailableValue(ui.knowledgeStatusFilter, status, 'current');
    renderDirectory();
  }

  function openItem({ itemKind, itemId }) {
    if (!graph) return false;
    const item = knowledgeItems(graph).find((candidate) =>
      candidate.itemKind === itemKind && candidate.id === itemId
    );
    if (!item) return false;
    ui.graphSearch.value = '';
    ui.knowledgeTypeFilter.value = 'all';
    ui.knowledgeQuadrantFilter.value = 'all';
    ui.knowledgeProfileFilter.value = 'all';
    ui.knowledgeStatusFilter.value = item.invalidAt ? 'historical' : 'current';
    setMode('directory');
    const row = [...ui.knowledgeDirectoryList.children]
      .find(({ dataset }) => dataset.itemId === itemId);
    row?.classList.add('selected');
    row?.scrollIntoView?.({ block: 'center' });
    showDirectoryItem(item);
    return true;
  }

  function renderDirectory() {
    if (!graph) return;
    const result = renderKnowledgeDirectory(
      ui.knowledgeDirectoryList,
      ui.knowledgeDirectoryEmpty,
      graph,
      {
        query: ui.graphSearch.value,
        type: ui.knowledgeTypeFilter.value,
        quadrant: ui.knowledgeQuadrantFilter.value,
        profile: ui.knowledgeProfileFilter.value,
        status: ui.knowledgeStatusFilter.value,
        projectNames: personalProjectNames(),
        onSelect: showDirectoryItem
      }
    );
    ui.graphCount.textContent = result.visible === result.total
      ? `${result.total} 条知识内容`
      : `显示 ${result.visible} / ${result.total} 条知识内容`;
    const hasQuery = Boolean(ui.graphSearch.value.trim());
    ui.graphCount.classList.toggle('search-active', hasQuery);
    ui.graphSearchLegend.hidden = true;
  }

  function showDirectoryItem(item) {
    const actions = inspectorActions(item.raw, item.itemKind);
    if (item.itemKind === 'entity') {
      renderNodeInspector(ui.graphInspector, item.raw, graphView ?? graph, actions);
    } else {
      renderEdgeInspector(ui.graphInspector, item.raw, graph, actions);
    }
  }

  function inspectorActions(raw, itemKind) {
    const space = getSpace();
    if (!space || space.providerUrl) return {};
    const projectId = itemKind === 'entity' ? raw.attributes?.projectId : null;
    return {
      onOpenProject: projectId && projectId !== space.personalProjectId
        ? () => onOpenPersonalProject?.(projectId)
        : null,
      onPublishProject: projectId && getState().capabilities.publishProject
        ? () => onPublishPersonalProject?.(projectId)
        : null,
      onEdit: () => editor.open(directoryItem(raw, itemKind), {
        personalSpaceId: getState().activePersonalSpaceId,
        personalProjectId: space.personalProjectId ?? null,
        projects: getState().personalProjects ?? []
      }),
      onProject: itemKind === 'entity' ? () => projectDialog.open(
        directoryItem(raw, itemKind),
        {
          personalSpaceId: getState().activePersonalSpaceId,
          personalProjectId: space.personalProjectId ?? null,
          projects: getState().personalProjects ?? []
        }
      ) : null
    };
  }

  function directoryItem(raw, itemKind) {
    return knowledgeItems({
      nodes: itemKind === 'entity' ? [raw] : graph.nodes,
      edges: itemKind === 'relationship' ? [raw] : []
    }).find((item) => item.id === raw.id);
  }

  function personalProjectNames() {
    return new Map((getState().personalProjects ?? []).map((project) => [
      project.project_id, project.profile.name
    ]));
  }

  function setMode(nextMode, { fit = true } = {}) {
    mode = nextMode;
    const showGraph = mode === 'graph';
    ui.knowledgeDirectoryMode.setAttribute('aria-selected', String(!showGraph));
    ui.knowledgeGraphMode.setAttribute('aria-selected', String(showGraph));
    ui.knowledgeDirectoryPanel.hidden = showGraph;
    ui.graphStage.hidden = !showGraph;
    ui.graphControls.hidden = !showGraph;
    ui.graphHint.hidden = !showGraph;
    ui.knowledgeTypeFilter.hidden = showGraph;
    ui.knowledgeQuadrantFilter.hidden = showGraph;
    ui.knowledgeProfileFilter.hidden = showGraph;
    ui.knowledgeStatusFilter.hidden = showGraph;
    ui.graphView.classList.toggle('graph-canvas-active', showGraph);
    if (showGraph) {
      ui.graphCount.textContent = graph
        ? `${graphView.nodes.length} 个节点 · ${graphView.edges.length} 条当前关系`
        : '尚未读取图谱';
      if (fit) requestAnimationFrame(() => graphController?.fit());
    } else {
      renderDirectory();
    }
  }

  function changeMode(nextMode) {
    if (mode === nextMode) return;
    setMode(nextMode);
    onRouteChange?.();
  }

  function clearGraphSearch() {
    graphController?.clearSelection();
    clearSearchStatus();
    if (mode === 'graph') {
      ui.graphCount.textContent = graph
        ? `${graphView.nodes.length} 个节点 · ${graphView.edges.length} 条当前关系`
        : '尚未读取图谱';
    }
  }

  function clearSearchStatus() {
    ui.graphCount.classList.remove('search-active');
    ui.graphSearchLegend.hidden = true;
    ui.graphSearchLegendText.textContent = '';
    clearGraphSearchStatus(ui.graphSearchStatus);
  }
}

function setAvailableValue(select, value, fallback) {
  const available = [...select.options].some((option) => option.value === value);
  select.value = available ? value : fallback;
}
