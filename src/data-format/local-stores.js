import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { COORDINATOR_FORMAT } from '../../packages/roundtable/src/peer/coordinator-store.js';
import { NODE_FORMAT } from '../../packages/roundtable/src/peer/node-store.js';
import { ROUNDTABLE_FORMAT } from '../../packages/roundtable/src/roundtable/store.js';
import { inspectSqliteStore } from '../../packages/roundtable/src/storage/sqlite-format.js';
import { ADAPTIVE_RUNTIME_SETTINGS_VERSION } from '../adaptive-runtime/settings.js';
import { ADAPTIVE_RUNTIME_STATE_VERSION } from '../adaptive-runtime/state.js';
import { AGENT_APP_FORMAT } from '../agent-apps/store.js';
import { EMPLOYEE_MANAGEMENT_FORMAT } from '../employees/management-policy.js';
import { BINDING_TARGETS_MIGRATION } from '../external-knowledge/registry.js';
import { JUDGMENT_FORMAT } from '../judgment/store.js';
import { ROLE_WORK_FORMAT } from '../model-backends/role-work-store.js';
import { MODEL_USAGE_FORMAT } from '../model-backends/usage-ledger.js';
import { inspectJsonStore } from '../storage/json-format.js';
import { RUNTIME_SETTINGS_VERSION } from '../system/runtime-settings.js';
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
  ['runtime-settings.json', { store: 'runtime-settings', versions: [RUNTIME_SETTINGS_VERSION] }],
  ['adaptive-runtime-settings.json', { store: 'adaptive-runtime-settings', versions: [ADAPTIVE_RUNTIME_SETTINGS_VERSION] }],
  ['adaptive-runtime-state.json', { store: 'adaptive-runtime-state', versions: [ADAPTIVE_RUNTIME_STATE_VERSION] }],
  ['graph-runtime.json', { store: 'graph-runtime-config', versions: [1] }],
  ['runtime-configs/container.json', { store: 'graph-runtime-config', versions: [1] }],
  ['runtime-configs/native.json', { store: 'graph-runtime-config', versions: [1] }],
  ['recall-policy.json', { store: 'recall-policy', versions: [1] }],
  ['capture-policy.json', { store: 'capture-policy', versions: [1, 2] }],
  ['external-knowledge/bindings.json', { store: 'external-knowledge', versions: [1, 2], pendingFrom: 1,
    migration: BINDING_TARGETS_MIGRATION }],
  ['external-knowledge/conflict-policies.json', { store: 'external-knowledge-conflicts', versions: [1] }],
  ['model-secrets.json', { store: 'model-secrets', versions: [1] }],
  ['client-connection-observations.json', { store: 'client-connection-history', versions: [1] }]
];
// One small record per session.
const JSON_DIRECTORIES = [
  ['preference-delivery', { store: 'preference-session', versions: [1] }],
  ['capture-session-pause', { store: 'capture-session-pause', versions: [1] }]
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
    if (error?.code === 'ENOENT') return { store: format.store, kind: 'json', target: Math.max(...format.versions),
      version: null, ledger: [], steps: [], state: 'absent' };
    return { store: format.store, kind: 'json', target: Math.max(...format.versions), version: null, ledger: [],
      steps: [], state: 'unavailable', note: `cannot be listed (${error.code ?? error.message})` };
  }
  const records = names.map((name) => inspectJsonStore(join(directory, name), format));
  const counts = Object.fromEntries(STATE_ORDER.map((state) => [state, records.filter((r) => r.state === state).length])
    .filter(([, count]) => count));
  const state = STATE_ORDER.find((candidate) => counts[candidate]) ?? 'empty';
  return { store: format.store, kind: 'json-records', target: Math.max(...format.versions), version: null,
    ledger: [], steps: [], state, note: `${records.length} records: ${Object.entries(counts)
      .map(([name, count]) => `${count} ${name}`).join(', ') || 'none'}` };
}
