import { backupRetentionPolicy, pruneFormatBackups, sizeBudgetReason } from './backup-retention.js';
import { GRAPH_LABEL } from './migration-plan.js';
import { recordFormatOperations } from './operations-log.js';

// One soft budget for what FULI keeps to undo or restore a data format change
// (rec#17 D-09 part 2, D-11 §5): each local store keeps its newest `keep`
// format backups, the graph its newest `keep` undo journals, and the backups
// and journals together use at most `maxBytes` (1 GiB by default). Past it,
// the oldest items no undo or current version needs go first, across both;
// journals of undone graph steps go before anything else. What an undo or the
// current version needs is kept even beyond the budget.
//
// The graph provider lists its journals first (a dry run), this module
// chooses within the shared budget, local backups are pruned, and then the
// provider prunes the journals chosen, checking again under its lock that
// none is the one an undo needs now. When the provider cannot be reached,
// local backups alone are held to the budget and the graph is reported as
// not pruned.

export async function pruneFormatRetention({ dataDir, graph = null, policy = backupRetentionPolicy(), dryRun = false,
  now = () => new Date(), remove, sizeOf }) {
  let plan = null;
  let graphError = null;
  if (graph) {
    try {
      plan = await graph.prune({ keep: policy.keep, dryRun: true });
    } catch (error) {
      // No graph connection set up in this data directory: nothing to weigh.
      if (error?.code === 'ENOENT') graph = null;
      else graphError = error.message;
    }
  }
  const shared = (plan?.journals ?? []).map((journal) => ({ key: journal.applyId, bytes: journal.bytes,
    at: journal.recordedAt ?? '', needed: journal.protected === true, first: journal.state !== 'applied' }));
  const local = pruneFormatBackups(dataDir, { policy, dryRun, now, shared,
    ...remove ? { remove } : {}, ...sizeOf ? { sizeOf } : {} });
  if (!graph) return { local, graph: null };
  if (!plan) return { local, graph: { pruned: [], kept: 0, error: graphError } };
  let result;
  if (dryRun) {
    const chosen = new Set(local.sharedPruned);
    result = { pruned: [...plan.pruned, ...plan.journals.filter((journal) => chosen.has(journal.applyId))
      .map((journal) => ({ ...journal, reason: SIZE }))], kept: plan.journals.length - chosen.size };
  } else {
    try {
      result = await graph.prune({ keep: policy.keep, applyIds: local.sharedPruned });
    } catch (error) {
      return { local, graph: { pruned: [], kept: 0, error: error.message } };
    }
  }
  const at = now().toISOString();
  const events = (result.pruned ?? []).map((entry) => ({ kind: 'pruned', store: 'graph', label: GRAPH_LABEL,
    backupRef: `undo journal ${entry.applyId}`, migrationId: entry.migrationId, bytes: entry.bytes,
    reason: entry.reason === SIZE ? sizeBudgetReason(policy) : entry.reason, at }));
  if (!dryRun) recordFormatOperations(dataDir, events);
  return { local, graph: { pruned: events, kept: result.kept ?? 0 } };
}

// The budget in one wording, said by `fuli migrate prune` and the console's
// data format page (web/src/i18n/messages/data-format.ts carries the same two
// strings; a test keeps them equal) and described in the release notes.
export const RETENTION_BUDGET_NOTICE = Object.freeze({
  zh: '保留预算：每个存储保留最近 {keep} 份格式备份，图谱保留最近 {keep} 份撤销日志；备份和日志合计最多约 {megabytes} MB，'
    + '超出时先清理最旧的。撤销或当前版本还需要的始终保留，即使因此超出预算。',
  en: 'Retention budget: each store keeps its newest {keep} format backups and the graph its newest {keep} undo '
    + 'journals; backups and journals together use at most about {megabytes} MB, the oldest going first. What an '
    + 'undo or the current version needs is always kept, even beyond the budget.'
});

export function retentionLines(policy) {
  const megabytes = String(Math.round(policy.maxBytes / (1024 * 1024)));
  return [RETENTION_BUDGET_NOTICE.zh, RETENTION_BUDGET_NOTICE.en].map((wording) => wording
    .replaceAll('{keep}', String(policy.keep)).replaceAll('{megabytes}', megabytes));
}

// The provider's reason for a journal the shared size budget chose.
const SIZE = 'over the shared size budget';
