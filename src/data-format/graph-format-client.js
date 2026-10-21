import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { personalHumanReviewChannel } from '../graphiti/human-review-channel.js';

// The personal graph's side of a person's migration (rec#17 D-09 part 2),
// through its provider. Preview needs the ordinary access token; apply and
// rollback also send the human-review token (human-review-channel.js). This
// module is used by `fuli migrate` and the local console; no MCP or Agent
// tool module imports it.

// A confirmed step may journal and rewrite many records in one transaction.
const CHANGE_TIMEOUT_MS = 10 * 60_000;

export function personalGraphFormat(dataDir, options = {}) {
  const send = personalHumanReviewChannel(dataDir, options);
  const request = async (path, body, options) => {
    const { ok, status, payload } = await send(path, body, options);
    if (ok) return payload;
    const detail = payload?.detail;
    if (detail?.code) throw new DataFormatError('graph', detail.code, detail.message, detail.steps ?? []);
    throw new DataFormatError('graph', 'data_format_graph_unavailable',
      `The graph provider answered HTTP ${status}${typeof detail === 'string' ? `: ${detail}` : ''}.`);
  };
  return {
    // { plan, undoable } where plan is null when nothing waits for a person.
    async preview() {
      try {
        return await request('/v1/data-format/preview');
      } catch (error) {
        if (error?.code === 'ENOENT') return { plan: null, undoable: [] };
        return { plan: { store: 'graph', kind: 'neo4j', action: 'unavailable', steps: [],
          reason: error instanceof DataFormatError ? error.message
            : 'its provider is not answering; start FULI to inspect the graph' }, undoable: [] };
      }
    },
    apply: (digest, entrypoint) => request('/v1/data-format/apply', { digest, entrypoint },
      { review: true, timeoutMs: CHANGE_TIMEOUT_MS }),
    rollback: (migrationId, entrypoint) => request('/v1/data-format/rollback',
      { migration_id: migrationId, entrypoint }, { review: true, timeoutMs: CHANGE_TIMEOUT_MS }),
    // Deleting undo journals removes undo, so it takes the review channel too.
    // applyIds: the journals the shared size budget chose (format-retention.js).
    prune: ({ keep, applyIds = [], dryRun = false }) => request('/v1/data-format/prune',
      { keep, apply_ids: applyIds, dry_run: dryRun }, { review: true, timeoutMs: CHANGE_TIMEOUT_MS })
  };
}
