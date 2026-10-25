import { AsyncLocalStorage } from 'node:async_hooks';

// The time one lifecycle hook's task entry has left (rec#39 D-40). A hook runs
// its entry inside a budget that ends at its own deadline; an entry without
// one (an Agent's own begin_task_context or get_collaboration_preferences
// call) has no deadline here, as before. Its own module, free of entry views,
// so a part of the entry (the recall) can check its time without a cycle.
export const entryBudgets = new AsyncLocalStorage();

// Whether less than `ms` of this entry's time is left. An entry without a
// budget has no deadline here, so it never is.
export function entryTimeBelow(ms) {
  const budget = entryBudgets.getStore();
  return Boolean(budget) && budget.deadline - budget.now() < ms;
}
