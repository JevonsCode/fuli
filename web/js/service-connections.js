const PUBLIC_STATES = Object.freeze({
  personal_only: {
    status: 'disconnected',
    sidebarTitle: '公共服务未连接',
    sidebarCopy: '当前仅使用本机',
    cardTitle: '未连接',
    cardCopy: '当前未连接公共服务；公共项目、订阅、发布与团队审核保持关闭。'
  },
  degraded: {
    status: 'error',
    sidebarTitle: '公共服务连接异常',
    sidebarCopy: '本地知识库不受影响',
    cardTitle: '连接异常',
    cardCopy: '公共服务已经配置，但当前无法访问；本地知识库仍可正常使用。'
  },
  connected: {
    status: 'ready',
    sidebarTitle: '公共服务已连接',
    sidebarCopy: '公共项目与协作可用',
    cardTitle: '已连接',
    cardCopy: '公共项目、订阅、发布与团队协作功能已经可以使用。'
  }
});

export function renderServiceConnections(root, state) {
  const personalReady = state?.providers?.personal?.status === 'ready';
  const publicState = PUBLIC_STATES[state?.mode] ?? PUBLIC_STATES.personal_only;
  const workspaces = state?.providers?.workspaces ?? [];
  const readyWorkspaces = workspaces.filter(({ status }) => status === 'ready').length;

  renderPublicRuntime(root, publicState);
  renderLocalCard(root, personalReady);
  renderPublicCard(root, publicState, workspaces.length, readyWorkspaces);
}

function renderPublicRuntime(root, publicState) {
  const dot = root.querySelector('#public-runtime-dot');
  if (dot) dot.className = `status-dot ${publicState.status}`;
  setText(root.querySelector('#public-runtime-label'), publicState.sidebarTitle);
  setText(root.querySelector('#public-runtime-copy'), publicState.sidebarCopy);
}

function renderLocalCard(root, ready) {
  const card = root.querySelector('#local-connection-card');
  if (!card) return;
  card.dataset.status = ready ? 'ready' : 'error';
  setText(root.querySelector('#local-connection-state'), ready ? '已连接' : '连接异常');
  setText(root.querySelector('#local-connection-copy'), ready
    ? '个人项目、协作偏好和会话知识正在写入本机图谱。'
    : '本地知识库暂时无法使用，请检查 Graphiti 与 Neo4j。');
}

function renderPublicCard(root, publicState, workspaceCount, readyCount) {
  const card = root.querySelector('#public-connection-card');
  if (!card) return;
  card.dataset.status = publicState.status;
  setText(root.querySelector('#public-connection-state'), publicState.cardTitle);
  setText(root.querySelector('#public-connection-copy'), publicState.cardCopy);
  setText(root.querySelector('#public-connection-detail'), publicConnectionDetail(
    publicState.status,
    workspaceCount,
    readyCount
  ));
}

function publicConnectionDetail(status, workspaceCount, readyCount) {
  if (status === 'ready') return `${readyCount || workspaceCount} 个共享服务可用`;
  if (status === 'error') return `${workspaceCount || 1} 个共享服务连接异常`;
  return '尚未配置';
}

function setText(node, text) {
  if (node) node.textContent = text;
}
