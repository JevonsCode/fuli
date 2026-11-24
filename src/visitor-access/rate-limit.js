// How often one requester may try to search this computer's shared
// knowledge, counted from the recorded attempts (answered, failed, pending and
// refused alike), so a restart or a second process resets nothing and a flood
// of refused attempts keeps its requester out. And how often one shared
// project may be read by everyone together: on a member computer the
// coordinator decides which devices exist, so a limit per requester alone
// would not bound a coordinator that invents new ones. Refused attempts do not
// count toward the project's limit, so a flood never locks a project longer.
// The caller runs this and the row it then writes in one transaction. Answers
// null when a read may run, otherwise the refusal code.
const SHORT_WINDOW_MS = 10 * 60 * 1000;
const SHORT_WINDOW_SEARCHES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SEARCHES = 300;
const PROJECT_SHORT_WINDOW_READS = 60;
const PROJECT_DAY_READS = 600;

export function rateLimitRefusal(store, requesterKey, projectId, now) {
  const since = (windowMs) => new Date(now.getTime() - windowMs).toISOString();
  if (store.attemptsSince(requesterKey, since(SHORT_WINDOW_MS)) >= SHORT_WINDOW_SEARCHES) return 'rate_limited_short';
  if (store.attemptsSince(requesterKey, since(DAY_MS)) >= DAY_SEARCHES) return 'rate_limited_day';
  if (!projectId) return null;
  if (store.projectReadsSince(projectId, since(SHORT_WINDOW_MS)) >= PROJECT_SHORT_WINDOW_READS) return 'project_rate_limited_short';
  if (store.projectReadsSince(projectId, since(DAY_MS)) >= PROJECT_DAY_READS) return 'project_rate_limited_day';
  return null;
}

// Reads that write no row (a visit request's status) are counted here, in
// memory: at most STATUS_READS per requester in SHORT_WINDOW_MS, for at most
// STATUS_REQUESTERS requesters (the oldest forgotten first). A restart resets
// it; the recorded limits above still bound every requester.
const STATUS_READS = 60;
const STATUS_REQUESTERS = 1000;

export function createStatusReadLimiter() {
  const reads = new Map();
  return {
    // null when this read may run (and counts it), otherwise the refusal code.
    refusal(requesterKey, now) {
      const since = now.getTime() - SHORT_WINDOW_MS;
      const recent = (reads.get(requesterKey) ?? []).filter((at) => at > since);
      if (recent.length >= STATUS_READS) return 'rate_limited_short';
      reads.delete(requesterKey);
      reads.set(requesterKey, [...recent, now.getTime()]);
      if (reads.size > STATUS_REQUESTERS) reads.delete(reads.keys().next().value);
      return null;
    }
  };
}
