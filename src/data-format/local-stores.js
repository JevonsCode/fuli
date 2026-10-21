import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { COORDINATOR_FORMAT } from '../../packages/roundtable/src/peer/coordinator-store.js';
import { NODE_FORMAT } from '../../packages/roundtable/src/peer/node-store.js';
import { ROUNDTABLE_FORMAT } from '../../packages/roundtable/src/roundtable/store.js';
import { inspectSqliteStore } from '../../packages/roundtable/src/storage/sqlite-format.js';
import { ADAPTIVE_RUNTIME_SETTINGS_FORMAT } from '../adaptive-runtime/settings.js';
import { ADAPTIVE_RUNTIME_STATE_FORMAT } from '../adaptive-runtime/state.js';
import { AGENT_APP_FORMAT } from '../agent-apps/store.js';
import { EMPLOYEE_MANAGEMENT_FORMAT } from '../employees/management-policy.js';
import { PREFERENCE_SESSION_FORMAT } from '../conversations/preference-session.js';
import { TRANSCRIPT_CAPTURE_FORMAT } from '../conversations/transcript-capture-gap.js';
import { CONFLICT_POLICY_FORMAT } from '../external-knowledge/conflict-policy.js';
import { EXTERNAL_KNOWLEDGE_FORMAT } from '../external-knowledge/registry.js';
import { CAPTURE_POLICY_FORMAT } from '../graphiti/capture-policy.js';
import { CAPTURE_SESSION_PAUSE_FORMAT } from '../graphiti/capture-session-pause.js';
import { RECALL_POLICY_FORMAT } from '../graphiti/recall-policy.js';
import { GRAPH_RUNTIME_CONFIG_FORMAT } from '../graphiti/runtime-config.js';
import { JUDGMENT_FORMAT } from '../judgment/store.js';
import { ROLE_WORK_FORMAT } from '../model-backends/role-work-store.js';
import { MODEL_USAGE_FORMAT } from '../model-backends/usage-ledger.js';
import { inspectJsonStore } from '../storage/json-format.js';
import { MODEL_SECRETS_FORMAT } from '../model-backends/secret-store.js';
import { CLIENT_CONNECTION_HISTORY_FORMAT } from '../system/client-connection-status.js';
import { RUNTIME_SETTINGS_FORMAT } from '../system/runtime-settings.js';
import { TASK_SCHEDULE_FORMAT } from '../task-schedules/store.js';

// Every FULI store kept in one data directory, by the path its owner opens
// (rec#17 D-09). Labels are relative to the data directory, so a report names
// no user path. The graph is reported by its provider, which owns it.
const SQLITE_STORES = [
  ['judgment.sqlite', JUDGMENT_FORMAT],
  ['task-schedules.sqlite', TASK_SCHEDULE_FORMAT],
  ['agent-roundtable.sqlite', ROUNDTABLE_FORMAT],
  ['model-usage.sqlite', MODEL_USAGE_FORMAT],
  ['role-work.sqlite', ROLE_WORK_FORMAT],
  ['agent-apps/registry.sqlite', AGENT_APP_FORMAT],
  ['employees/data/management.sqlite', EMPLOYEE_MANAGEMENT_FORMAT],
  ['peer/node.sqlite', NODE_FORMAT],
  ['peer/coordinator.sqlite', COORDINATOR_FORMAT]
];
const JSON_STORES = [
  ['runtime-settings.json', RUNTIME_SETTINGS_FORMAT],
  ['adaptive-runtime-settings.json', ADAPTIVE_RUNTIME_SETTINGS_FORMAT],
  ['adaptive-runtime-state.json', ADAPTIVE_RUNTIME_STATE_FORMAT],
  ['graph-runtime.json', GRAPH_RUNTIME_CONFIG_FORMAT],
  ['runtime-configs/container.json', GRAPH_RUNTIME_CONFIG_FORMAT],
  ['runtime-configs/native.json', GRAPH_RUNTIME_CONFIG_FORMAT],
  ['recall-policy.json', RECALL_POLICY_FORMAT],
  ['capture-policy.json', CAPTURE_POLICY_FORMAT],
  ['external-knowledge/bindings.json', EXTERNAL_KNOWLEDGE_FORMAT],
  ['external-knowledge/conflict-policies.json', CONFLICT_POLICY_FORMAT],
  ['model-secrets.json', MODEL_SECRETS_FORMAT],
  ['client-connection-observations.json', CLIENT_CONNECTION_HISTORY_FORMAT]
];
// One small record per session.
const JSON_DIRECTORIES = [
  ['preference-delivery', PREFERENCE_SESSION_FORMAT],
  ['transcript-capture', TRANSCRIPT_CAPTURE_FORMAT],
  // Session records and the default for new sessions (default.json).
  ['capture-session-pause', CAPTURE_SESSION_PAUSE_FORMAT],
  // The default each session started under (rec#5 C3b), one record per session.
  ['capture-session-pause/pins/on', CAPTURE_SESSION_PAUSE_FORMAT],
  ['capture-session-pause/pins/off', CAPTURE_SESSION_PAUSE_FORMAT]
];
// The worst state of a directory's records names the directory's state.
const STATE_ORDER = ['unavailable', 'newer_format', 'half_applied', 'pending_confirmation', 'unsupported',
  'unreadable', 'upgrade_on_open', 'unversioned', 'current', 'empty', 'absent'];

// What each store would be on open, read without changing a byte.
export function inspectLocalStores(dataDir) {
  return [
    ...SQLITE_STORES.map(([label, format]) => ({ label, ...inspectSqliteStore(join(dataDir, label), format) })),
    ...JSON_STORES.map(([label, format]) => ({ label, ...inspectJsonStore(join(dataDir, label), format) })),
    ...JSON_DIRECTORIES.map(([label, format]) => ({ label, ...inspectJsonDirectory(join(dataDir, label), format) }))
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
