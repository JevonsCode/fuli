import { elements } from './elements.js';
import { el, escapeHtml, spaceKindLabel } from './util.js';

export function renderConnections(state) {
  elements.spacesList.replaceChildren(...state.spaces.map((space) => {
    const item = el('div', 'item');
    const subscriptionLabel = spaceSubscriptionLabel(state, space);
    item.innerHTML = `<div class="item-title"><span>${escapeHtml(space.name)}</span>` +
      `<span class="pill">${escapeHtml(spaceKindLabel(space.kind))}</span></div>` +
      (subscriptionLabel ? `<div class="meta">${escapeHtml(subscriptionLabel)}</div>` : '');
    return item;
  }));
}

function spaceSubscriptionLabel(state, space) {
  const count = state.subscriptions.filter((sub) =>
    space.kind === 'personal' ? sub.personalSpaceId === space.id : sub.spaceId === space.id
  ).length;
  if (count === 0) return '';
  return space.kind === 'personal' ? `${count} 个订阅` : `${count} 人订阅`;
}
