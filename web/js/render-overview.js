import { elements } from './elements.js';
import { el, escapeHtml, formatDate, humanPredicate } from './util.js';

export function renderOverview(state, pendingCandidates) {
  elements.overviewMemoryCount.textContent = `${state.currentFacts.length}`;
  elements.overviewPendingCount.textContent = `${pendingCandidates.length}`;
  elements.overviewSpaceCount.textContent = `${state.spaces.length}`;
  elements.overviewSubscriptionCount.textContent = `${state.subscriptions.length}`;

  const recent = [...state.currentFacts, ...state.historicalFacts]
    .sort((a, b) => b.validAt.localeCompare(a.validAt))
    .slice(0, 5);
  if (recent.length === 0) {
    const empty = el('div', 'empty-state');
    empty.textContent = '暂无变化';
    elements.recentList.replaceChildren(empty);
    return;
  }
  elements.recentList.replaceChildren(...recent.map((fact) => {
    const item = el('div', 'timeline-item');
    item.innerHTML = `<div class="timeline-main"><strong>${escapeHtml(fact.spaceName)}</strong>` +
      `<span class="muted">${formatDate(fact.validAt)}</span></div>` +
      `<div class="timeline-main">${escapeHtml(humanPredicate(fact.predicate))} ${escapeHtml(fact.object)}</div>`;
    return item;
  }));
}
