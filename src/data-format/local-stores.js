import { CLIENT_PACK_FORMAT } from '../setup/agents/client-pack-store.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { COORDINATOR_FORMAT } from '../../packages/roundtable/src/peer/coordinator-store.js';
import { NODE_FORMAT } from '../../packages/roundtable/src/peer/node-store.js';
import { ROUNDTABLE_FORMAT } from '../../packages/roundtable/src/roundtable/store.js';
import { inspectSqliteStore } from '../../packages/roundtable/src/storage/database-format.js';
import { ADAPTIVE_RUNTIME_SETTINGS_FORMAT } from '../adaptive-runtime/settings.js';
import { ADAPTIVE_RUNTIME_STATE_FORMAT } from '../adaptive-runtime/state.js';
import { AGENT_APP_FORMAT } from '../agent-apps/store.js';
import { AGENT_SERVICES_FORMAT } from '../agent-services/store.js';
import { AGENT_WORKFLOWS_FORMAT } from '../agent-workflows/store.js';
import { AGENT_AVATARS_FORMAT } from '../agent-avatars/store.js';
import { WORK_SURFACES_FORMAT } from '../work-surfaces/store.js';
import { EMPLOYEE_MANAGEMENT_FORMAT } from '../employees/management-policy.js';
import { JEFA_BOARD_FORMAT } from '../employees/builtin/jefa/board-store.js';
import { PREFERENCE_SESSION_FORMAT } from '../conversations/preference-session.js';
import { TRANSCRIPT_CAPTURE_FORMAT, TRANSCRIPT_TURN_HOLD_FORMAT } from '../conversations/transcript-capture-gap.js';
import { CONFLICT_POLICY_FORMAT } from '../external-knowledge/conflict-policy.js';
import { EXTERNAL_KNOWLEDGE_FORMAT } from '../external-knowledge/registry.js';
import { AGENT_ACCESS_POLICY_FORMAT } from '../graphiti/agent-access-policy.js';
import { CAPTURE_CHANGE_PREVIEW_FORMAT } from '../graphiti/capture-change-confirmation.js';
import { CAPTURE_ONBOARDING_FORMAT } from '../graphiti/capture-onboarding.js';
import { CAPTURE_POLICY_FORMAT } from '../graphiti/capture-policy.js';
import { CAPTURE_SESSION_PAUSE_FORMAT } from '../graphiti/capture-session-pause.js';
import { RECALL_POLICY_FORMAT } from '../graphiti/recall-policy.js';
import { GRAPH_RUNTIME_CONFIG_FORMAT } from '../graphiti/runtime-config.js';
import { JUDGMENT_FORMAT } from '../judgment/store.js';
import { HARD_DELETE_LEDGER_FILE, HARD_DELETE_LEDGER_FORMAT } from '../knowledge-hard-delete/delete-ledger.js';
import { MODEL_BACKEND_CONFIG_FORMAT } from '../model-backends/config.js';
import { MODEL_EVALUATIONS_FORMAT } from '../model-backends/evaluation-record.js';
import { MODEL_TRUST_FORMAT } from '../model-backends/role-trust.js';
import { ROLE_WORK_FORMAT } from '../model-backends/role-work-store.js';
import { MODEL_SETTINGS_HISTORY_FORMAT } from '../model-backends/settings-history.js';
import { ROLE_SUGGESTIONS_FORMAT } from '../model-backends/suggestion-log.js';
import { MODEL_USAGE_FORMAT } from '../model-backends/usage-ledger.js';
import { inspectJsonStore } from '../storage/json-format.js';
import { APPLY_RECEIPTS_FORMAT } from './apply-receipts.js';
import { FORMAT_OPERATIONS_FORMAT } from './operations-log.js';
import { FORMAT_NOTICE_DELIVERY_FORMAT } from './notice-delivery.js';
import { MODEL_SECRETS_FORMAT } from '../model-backends/secret-store.js';
import { STANDING_ASSIGNMENTS_FORMAT } from '../standing-assignments/store.js';
import { CLIENT_CONNECTION_HISTORY_FORMAT } from '../system/client-connection-status.js';
import { RUNTIME_SETTINGS_FORMAT } from '../system/runtime-settings.js';
import { CLIENT_LINKS_STATE_FORMAT } from '../client-links/registry.js';
import { SESSION_CLIENT_FORMAT } from '../agent-kits/session-clients.js';

