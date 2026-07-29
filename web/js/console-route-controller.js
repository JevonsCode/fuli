import {
  findRouteSpaceKey,
  graphSpaceRoute,
  readConsoleRoute,
  writeConsoleRoute
} from './console-route.js';
import { syncSearchableSelects } from './searchable-select.js';

export function createConsoleRouteController({
  ui,
  getSpaces,
  getActiveView,
  browser,
  workspace,
  personalProjectGraph,
  selectView
}) {
  let applying = false;

  return {
    listen() {
      globalThis.addEventListener?.('popstate', restore);
    },
    restore,
    sync
  };

  function sync({ replace = false } = {}) {
    if (applying) return;
    const view = getActiveView();
    const knowledgeView = view === 'graph' || view === 'personal-projects';
    const spaces = getSpaces();
    writeConsoleRoute({
      view,
      knowledge: knowledgeView ? {
        mode: browser.mode(),
        space: graphSpaceRoute(spaces.get(ui.graphSpace.value)),
        query: ui.graphSearch.value.trim(),
        type: ui.knowledgeTypeFilter.value,
        quadrant: ui.knowledgeQuadrantFilter.value,
        profile: ui.knowledgeProfileFilter.value,
        status: ui.knowledgeStatusFilter.value,
        contexts: workspace.selectedContextIds()
      } : null
    }, { replace });
  }

  async function restore() {
    const route = readConsoleRoute();
    const requestedButton = ui.navButtons.find(({ dataset }) => dataset.view === route.view);
    const view = requestedButton && !requestedButton.hidden ? route.view : 'overview';
    applying = true;
    try {
      if (!route.knowledge || (view !== 'graph' && view !== 'personal-projects')) {
        selectView(view, { syncRoute: false });
        return;
      }

      const spaces = getSpaces();
      const spaceKey = findRouteSpaceKey(spaces, route.knowledge.space);
      if (spaceKey) {
        ui.graphSpace.value = spaceKey;
        syncSearchableSelects(ui.graphSpace);
      }
      selectView(view, { loadGraphView: false, syncRoute: false });
      if (view === 'personal-projects') {
        const space = spaces.get(ui.graphSpace.value);
        personalProjectGraph.activate({
          projectId: space?.personalProjectId ?? null,
          load: false
        });
      }
      workspace.setSelectedContextIds(route.knowledge.contexts);
      workspace.configureContextPicker();
      ui.graphSearch.value = route.knowledge.query;
      browser.setMode(route.knowledge.mode, { fit: false });
      await workspace.load();
      browser.setDirectoryState(route.knowledge);
      browser.setMode(route.knowledge.mode, { fit: false });
      if (route.knowledge.mode === 'graph' && route.knowledge.query) {
        await workspace.search();
      }
    } finally {
      applying = false;
      sync({ replace: true });
    }
  }
}
