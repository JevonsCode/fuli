export function createKnowledgeActions({
  patchJson,
  postJson,
  reloadState,
  reloadKnowledge,
  onFeedback
}) {
  async function revise({ itemId, itemKind, ...body }) {
    const result = await patchJson(
      `/api/knowledge/${itemKind}/${encodeURIComponent(itemId)}`,
      body
    );
    onFeedback(body.action === 'invalidate'
      ? '知识已标记为失效，历史记录已保留。'
      : body.action === 'restore'
        ? '知识已恢复为有效。'
        : '知识已纠正，原始证据仍然保留。');
    return result;
  }

  async function reassign({ itemId, itemKind, ...body }) {
    const result = await postJson(
      `/api/knowledge/${itemKind}/${encodeURIComponent(itemId)}/assignment`,
      body
    );
    onFeedback('项目归属已调整，来源会话和历史证据没有改变。');
    return result;
  }

  async function setPreferenceScope({ itemId, itemKind, ...body }) {
    const result = await postJson(
      `/api/knowledge/${itemKind}/${encodeURIComponent(itemId)}/preference-scope`,
      body
    );
    onFeedback(body.scope === 'global'
      ? '这条协作偏好现在对所有个人项目生效。'
      : '这条协作偏好现在只对所选个人项目生效。');
    return result;
  }

  function previewProjectAction({ itemId, itemKind, ...body }) {
    return postJson(
      `/api/knowledge/${itemKind}/${encodeURIComponent(itemId)}/project-action/preview`,
      body
    );
  }

  function applyProjectAction({ itemId, itemKind, ...body }) {
    return postJson(
      `/api/knowledge/${itemKind}/${encodeURIComponent(itemId)}/project-action`,
      body
    );
  }

  async function completeProjectAction(result, targetName) {
    await reloadState();
    await reloadKnowledge();
    const messages = {
      created: `个人项目“${targetName}”已创建。`,
      linked: `这条知识已加入“${targetName}”，主要归属保持不变。`,
      already_linked: `“${targetName}”已经在使用这条知识。`,
      duplicate_reused: `“${targetName}”已有相同内容，已复用现有节点。`,
      conflict_pending: `已保留项目操作；冲突内容暂不在“${targetName}”生效。`,
      conflict_resolved: '冲突已按当前选择处理，并保留处理记录。'
    };
    onFeedback(messages[result.status] ?? '项目知识范围已更新。');
  }

  return {
    applyProjectAction,
    completeProjectAction,
    previewProjectAction,
    reassign,
    revise,
    setPreferenceScope
  };
}
