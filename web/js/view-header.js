const VIEW_HEADERS = Object.freeze({
  overview: { title: '概览', eyebrow: 'LOCAL + FEDERATED' },
  'personal-profile': {
    title: '协作偏好',
    eyebrow: 'PERSONAL LENS · LOCAL',
    description: '本机协作偏好 · 默认跨项目生效，可限制到单个项目'
  },
  'personal-projects': {
    title: '个人项目',
    eyebrow: 'PERSONAL · LOCAL',
    description: '全部个人项目 · 选择项目节点可进入独立知识范围'
  },
  'public-projects': { title: '公共项目', eyebrow: 'PUBLIC · SHARED PROVIDER' },
  graph: { title: '知识库', eyebrow: 'CONTENT + RELATIONSHIPS' },
  review: { title: '发布审核', eyebrow: 'PUBLICATION REVIEW' },
  connections: { title: '服务连接', eyebrow: 'LOCAL + PUBLIC' }
});

const INLINE_REFRESH_VIEWS = new Set(['personal-profile', 'personal-projects', 'graph']);

export function renderViewHeader(ui, view, { description = null } = {}) {
  const header = VIEW_HEADERS[view];
  if (!header) return false;
  ui.viewTitle.textContent = header.title;
  ui.viewEyebrow.textContent = header.eyebrow;
  setViewDescription(ui, description ?? header.description ?? '');
  ui.refresh.hidden = INLINE_REFRESH_VIEWS.has(view);
  return true;
}

export function setViewDescription(ui, description) {
  const value = description?.trim() ?? '';
  ui.viewDescription.textContent = value;
  ui.viewDescription.hidden = !value;
}