// Every FULI store kept in one data directory, by the path its owner opens
// (rec#17 D-09). Labels are relative to the data directory, so a report names
// no user path. The graph is reported by its provider, which owns it. Built
// on use: the receipt reaches this module from modules that declare these
// formats, so the lists may not be read while those are still loading.
const sqliteStores = () => [
  ['judgment.sqlite', JUDGMENT_FORMAT],
  ['standing-assignments.sqlite', STANDING_ASSIGNMENTS_FORMAT],
  ['agent-roundtable.sqlite', ROUNDTABLE_FORMAT],
  ['model-usage.sqlite', MODEL_USAGE_FORMAT],
  ['role-work.sqlite', ROLE_WORK_FORMAT],
  // What Astro, Bole and Jefa showed after asking their own model; suggestions only.
  ['role-suggestions.sqlite', ROLE_SUGGESTIONS_FORMAT],
  // Each role's 「只给建议」 choice and trust-warning acknowledgement (rec#10 D-36); absent until the first change.
  ['model-trust.sqlite', MODEL_TRUST_FORMAT],
  // What changed in the model settings and execution modes, and when (rec#11 D-42); never pruned.
  ['model-settings-history.sqlite', MODEL_SETTINGS_HISTORY_FORMAT],
  ['agent-apps/registry.sqlite', AGENT_APP_FORMAT],
  // The services FULI Agents started and their logs (rec#11 D-71); absent until the first one.
  ['agent-services.sqlite', AGENT_SERVICES_FORMAT],
  // Each Agent's own workflows, their versions, the person's decisions and runs (rec#60 D-78).
  ['agent-workflows.sqlite', AGENT_WORKFLOWS_FORMAT],
  // Each Agent's look as the person chose it, every earlier choice kept (rec#11 D-89).
  ['agent-avatars.sqlite', AGENT_AVATARS_FORMAT],
  // 全部暂停 snapshots of every FLA's work surfaces and each pause and resume (rec#11 D-85).
  ['work-surfaces.sqlite', WORK_SURFACES_FORMAT],
  ['employees/data/management.sqlite', EMPLOYEE_MANAGEMENT_FORMAT],
  // Jefa's built-in task board: tasks, their revisions, sharing and session titles.
  ['employees/data/jefa/board.sqlite', JEFA_BOARD_FORMAT],
  ['peer/node.sqlite', NODE_FORMAT],
  ['peer/coordinator.sqlite', COORDINATOR_FORMAT]
];
const jsonStores = () => [
  ['client-packs.json', CLIENT_PACK_FORMAT],
  ['runtime-settings.json', RUNTIME_SETTINGS_FORMAT],
  ['adaptive-runtime-settings.json', ADAPTIVE_RUNTIME_SETTINGS_FORMAT],
  ['adaptive-runtime-state.json', ADAPTIVE_RUNTIME_STATE_FORMAT],
  ['graph-runtime.json', GRAPH_RUNTIME_CONFIG_FORMAT],
  ['runtime-configs/container.json', GRAPH_RUNTIME_CONFIG_FORMAT],
  ['runtime-configs/native.json', GRAPH_RUNTIME_CONFIG_FORMAT],
  ['recall-policy.json', RECALL_POLICY_FORMAT],
  ['agent-access-policy.json', AGENT_ACCESS_POLICY_FORMAT],
  ['capture-policy.json', CAPTURE_POLICY_FORMAT],
  // An Agent's previewed capture changes waiting for the person's answer (rec#5 C4-2).
  ['capture-change-previews.json', CAPTURE_CHANGE_PREVIEW_FORMAT],
  // A new installation's open question about where FULI records, then its answer (rec#5 C10).
  ['capture-onboarding.json', CAPTURE_ONBOARDING_FORMAT],
  ['external-knowledge/bindings.json', EXTERNAL_KNOWLEDGE_FORMAT],
  ['external-knowledge/conflict-policies.json', CONFLICT_POLICY_FORMAT],
  // The built-in Agents' model settings, saved from the console (rec#8); keys are only named here.
  ['model-backends.json', MODEL_BACKEND_CONFIG_FORMAT],
  ['model-secrets.json', MODEL_SECRETS_FORMAT],
  ['client-connection-observations.json', CLIENT_CONNECTION_HISTORY_FORMAT],
  ['format-operations.json', FORMAT_OPERATIONS_FORMAT],
  ['format-notice-delivery.json', FORMAT_NOTICE_DELIVERY_FORMAT],
  ['format-apply-receipts.json', APPLY_RECEIPTS_FORMAT],
  // A person's permanent deletes, content-free: their state and the fence local stores check (rec#5 C9).
  [HARD_DELETE_LEDGER_FILE, HARD_DELETE_LEDGER_FORMAT],
  // Evaluations of a role's model run on this computer, shown on the settings page (rec#10 D-36.6).
  ['model-evaluations.json', MODEL_EVALUATIONS_FORMAT],
  // The applied client link manifest, its auto-update switch and what each update changed.
  ['client-links.json', CLIENT_LINKS_STATE_FORMAT]
];
// One small record per session.
const jsonDirectories = () => [
  ['preference-delivery', PREFERENCE_SESSION_FORMAT],
  ['transcript-capture', TRANSCRIPT_CAPTURE_FORMAT],
  // An unresolved turn kept where its session's ledger could not be written (rec#15).
  ['transcript-turn-holds', TRANSCRIPT_TURN_HOLD_FORMAT],
  // Session records and the default for new sessions (default.json).
  ['capture-session-pause', CAPTURE_SESSION_PAUSE_FORMAT],
  // The default each session started under (rec#5 C3b), one record per session.
  ['capture-session-pause/pins/on', CAPTURE_SESSION_PAUSE_FORMAT],
  ['capture-session-pause/pins/off', CAPTURE_SESSION_PAUSE_FORMAT],
  // Which client each session ran in, as the session launcher classified it (rec#11 D-79).
  ['session-clients', SESSION_CLIENT_FORMAT]
];
// The worst state of a directory's records names the directory's state.
const STATE_ORDER = ['unavailable', 'newer_format', 'half_applied', 'pending_confirmation', 'unsupported',
  'unreadable', 'upgrade_on_open', 'unversioned', 'current', 'empty', 'absent'];

