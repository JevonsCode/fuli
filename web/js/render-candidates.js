import { elements } from './elements.js';
import { el, escapeHtml, formatDate } from './util.js';

export function renderCandidates(candidates, decideCandidate) {
  if (candidates.length === 0) {
    const empty = el('div', 'empty-state');
    empty.textContent = '暂无待确认内容';
    elements.candidatesList.replaceChildren(empty);
    return;
  }
  elements.candidatesList.replaceChildren(...candidates.map((candidate) => {
    const item = el('div', 'item');
    const syncAction = candidate.targetSpaceId
      ? `<button type="button" data-candidate="${candidate.id}" data-decision="sync">记到项目</button>`
      : '';
    item.innerHTML = `<div class="item-title"><span>${escapeHtml(candidate.targetSpaceName ?? candidate.personalSpaceName)}</span></div>` +
      `<div>${escapeHtml(candidate.episode?.body ?? candidate.reason)}</div><div class="meta">${formatDate(candidate.createdAt)}</div>` +
      `<div class="candidate-actions">${syncAction}` +
      `<button type="button" data-candidate="${candidate.id}" data-decision="personal_only">只记给我</button>` +
      `<button type="button" data-candidate="${candidate.id}" data-decision="ignore">不要记</button></div>`;
    return item;
  }));
  for (const button of elements.candidatesList.querySelectorAll('[data-candidate]')) {
    button.addEventListener('click', () => decideCandidate(button.dataset.candidate, button.dataset.decision));
  }
}
