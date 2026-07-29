import { el, statusChip } from './dom.js';

export function renderPublicProjectCards(container, { projects, subscribedKeys }) {
  if (!projects.length) {
    container.replaceChildren(el('div', 'empty-state project-empty', '暂无公共项目'));
    return;
  }

  container.replaceChildren(...projects.map((project) => {
    const card = projectCard(project.profile ?? {
      name: project.name,
      purpose: project.description,
      lifecycle: 'active',
      sources: [],
      boundaries: []
    }, { project });
    card.dataset.projectKey = projectKey(project);
    card.dataset.projectName = project.name;

    const metaLine = el('div', 'project-access');
    metaLine.append(
      statusChip(project.isOwner ? 'Owner' : roleLabel(project.role), project.isOwner ? 'owner' : ''),
      el('span', 'muted', project.isOwner ? '你发布的项目' : '公共可发现')
    );
    if (project.current_release) metaLine.append(releaseMeta(project.current_release));

    const footer = el('div', 'project-card-footer');
    const subscription = el('div', 'project-subscription-state');
    if (!subscribedKeys.has(projectKey(project))) {
      subscription.append(
        el('span', 'project-footer-label', '未订阅'),
        actionButton('订阅项目', 'subscribe', 'secondary-action')
      );
    } else {
      subscription.append(
        el('span', 'subscription-indicator', '', [el('i')]),
        el('span', '', '已订阅'),
        actionButton('取消订阅', 'unsubscribe', 'secondary-action subscription-action')
      );
    }
    footer.append(subscription, actionButton('查看详情', 'open', 'primary-action'));
    card.append(metaLine, footer);
    return card;
  }));
}

export function projectKey(project) {
  return `${project.providerUrl}::${project.id}`;
}

export function subscriptionProjectKeys(subscriptions) {
  return new Set(subscriptions.map((subscription) =>
    `${subscription.provider_url}::${subscription.project_id}`
  ));
}

function projectCard(profile, { project = null }) {
  const assessment = profile.assessment;
  const card = el('article', 'project-card');
  const heading = el('div', 'project-card-heading');
  const title = el('div');
  title.append(
    el('p', 'eyebrow', 'PUBLIC PROJECT'),
    el('h4', '', profile.name)
  );
  const headingActions = el('div', 'project-card-heading-actions');
  if (project?.can_manage) {
    headingActions.append(actionButton('管理项目', 'manage', 'management-action'));
  }
  headingActions.append(completionBadge(assessment));
  heading.append(title, headingActions);
  const purpose = el(
    'p',
    'project-purpose',
    profile.purpose || profile.scope || profile.technical_summary ||
      project?.description || '公共项目'
  );
  const evidence = el('div', 'evidence-row');
  for (const source of profile.sources ?? []) {
    evidence.append(statusChip(sourceTitle(source.kind), source.sensitivity !== 'normal' ? 'private' : ''));
  }
  if (!evidence.childElementCount) evidence.append(el('span', 'muted', '暂无已登记资料'));
  card.append(heading, purpose, evidence, completionSummary(assessment));
  return card;
}

function releaseMeta(release) {
  const meta = el('span', 'project-release-meta');
  meta.append(
    el('strong', '', release.version),
    el('span', '', `${release.publisher_name} · ${formatDate(release.published_at)}`)
  );
  return meta;
}

function completionBadge(assessment) {
  const badge = el('div', 'completion-badge');
  badge.append(
    el('strong', '', assessment ? String(assessment.score) : '—'),
    el('span', '', assessment ? '资料覆盖' : '暂无摘要')
  );
  return badge;
}

function completionSummary(assessment) {
  if (!assessment) return el('p', 'completion-note', '暂无资料覆盖摘要。');
  const details = el('details', 'completion-details');
  const recorded = assessment.confirmed.length + assessment.inferred.length;
  const covered = (assessment.dimensions ?? []).filter(
    ({ evidence = [] }) => evidence.length > 0
  ).length;
  details.append(el('summary', '', `${recorded} 项已有信息 · ${covered} 个资料维度`));
  const body = el('div', 'completion-columns');
  body.append(
    assessmentList('已记录', assessment.confirmed, 'confirmed'),
    assessmentList('根据现有信息推断', assessment.inferred, 'inferred')
  );
  details.append(body);
  return details;
}

function assessmentList(title, items = [], tone) {
  const block = el('section', `assessment-block ${tone}`);
  block.append(el('strong', '', title));
  const list = el('ul');
  for (const item of items.slice(0, 6)) list.append(el('li', '', item));
  if (!items.length) list.append(el('li', 'muted', '无'));
  block.append(list);
  return block;
}

function actionButton(label, action, className) {
  const button = el('button', className, label);
  button.type = 'button';
  button.dataset.projectAction = action;
  return button;
}

function sourceTitle(kind) {
  return ({
    prd: 'PRD', product_document: '产品文档', technical_document: '技术文档',
    frontend_repository: '前端仓库', backend_repository: '后端仓库', repository: '代码仓库',
    design: '设计', runbook: '运行手册', monitoring: '监控', issue_tracker: '问题跟踪', other: '资料'
  })[kind] ?? kind;
}

function roleLabel(role) {
  return ({ reader: 'Reader', contributor: 'Contributor', maintainer: 'Maintainer' })[role] ?? 'Reader';
}

function formatDate(value) {
  if (!value) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(value));
}
