import { SpaceKind } from '../models.js';
import {
  isSafeResourceFact,
  isSafeResourceText,
  projectCurrentFact,
  projectHistoryItem,
  projectSubscription
} from './lens-resource-projection.js';
import { selectCurrentFacts, selectHistoryItems } from './lens-resource-selection.js';

export const CURRENT_LENS_BUDGET_BYTES = 16 * 1024;
export const HISTORY_BUDGET_BYTES = 64 * 1024;
export const HISTORY_LIMIT = 100;

export class LensResourceService {
  constructor({ store, lens, activePersonalSpace }) {
    this.store = store;
    this.lens = lens;
    this.activePersonalSpace = activePersonalSpace;
  }

  current() {
    const personal = this.activePersonalSpace();
    const result = this.lens.getUserLens({
      personalSpaceId: personal.id,
      task: '',
      budget: CURRENT_LENS_BUDGET_BYTES,
      includeObserved: true,
      includeSuggested: false,
      includeRestricted: false
    });
    const projected = result.facts.map(projectCurrentFact).filter(Boolean);
    const selected = selectCurrentFacts(projected, CURRENT_LENS_BUDGET_BYTES);
    return safePayload({
      personalSpaceId: personal.id,
      facts: selected.facts,
      text: selected.text,
      truncated: result.truncated ||
        projected.length < result.facts.length ||
        selected.truncated,
      budget: {
        encoding: 'utf-8',
        limitBytes: CURRENT_LENS_BUDGET_BYTES,
        usedBytes: Buffer.byteLength(selected.text, 'utf8')
      }
    });
  }

  history() {
    const personal = this.activePersonalSpace();
    const result = this.lens.searchUserContext({
      personalSpaceId: personal.id,
      query: '',
      includeHistorical: true,
      includeRestricted: false,
      maxFactObjectBytes: HISTORY_BUDGET_BYTES,
      maxEvidenceBodyBytes: 0,
      scanLimit: HISTORY_LIMIT * 2,
      factFilter: isSafeResourceFact,
      limit: HISTORY_LIMIT
    });
    const safeItems = result.facts.map(projectHistoryItem).filter(Boolean);
    const selected = selectHistoryItems(safeItems, {
      limit: HISTORY_LIMIT,
      budgetBytes: HISTORY_BUDGET_BYTES
    });
    return safePayload({
      personalSpaceId: personal.id,
      limit: HISTORY_LIMIT,
      count: selected.items.length,
      truncated: result.truncated ||
        safeItems.length < result.facts.length ||
        selected.truncated,
      budget: {
        encoding: 'utf-8',
        limitBytes: HISTORY_BUDGET_BYTES,
        itemsBytes: selected.itemsBytes
      },
      items: selected.items
    }, HISTORY_BUDGET_BYTES);
  }

  subscribed() {
    const personal = this.activePersonalSpace();
    const subscriptions = this.store.subscriptionsFor(personal.id)
      .map((subscription) => ({ subscription, space: this.store.getSpace(subscription.spaceId) }))
      .filter(({ space }) => space?.kind === SpaceKind.PUBLIC)
      .map(({ subscription, space }) => projectSubscription(subscription, space))
      .filter(Boolean);
    return safePayload({ personalSpaceId: personal.id, subscriptions });
  }
}

function safePayload(payload, limitBytes = null) {
  const serialized = JSON.stringify(payload);
  if (!isSafeResourceText(serialized)) {
    throw new Error('Unsafe resource projection');
  }
  if (limitBytes && Buffer.byteLength(serialized, 'utf8') > limitBytes) {
    throw new Error('Resource projection exceeds its byte budget');
  }
  return payload;
}
