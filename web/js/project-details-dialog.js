import { getJson } from './api.js';
import { el, statusChip } from './dom.js';
import { projectKey } from './project-cards.js';

export function createProjectDetailsDialog({
  ui,
  onOpenGraph,
  onSubscribe,
  onRelationDecision,
  onError
}) {
  let projects = new Map();
  let subscriptions = new Set();
  let currentProject = null;

  ui.projectDetailsGraph.addEventListener('click', openGraph);
  ui.projectDetailsRelations.addEventListener('click', relationAction);
  ui.projectDetailsDialog.addEventListener('close', () => { currentProject = null; });

  return { configure, open };

  function configure(nextProjects, subscribedKeys) {
    projects = new Map(nextProjects.map((project) => [projectKey(project), project]));
    subscriptions = new Set(subscribedKeys);
  }

  async function open(project) {
    currentProject = project;
    ui.projectDetailsTitle.textContent = project.name;
    ui.projectDetailsDescription.textContent = project.profile?.purpose ||
      project.profile?.scope || project.profile?.technical_summary ||
      project.description || '公共项目';
    renderLatestRelease(project.current_release);
    ui.projectReleaseCount.textContent = '';
    ui.projectReleaseList.replaceChildren(el('p', 'muted', '正在读取版本记录…'));
    ui.projectDetailsRelations.replaceChildren(el('p', 'muted', '正在读取项目关系…'));
    ui.projectDetailsDialog.showModal();
    await loadDetails(project);
  }

  async function loadDetails(project) {
    const query = new URLSearchParams({ providerUrl: project.providerUrl });
    try {
      const [releaseResult, relationResult] = await Promise.all([
        getJson(`/api/projects/${encodeURIComponent(project.id)}/releases?${query}`),
        getJson(`/api/project-relations?${new URLSearchParams({
          projectId: project.id,
          providerUrl: project.providerUrl
        })}`)
      ]);
      if (currentProject !== project) return;
      renderReleases(releaseResult.releases ?? []);
      renderRelations(project, relationResult.relations ?? []);
    } catch (error) {
      if (currentProject !== project) return;
      ui.projectReleaseList.replaceChildren(el('p', 'muted', '版本记录读取失败'));
      ui.projectDetailsRelations.replaceChildren(el('p', 'muted', '项目关系读取失败'));
      onError(error);
    }
  }

  function renderLatestRelease(release) {
    if (!release) {
      ui.projectLatestRelease.replaceChildren(el('p', 'muted', '这个项目还没有版本记录'));
      return;
    }
    const copy = el('div', 'release-copy');
    copy.append(
      el('strong', '', release.version),
      el('p', '', release.summary),
      el('small', '', `${release.publisher_name} · ${formatDateTime(release.published_at)}`)
    );
    ui.projectLatestRelease.replaceChildren(copy);
  }

  function renderReleases(releases) {
    ui.projectReleaseCount.textContent = `${releases.length} 个版本`;
    if (!releases.length) {
      ui.projectReleaseList.replaceChildren(el('p', 'muted', '暂无版本记录'));
      return;
    }
    ui.projectReleaseList.replaceChildren(...releases.map((release) => {
      const item = el('article', 'project-release-item');
      item.append(
        el('strong', '', release.version),
        el('p', '', release.summary),
        el('small', '', `${release.publisher_name} · ${formatDateTime(release.published_at)}`)
      );
      return item;
    }));
  }

  function renderRelations(project, relations) {
    if (!relations.length) {
      ui.projectDetailsRelations.replaceChildren(el('p', 'muted', '暂无项目关系'));
      return;
    }
    ui.projectDetailsRelations.replaceChildren(...relations.map((relation) =>
      relationRow(project, relation)
    ));
  }

  function relationRow(project, relation) {
    const outgoing = relation.source_project_id === project.id;
    const relatedId = outgoing ? relation.target_project_id : relation.source_project_id;
    const related = [...projects.values()].find(({ id, providerUrl }) =>
      id === relatedId && providerUrl === project.providerUrl
    );
    const row = el('article', 'project-detail-relation');
    const copy = el('div');
    copy.append(
      statusChip(relationLabel(relation.relation_type)),
      el('strong', '', `${outgoing ? '指向' : '来自'} · ${related?.name ?? relatedId}`),
      el('small', '', relation.status === 'pending' ? '等待父项目确认' : statusLabel(relation.status))
    );
    const actions = el('div', 'project-detail-relation-actions');
    if (related && !subscriptions.has(projectKey(related))) {
      actions.append(relationButton('订阅关联项目', 'subscribe', relation.id, relatedId));
    }
    if (!outgoing && relation.relation_type === 'PART_OF' && relation.status === 'pending' &&
        project.role === 'maintainer') {
      actions.append(
        relationButton('拒绝', 'reject', relation.id, relatedId),
        relationButton('确认父级', 'confirm', relation.id, relatedId)
      );
    }
    row.append(copy, actions);
    return row;
  }

  async function relationAction(event) {
    const button = event.target.closest('[data-relation-action]');
    if (!button || !currentProject) return;
    button.disabled = true;
    try {
      if (button.dataset.relationAction === 'subscribe') {
        const related = [...projects.values()].find(({ id, providerUrl }) =>
          id === button.dataset.relatedId && providerUrl === currentProject.providerUrl
        );
        if (related) await onSubscribe(related);
      } else {
        await onRelationDecision({
          project: currentProject,
          relationId: button.dataset.relationId,
          decision: button.dataset.relationAction === 'confirm' ? 'confirm' : 'reject'
        });
      }
      if (currentProject) await loadDetails(currentProject);
    } catch (error) {
      onError(error);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  function openGraph() {
    if (!currentProject) return;
    const project = currentProject;
    ui.projectDetailsDialog.close();
    onOpenGraph(project);
  }
}

function relationButton(label, action, relationId, relatedId) {
  const button = el('button', action === 'confirm' ? 'primary-action' : 'secondary-action', label);
  button.type = 'button';
  button.dataset.relationAction = action;
  button.dataset.relationId = relationId;
  button.dataset.relatedId = relatedId;
  return button;
}

function relationLabel(type) {
  return ({
    PART_OF: '属于', DEPENDS_ON: '依赖', PROVIDES_TO: '提供能力',
    SHARES_CAPABILITY_WITH: '共享能力', SUCCESSOR_OF: '后继于', RELATED_TO: '相关'
  })[type] ?? type;
}

function statusLabel(status) {
  return ({ active: '已生效', rejected: '已拒绝' })[status] ?? status;
}

function formatDateTime(value) {
  if (!value) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}
