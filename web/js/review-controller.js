import { el, statusChip } from './dom.js';
import { formatTime } from './graph-inspector.js';
import {
  CONFIRMATION_STATUS_LABELS,
  profileAspectLabel,
  quadrantLabel
} from './knowledge-taxonomy.js';

export function createReviewController({
  ui,
  getState,
  getReviewProject,
  getJson,
  postJson,
  reloadState,
  reloadKnowledge,
  onError
}) {
  let personalCount = 0;
  let sharedCount = 0;

  function updateCount() {
    const total = personalCount + sharedCount;
    ui.metricReview.textContent = total;
    ui.reviewCount.textContent = total;
    ui.reviewCount.hidden = total === 0;
  }

  function reset() {
    personalCount = 0;
    sharedCount = 0;
    updateCount();
  }

  async function loadPersonal() {
    const state = getState();
    if (!state?.activePersonalSpaceId) return;
    const query = new URLSearchParams({
      personalSpaceId: state.activePersonalSpaceId,
      status: 'pending'
    });
    try {
      const result = await getJson(`/api/personal-review?${query}`);
      const drafts = result.drafts ?? [];
      personalCount = drafts.length;
      updateCount();
      ui.personalReviewList.replaceChildren(...(drafts.length
        ? drafts.map((draft) => personalDraftRow(draft, state.capabilities.submitKnowledge))
        : [el('div', 'empty-state', '当前没有待个人确认的内容')]));
    } catch (error) {
      ui.personalReviewList.replaceChildren(el('div', 'empty-state', '无法读取发布确认队列'));
      onError(error);
    }
  }

  async function loadShared() {
    const project = getReviewProject();
    if (!project) {
      sharedCount = 0;
      updateCount();
      ui.reviewList.replaceChildren(el('div', 'empty-state', '没有可审核的团队共享项目'));
      return;
    }
    const query = new URLSearchParams({
      projectId: project.id,
      providerUrl: project.providerUrl,
      status: 'pending'
    });
    try {
      const result = await getJson(`/api/review?${query}`);
      const proposals = result.proposals ?? [];
      sharedCount = proposals.length;
      updateCount();
      ui.reviewList.replaceChildren(...(proposals.length
        ? proposals.map((proposal) => proposalRow(project, proposal))
        : [el('div', 'empty-state', '当前没有待审核 Proposal')]));
    } catch (error) {
      sharedCount = 0;
      updateCount();
      ui.reviewList.replaceChildren(el('div', 'empty-state', '无法读取审核队列'));
      onError(error);
    }
  }

  async function handlePersonalDecision(event) {
    const button = event.target.closest('[data-personal-decision]');
    if (!button) return;
    const row = button.closest('.review-item');
    button.disabled = true;
    try {
      await postJson(`/api/personal-review/${encodeURIComponent(row.dataset.draftId)}/decision`, {
        decision: button.dataset.personalDecision
      });
      await Promise.all([loadPersonal(), reloadState()]);
    } catch (error) {
      onError(error);
      button.disabled = false;
    }
  }

  async function handleSharedDecision(event) {
    const button = event.target.closest('[data-decision]');
    if (!button) return;
    const row = button.closest('.review-item');
    button.disabled = true;
    try {
      await postJson(`/api/review/${encodeURIComponent(row.dataset.proposalId)}/decision`, {
        projectId: row.dataset.projectId,
        providerUrl: row.dataset.providerUrl,
        decision: button.dataset.decision,
        note: null
      });
      await Promise.all([loadShared(), reloadKnowledge()]);
    } catch (error) {
      onError(error);
      button.disabled = false;
    }
  }

  return {
    handlePersonalDecision,
    handleSharedDecision,
    loadPersonal,
    loadShared,
    reset
  };
}

