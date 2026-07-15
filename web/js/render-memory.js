import { elements } from './elements.js';
import { el, escapeHtml, formatDate, humanPredicate } from './util.js';

export function renderMemory(state) {
  const timelineCount = state.historicalFacts.length + state.currentFacts.length;
  elements.factSection.hidden = state.currentFacts.length === 0;
  elements.timelineSection.hidden = timelineCount === 0;
  elements.factCount.textContent = state.currentFacts.length ? `${state.currentFacts.length}` : '';
  renderFacts(state.currentFacts);
  renderTimeline([...state.historicalFacts, ...state.currentFacts]);
}

function renderFacts(facts) {
  elements.factsList.replaceChildren(...facts.map((fact) => {
    const row = el('div', 'fact-row');
    row.innerHTML = `<div class="fact-main"><strong>${escapeHtml(fact.spaceName)}</strong>` +
      `<div class="fact-meta">${formatDate(fact.validAt)}</div></div>` +
      `<div class="fact-main">${escapeHtml(humanPredicate(fact.predicate))} ${escapeHtml(fact.object)}</div>`;
    return row;
  }));
}

function renderTimeline(facts) {
  facts.sort((a, b) => b.validAt.localeCompare(a.validAt));
  elements.timelineList.replaceChildren(...facts.map((fact) => {
    const item = el('div', 'timeline-item');
    item.innerHTML = `<div class="timeline-main"><strong>${escapeHtml(fact.spaceName)}</strong>` +
      `<span class="${fact.invalidAt ? 'invalid' : 'muted'}">${fact.invalidAt ? '历史' : '当前'}</span></div>` +
      `<div class="timeline-main">${escapeHtml(humanPredicate(fact.predicate))} ${escapeHtml(fact.object)}</div>` +
      `<div class="timeline-meta">${formatDate(fact.validAt)}${fact.invalidAt ? ` 至 ${formatDate(fact.invalidAt)}` : ''}</div>`;
    return item;
  }));
}
