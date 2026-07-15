import { getJson } from './api.js';
import { elements } from './elements.js';
import { handleActionError } from './feedback.js';
import { createLensController } from './lens.js';
import { el, formatDate, humanPredicate } from './util.js';
import { isViewActive } from './views.js';

const STATUS_LABELS = Object.freeze({
  confirmed: '已确认',
  observed: '观察到'
});

const controller = createLensController({
  elements,
  getJson,
  renderLensFacts,
  handleActionError,
  isActive: () => isViewActive('memory')
});

export const refreshLens = controller.refreshLens;

export function renderLensFacts(facts) {
  if (facts.length === 0) {
    const empty = el('div', 'empty-state');
    empty.textContent = '还没有内容';
    elements.lensList.replaceChildren(empty);
    return;
  }
  elements.lensList.replaceChildren(...facts.map(renderLensFact));
}

function renderLensFact(fact) {
  const item = el('div', 'lens-item');
  const main = el('div', 'lens-main');
  const content = el('span', 'lens-content');
  const status = el('span', 'lens-status');
  content.textContent = `${humanPredicate(fact.predicate)} ${fact.object}`;
  status.textContent = STATUS_LABELS[fact.status] ?? '';
  main.append(content, status);
  item.append(main);

  const source = lensSourceLine(fact);
  if (source) {
    const meta = el('div', 'lens-meta');
    meta.textContent = source;
    item.append(meta);
  }
  return item;
}

function lensSourceLine(fact) {
  return [fact.source?.kind, fact.source?.uri, fact.validAt && formatDate(fact.validAt)]
    .filter(Boolean)
    .join(' · ');
}
