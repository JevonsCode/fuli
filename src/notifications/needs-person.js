// Tells a local notifier (DingDong, or anything listening on loopback) that
// a person is needed. Model-free and fire-and-forget: a slow or missing
// listener never delays or fails the request that a person is needed for.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DETAIL_LIMIT = 500;
const SENT_LIMIT = 500;

export const NEEDS_PERSON_EVENT = 'fuli.needs_person';

// '' turns notifications off. Only loopback http(s) is accepted: the payload
// carries project and request text, which never leaves this machine.
export function normalizeNeedsPersonUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) throw new TypeError('needsPersonUrl must be a URL string');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('needsPersonUrl must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new TypeError('needsPersonUrl must be an http(s) address on this machine (127.0.0.1, localhost or [::1])');
  }
  return url.href;
}

// One event per open request. `id` is stable across retries and processes, so
// a listener deduplicates on it. `sound: 'decision'` keeps this apart from
// completion sounds, which DingDong plays for finished work.
export function needsPersonEvent(record, { consoleUrl = '' } = {}) {
  return {
    type: NEEDS_PERSON_EVENT,
    version: 1,
    id: `agent_attention:${record.requestId}`,
    sound: 'decision',
    source: { kind: 'agent_attention', id: record.requestId, revision: record.revision ?? 0 },
    kind: record.kind,
    title: record.title,
    question: record.requestedAction,
    detail: typeof record.detail === 'string' ? record.detail.slice(0, DETAIL_LIMIT) : '',
    options: Array.isArray(record.options) ? record.options : [],
    personalSpaceId: record.personalSpaceId,
    personalProjectId: record.personalProjectId ?? null,
    agentId: record.agentId ?? null,
    createdAt: record.createdAt ?? null,
    openUrl: consoleUrl ? new URL('/inbox', consoleUrl).href : null
  };
}

export function createNeedsPersonNotifier({ readUrl, consoleUrl = '', fetchImpl = globalThis.fetch,
  timeoutMs = 3000, warn = (message) => process.stderr.write(`${message}\n`) }) {
  const sent = new Set();
  return {
    // Returns the delivery promise for tests; callers do not await it.
    notify(record) {
      if (record?.status !== 'open' || !record.requestId) return Promise.resolve('skipped');
      let url;
      try { url = normalizeNeedsPersonUrl(readUrl()); } catch { return Promise.resolve('invalid_url'); }
      const event = needsPersonEvent(record, { consoleUrl });
      if (!url || sent.has(event.id)) return Promise.resolve(url ? 'duplicate' : 'off');
      sent.add(event.id);
      if (sent.size > SENT_LIMIT) sent.delete(sent.values().next().value);
      return fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs)
      }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return 'delivered';
      }).catch((error) => {
        // Let a later replay of the same request try again.
        sent.delete(event.id);
        warn(`FULI needs-person notification was not delivered: ${error.message}`);
        return 'failed';
      });
    }
  };
}
