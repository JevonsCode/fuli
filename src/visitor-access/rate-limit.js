// How often one requester may try to search this computer's shared
// knowledge, counted from the recorded attempts (answered, failed, pending and
// refused alike), so a restart or a second process resets nothing and a flood
// of refused attempts keeps its requester out. The caller runs this and the
// row it then writes in one transaction. Answers null when a search may run,
// otherwise the refusal code.
const SHORT_WINDOW_MS = 10 * 60 * 1000;
const SHORT_WINDOW_SEARCHES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SEARCHES = 300;

export function rateLimitRefusal(store, requesterKey, now) {
  const since = (windowMs) => new Date(now.getTime() - windowMs).toISOString();
  if (store.attemptsSince(requesterKey, since(SHORT_WINDOW_MS)) >= SHORT_WINDOW_SEARCHES) return 'rate_limited_short';
  if (store.attemptsSince(requesterKey, since(DAY_MS)) >= DAY_SEARCHES) return 'rate_limited_day';
  return null;
}
