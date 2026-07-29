import { setViewDescription } from './view-header.js';
import { syncSearchableSelects } from './searchable-select.js';

export function createPersonalProjectGraph({
  ui,
  getState,
  getSpaces,
  browser,
  workspace,
  showView,
  onError,
  onRouteChange
}) {
  return { activate, leave, onSpaceChange, open };

  function activate({ projectId = null, load = true } = {}) {
    const state = getState();
    const spaces = getSpaces();
    const activeSpaceId = state.activePersonalSpaceId;
    scopeOptions(true, ui.graphSpace, spaces, state);
    if (projectId) {
      const key = `personal-project:${activeSpaceId}:${projectId}`;
      if (!spaces.has(key)) {
        onError(new Error('暂时找不到这个项目对应的图谱空间'));
        return;
      }
      ui.graphSpace.value = key;
    }
    const selected = spaces.get(ui.graphSpace.value);
    if (!selected || selected.providerUrl || selected.id !== activeSpaceId) {
      ui.graphSpace.value = `personal:${activeSpaceId}`;
    }
    syncSearchableSelects(ui.graphSpace);
    ui.graphSearch.value = '';
    browser.setMode('graph');
    workspace.configureContextPicker();
    setContext();
    const space = spaces.get(ui.graphSpace.value);
    const focusNames = new Set(space?.personalProjectId
      ? [space.projectName]
      : (state.personalProjects ?? []).map(({ profile }) => profile.name));
    if (load) return workspace.load({ focusNames, focusProjectNodes: true });
    return undefined;
  }

  function leave() {
    scopeOptions(false, ui.graphSpace, getSpaces(), getState());
  }

  function onSpaceChange() {
    setContext();
  }

  function open(projectId) {
    showView();
    const result = activate({ projectId });
    onRouteChange?.();
    return result;
  }

  function setContext() {
    const space = getSpaces().get(ui.graphSpace.value);
    if (!space || space.providerUrl) return;
    if (space.personalProjectId) {
      setViewDescription(
        ui,
        `${space.projectName} · 项目知识与按任务相关性生效的协作偏好`
      );
    } else {
      setViewDescription(
        ui,
        '全部个人项目 · 选择项目节点可进入独立知识范围'
      );
    }
  }
}

function scopeOptions(personalProjectsOnly, select, spaces, state) {
  for (const option of select.options) {
    const space = spaces.get(option.value);
    const allowed = !personalProjectsOnly || (
      space && !space.providerUrl && space.id === state.activePersonalSpaceId
    );
    option.hidden = !allowed;
    option.disabled = !allowed;
  }
  syncSearchableSelects(select);
}
