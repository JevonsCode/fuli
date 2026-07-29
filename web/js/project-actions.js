export function createProjectActions({
  deleteJson,
  postJson,
  getState,
  reloadState,
  selectView,
  onFeedback
}) {
  function readyWorkspaceUrl() {
    return getState().providers.workspaces
      .find(({ status }) => status === 'ready')?.providerUrl ?? null;
  }

  function suggestedNextVersion(currentVersion) {
    if (!currentVersion || currentVersion === 'legacy') return 'v1.0.0';
    const match = currentVersion.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return '';
    return `${match[1]}${match[2]}.${match[3]}.${Number(match[4]) + 1}`;
  }

  function publishPersonalProject({ localProjectId, releaseVersion, updateSummary }) {
    const providerUrl = readyWorkspaceUrl();
    if (!providerUrl) throw new Error('公共 Provider 当前不可用');
    return postJson('/api/projects/publish', {
      personalSpaceId: getState().activePersonalSpaceId,
      localProjectId,
      providerUrl,
      releaseVersion,
      updateSummary
    });
  }

  async function completePublication(result, publication) {
    await reloadState();
    selectView('public-projects');
    onFeedback(
      `“${result.project?.name ?? publication.projectName}” ${publication.releaseVersion} 已发布并记录版本信息。`
    );
  }

  async function deletePublicProject(project) {
    const query = new URLSearchParams({ providerUrl: project.providerUrl });
    const result = await deleteJson(
      `/api/projects/${encodeURIComponent(project.id)}?${query}`
    );
    await reloadState();
    onFeedback(`公共项目“${result.project_name ?? project.name}”已删除；本机个人项目仍保留。`);
  }

  function decideProjectRelation({ project, relationId, decision }) {
    return postJson(`/api/project-relations/${encodeURIComponent(relationId)}/decision`, {
      targetProjectId: project.id,
      providerUrl: project.providerUrl,
      decision,
      note: null
    });
  }

  async function createProjectRelation({ source, target, relationType }) {
    if (source.id === target.id) throw new Error('来源项目和目标项目不能相同');
    if (source.providerUrl !== target.providerUrl) {
      throw new Error('当前仅支持同一公共 Provider 内建立项目关系');
    }
    await postJson('/api/project-relations', {
      sourceProjectId: source.id,
      targetProjectId: target.id,
      providerUrl: source.providerUrl,
      relationType,
      note: null
    });
    onFeedback(relationType === 'PART_OF'
      ? '关系已提交，等待父项目确认。'
      : '项目关系已建立。');
  }

  return {
    completePublication,
    createProjectRelation,
    decideProjectRelation,
    deletePublicProject,
    publishPersonalProject,
    readyWorkspaceUrl,
    suggestedNextVersion
  };
}