// The single-file stores of one data directory: each kind's engine can
// preview, apply, undo and restore them (migration-plan.js).
export function localStoreFiles(dataDir) {
  return [
    ...sqliteStores().map(([label, format]) => ({ label, kind: 'sqlite', path: join(dataDir, label), format })),
    ...jsonStores().map(([label, format]) => ({ label, kind: 'json', path: join(dataDir, label), format }))
  ];
}

// What each store would be on open, read without changing a byte.
export function inspectLocalStores(dataDir) {
  return [
    ...sqliteStores().map(([label, format]) => ({ label, ...inspectSqliteStore(join(dataDir, label), format) })),
    ...jsonStores().map(([label, format]) => ({ label, ...inspectJsonStore(join(dataDir, label), format) })),
    ...jsonDirectories().map(([label, format]) => ({ label, ...inspectJsonDirectory(join(dataDir, label), format) }))
  ];
}

function inspectJsonDirectory(directory, format) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { store: format.store, kind: 'json', target: format.supported,
      version: null, ledger: [], steps: [], state: 'absent' };
    return { store: format.store, kind: 'json', target: format.supported, version: null, ledger: [],
      steps: [], state: 'unavailable', note: `cannot be listed (${error.code ?? error.message})` };
  }
  const records = names.map((name) => inspectJsonStore(join(directory, name), format));
  const counts = Object.fromEntries(STATE_ORDER.map((state) => [state, records.filter((r) => r.state === state).length])
    .filter(([, count]) => count));
  const state = STATE_ORDER.find((candidate) => counts[candidate]) ?? 'empty';
  return { store: format.store, kind: 'json-records', target: format.supported, version: null,
    ledger: [], steps: [], state, note: `${records.length} records: ${Object.entries(counts)
      .map(([name, count]) => `${count} ${name}`).join(', ') || 'none'}` };
}