function personalDraftRow(draft, canSubmit) {
  const row = el('article', 'review-item review-item-detailed');
  row.dataset.draftId = draft.id;
  const content = el('div');
  content.append(
    el('div', 'review-stage', '提交公共前确认'),
    el('h4', '', draft.episode.name),
    el('p', '', draft.episode.summary || draft.episode.source_description),
    el('div', 'review-meta', null, [
      el('span', '', `${draft.episode.entities.length} 个实体`),
      el('span', '', `${draft.episode.relationships.length} 条关系`),
      el('span', '', formatTime(draft.created_at))
    ]),
    episodeDetails(draft.episode)
  );
  const actions = el('div', 'review-actions stacked-actions');
  actions.append(
    decisionButton('仅保留个人', 'keep_personal', 'secondary-action'),
    decisionButton('忽略', 'ignore', 'reject')
  );
  if (canSubmit) actions.append(decisionButton('提交公共', 'submit_public', 'approve'));
  row.append(content, actions);
  return row;
}

function proposalRow(project, proposal) {
  const row = el('article', 'review-item');
  row.dataset.projectId = project.id;
  row.dataset.providerUrl = project.providerUrl;
  row.dataset.proposalId = proposal.id;
  const content = el('div');
  content.append(
    el('div', 'review-stage', '共享 Maintainer 审核'),
    el('h4', '', proposal.episode.name),
    el('p', '', proposal.episode.summary || proposal.episode.source_description),
    el('div', 'review-meta', null, [
      el('span', '', `${proposal.episode.entities.length} 个实体`),
      el('span', '', `${proposal.episode.relationships.length} 条关系`),
      el('span', '', new Date(proposal.created_at).toLocaleString())
    ]),
    episodeDetails(proposal.episode)
  );
  const actions = el('div', 'review-actions');
  const reject = el('button', 'reject', '拒绝');
  reject.type = 'button';
  reject.dataset.decision = 'reject';
  const approve = el('button', 'approve', '通过');
  approve.type = 'button';
  approve.dataset.decision = 'approve';
  actions.append(reject, approve);
  row.append(content, actions);
  return row;
}

function episodeDetails(episode) {
  const details = el('details', 'episode-details');
  details.append(el('summary', '', '查看提交详情'));
  const body = el('div', 'episode-body');
  body.append(el('dl', 'episode-meta', null, [
    meta('来源', episode.source_description),
    meta('来源类型', episode.source_kind),
    meta('敏感级别', episode.sensitivity),
    meta('参考时间', formatTime(episode.reference_time))
  ]));
  const entities = el('section', 'episode-section');
  entities.append(el('strong', '', '实体'));
  for (const entity of episode.entities) {
    entities.append(el('div', 'episode-record', null, [
      statusChip(entity.type),
      el('span', '', entity.name),
      el('small', '', `${entity.summary || '无摘要'} · ${epistemicSummary(entity)}`)
    ]));
  }
  const relationships = el('section', 'episode-section');
  relationships.append(el('strong', '', '关系'));
  for (const relation of episode.relationships) {
    relationships.append(el('div', 'episode-record relation-record', null, [
      statusChip(relation.type),
      el('span', '', `${relation.source} → ${relation.target}`),
      el('small', '', `${relation.fact} · ${epistemicSummary(relation)}`)
    ]));
  }
  if (!episode.relationships.length) relationships.append(el('p', 'muted', '没有关系'));
  body.append(entities, relationships);
  details.append(body);
  return details;
}

function epistemicSummary(item) {
  return [
    quadrantLabel(item.origin_quadrant ?? 'known_known'),
    CONFIRMATION_STATUS_LABELS[item.confirmation_status] ?? '待确认',
    item.profile_aspect ? profileAspectLabel(item.profile_aspect) : null
  ].filter(Boolean).join(' · ');
}

function decisionButton(label, decision, className) {
  const button = el('button', className, label);
  button.type = 'button';
  button.dataset.personalDecision = decision;
  return button;
}

function meta(term, value) {
  const row = el('div');
  row.append(el('dt', '', term), el('dd', '', value));
  return row;
}
