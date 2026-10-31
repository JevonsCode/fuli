import { randomUUID } from 'node:crypto';

import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { positiveInteger, requiredString } from '../validation/values.js';
import { probeServiceAddress } from './address.js';
import { createOutputTail } from './output-tail.js';
import { createProcessInspector, sameProcess } from './process-identity.js';
import { AgentServiceStore } from './store.js';

// The services port (服务管理, rec#11 D-71): every long-running service a FULI
// Agent started, with what it is for, whose it is and its live state.
// - An Agent registers and updates its own services (agent-report.js) and
//   never reads another's through them. Stopping one through FULI is the
//   person's, or anyone's 全部暂停 over every FLA's work (rec#11 D-85,
//   src/work-surfaces), which goes through the same stop below.
// - An Agent app's workbench is recorded by FULI's own runner (workbench).
// - The person reads them, stops one, deletes a record and clears a log in
//   the local console. A service FULI does not own is stopped only when the
//   PID the person confirmed is the recorded one and the OS still shows the
//   same process (start time, executable, command line); a workbench is
//   stopped through the Agent app runner, never by PID.
// The live state is checked on every read: the recorded PID and identity,
// then whether its address on this computer accepts a connection.
const LIMITS = Object.freeze({ id: 200, address: 300, purpose: 500, command: 1000 });
const MAX_PID = 2 ** 32 - 1;
const LOG_LIMIT = 200;
const AGENT_STATES = new Set(['running', 'stopped']);

export function createAgentServices({
  path = ':memory:', now = () => new Date(), inspector = createProcessInspector(), probe = probeServiceAddress,
  newId = () => `svc-${randomUUID()}`, stopWorkbench = null
} = {}) {
  const store = new AgentServiceStore(path);
  // What a running workbench wrote, by service id, until it ends.
  const tails = new Map();
  const at = () => now().toISOString();

  function existing(serviceId) {
    const record = store.get(requiredString(serviceId, 'serviceId', LIMITS.id));
    if (!record) throw new ApplicationError('service_not_found', 'No recorded service has this serviceId', { status: 404 });
    return record;
  }

  // What the OS shows of a PID an Agent reported; a PID that does not run is refused.
  async function processOf(pid) {
    const current = (await inspector.inspect([pid]))?.get(pid);
    if (!current) throw new InvalidInputError('pid is not a running process on this computer');
    return { pid, pidIdentity: current.identity, executable: current.executable, commandLine: current.commandLine };
  }

  // An Agent's own service: the same FLA, or without one the same client session.
  function assertOwner(record, owner) {
    const same = record.kind === 'agent_service' && (record.agentId && owner.agentId
      ? record.agentId === owner.agentId : record.sessionId === owner.sessionId && record.client === owner.client);
    if (!same) {
      throw new ApplicationError('not_service_owner', 'An Agent updates only services it registered itself', { status: 403 });
    }
  }

  async function register(owner, input) {
    const reported = reportedFields(input, { required: true });
    const found = reported.pid ? await processOf(reported.pid) : {};
    const known = found.pidIdentity ? store.list().find((record) => record.state === 'running'
      && record.pid === found.pid && record.pidIdentity === found.pidIdentity) : null;
    if (known) return { status: 'already_registered', service: agentView(known) };
    const time = at();
    const record = { serviceId: newId(), kind: 'agent_service', ...owner, appId: null, ...reported, ...found,
      state: 'running', startedAt: time, updatedAt: time };
    store.transaction(() => {
      store.insert(record);
      store.appendLog({ serviceId: record.serviceId, at: time, action: 'registered', actor: 'agent',
        detail: { ...ownerDetail(owner), pid: record.pid ?? null, command: record.command ?? null, address: record.address ?? null } });
    });
    return { status: 'registered', service: agentView(store.get(record.serviceId)) };
  }

  async function update(owner, input) {
    const record = existing(input?.serviceId);
    assertOwner(record, owner);
    const reported = reportedFields(input, { required: false });
    const state = input.state === undefined ? null : input.state;
    if (state !== null && !AGENT_STATES.has(state)) throw new InvalidInputError('state must be running or stopped');
    const found = reported.pid && reported.pid !== record.pid ? await processOf(reported.pid) : {};
    const time = at();
    const changes = { ...reported, ...found, updatedAt: time,
      ...(state === 'stopped' && record.state !== 'stopped' ? { state, stoppedAt: time, stopReason: 'stopped_by_agent' } : {}),
      ...(state === 'running' && record.state !== 'running' ? { state, stoppedAt: null, stopReason: null, startedAt: time } : {}) };
    const action = changes.state === 'stopped' ? 'stopped' : changes.state === 'running' ? 'restarted' : 'updated';
    store.transaction(() => {
      store.update(record.serviceId, changes);
      store.appendLog({ serviceId: record.serviceId, at: time, action, actor: 'agent',
        detail: { ...ownerDetail(owner), changed: Object.keys(reported) } });
    });
    return { status: action, service: agentView(store.get(record.serviceId)) };
  }

  // Every record with its live state; one that was running and no longer
  // runs is recorded as stopped, with the evidence, once.
  async function list() {
    const records = store.list();
    const inspected = await inspector.inspect(records.map(({ pid }) => pid).filter(Boolean));
    const services = await Promise.all(records.map(async (record) => {
      const live = liveState(record, inspected, await probe(record.address));
      if (live.state === 'stopped' && record.state === 'running') return { ...foundStopped(record, live), live };
      return { ...record, live };
    }));
    return { services, checkedAt: at() };
  }

  function foundStopped(record, live) {
    const time = at();
    const changes = { state: 'stopped', stoppedAt: time, stopReason: 'not_running', updatedAt: time };
    store.transaction(() => {
      store.update(record.serviceId, changes);
      store.appendLog({ serviceId: record.serviceId, at: time, action: 'found_stopped', actor: 'fuli',
        detail: { process: live.process, port: live.port } });
    });
    return { ...record, ...changes };
  }

  function log({ serviceId }) {
    const record = existing(serviceId);
    return { serviceId: record.serviceId, entries: store.logs(record.serviceId, LOG_LIMIT),
      liveOutput: tails.get(record.serviceId)?.text() ?? null };
  }

  // The person stops a running service, or a 全部暂停 does (actor agent when
  // an Agent asked for it). A workbench goes through its runner; another
  // process only when it is still exactly the one recorded and the PID is the
  // one confirmed.
  async function stop({ serviceId, pid, actor = 'person' }) {
    const record = existing(serviceId);
    const confirmed = positiveInteger(pid, 'pid', MAX_PID);
    if (record.kind === 'workbench') {
      // Only the instance this record names; an ended one is never a reason to stop the app's current one.
      if (record.state !== 'running') return { status: 'already_stopped', service: record };
      if (!stopWorkbench) throw new ApplicationError('agent_apps_unavailable', 'Agent apps need a local FULI installation', { status: 503 });
      store.transaction(() => store.appendLog({ serviceId: record.serviceId, at: at(), action: 'stop_requested', actor, detail: null }));
      await stopWorkbench(record.appId);
      return { status: 'stopped', service: store.get(record.serviceId) };
    }
    if (!record.pid) {
      throw new ApplicationError('no_recorded_process', 'This service has no recorded process; stop it where it was started', { status: 409 });
    }
    if (confirmed !== record.pid) {
      throw new ApplicationError('pid_not_confirmed', 'The confirmed pid is not the recorded one; read the list again', { status: 409 });
    }
    const inspected = await inspector.inspect([record.pid]);
    if (!inspected) {
      throw new ApplicationError('process_unreadable', 'FULI could not read this computer\'s processes, so it stopped nothing; try again',
        { status: 409 });
    }
    const current = inspected.get(record.pid);
    if (!current) return { status: 'already_stopped', service: foundStopped(record, { process: 'gone', port: null }) };
    const verdict = sameProcess(record, current) ? await inspector.terminate(record) : 'mismatch';
    const time = at();
    if (verdict === 'mismatch') {
      store.transaction(() => store.appendLog({ serviceId: record.serviceId, at: time, action: 'stop_refused', actor,
        detail: { pid: record.pid, reason: 'process_changed' } }));
      throw new ApplicationError('process_changed', `Process ${record.pid} is no longer the recorded one (its start time, `
        + 'executable or command line differ), so FULI did not stop it (进程已不是登记的那个，未结束)', { status: 409 });
    }
    store.transaction(() => {
      if (verdict === 'stopped') store.update(record.serviceId, { state: 'stopped', stoppedAt: time, stopReason: `stopped_by_${actor}`, updatedAt: time });
      store.appendLog({ serviceId: record.serviceId, at: time, action: verdict === 'stopped' ? 'stopped' : 'stop_requested',
        actor, detail: { pid: record.pid, commandLine: record.commandLine } });
    });
    return { status: verdict, service: store.get(record.serviceId) };
  }

  function remove({ serviceId }) {
    const record = existing(serviceId);
    store.transaction(() => store.delete(record.serviceId));
    tails.delete(record.serviceId);
    return { status: 'deleted', serviceId: record.serviceId };
  }

  function clearLog({ serviceId }) {
    const record = existing(serviceId);
    return { status: 'cleared', serviceId: record.serviceId, entries: store.transaction(() => store.clearLogs(record.serviceId)) };
  }

  // The Agent app runner's record of each workbench instance it starts
  // (src/agent-apps/instances.js). Recording never fails the app's lifecycle.
  const workbench = {
    output(instanceId) {
      const tail = createOutputTail();
      tails.set(workbenchId(instanceId), tail);
      return tail;
    },
    started({ appId, instanceId, personalSpaceId, agentId, purpose, command, pid }) {
      const serviceId = workbenchId(instanceId);
      const time = at();
      store.transaction(() => {
        store.insert({ serviceId, kind: 'workbench', personalSpaceId, agentId, appId, client: 'fuli', purpose, command, pid,
          state: 'running', startedAt: time, updatedAt: time });
        store.appendLog({ serviceId, at: time, action: 'started', actor: 'fuli', detail: { appId, instanceId, pid } });
      });
      // The identity is read after the start, so the app is not held up by it.
      return inspector.inspect([pid]).then((found) => {
        const current = found?.get(pid);
        if (current && store.get(serviceId)) {
          store.update(serviceId, { pidIdentity: current.identity, executable: current.executable, commandLine: current.commandLine });
        }
      });
    },
    exited({ instanceId, exit }) {
      const serviceId = workbenchId(instanceId);
      if (!store.get(serviceId)) return;
      store.transaction(() => store.appendLog({ serviceId, at: at(), action: exit.category === 'exited' ? 'exited' : 'crashed',
        actor: 'fuli', detail: exit }));
    },
    ended({ instanceId, reason }) {
      const serviceId = workbenchId(instanceId);
      const output = tails.get(serviceId)?.text();
      tails.delete(serviceId);
      if (!store.get(serviceId)) return;
      const time = at();
      store.transaction(() => {
        store.update(serviceId, { state: 'stopped', stoppedAt: time, stopReason: reason, updatedAt: time });
        if (output) store.appendLog({ serviceId, at: time, action: 'output', actor: 'fuli', detail: { text: output } });
        store.appendLog({ serviceId, at: time, action: 'stopped', actor: 'fuli', detail: { reason } });
      });
    }
  };

  return { register, update, list, log, stop, remove, clearLog, workbench, close: () => store.close() };
}

const workbenchId = (instanceId) => `workbench-${instanceId}`;

// What an Agent reports of a service; purpose is required when it registers one.
function reportedFields(input, { required }) {
  const given = (name) => input?.[name] !== undefined;
  const fields = {
    address: given('address') ? requiredString(input.address, 'address', LIMITS.address) : undefined,
    purpose: required || given('purpose') ? requiredString(input?.purpose, 'purpose', LIMITS.purpose) : undefined,
    command: given('command') ? requiredString(input.command, 'command', LIMITS.command) : undefined,
    pid: given('pid') ? positiveInteger(input.pid, 'pid', MAX_PID) : undefined
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

// Whether the recorded process still runs (alive, gone, replaced by another
// process under the PID, unverified when no identity was recorded, unknown
// when the OS could not be asked) and whether its address accepts a
// connection; the process decides when it can, the port otherwise.
function liveState(record, inspected, port) {
  let process = null;
  if (record.pid) {
    const current = inspected?.get(record.pid);
    process = inspected === null ? 'unknown' : !current ? 'gone' : !record.pidIdentity ? 'unverified'
      : current.identity === record.pidIdentity ? 'alive' : 'replaced';
  }
  // A closed port alone never says a recorded process stopped.
  const state = process === 'alive' ? 'running' : ['gone', 'replaced'].includes(process) ? 'stopped'
    : port === 'open' ? 'running' : port === 'closed' && !record.pid ? 'stopped' : 'unknown';
  return { state, process, port };
}

const ownerDetail = (owner) => ({ agentId: owner.agentId ?? null, projectId: owner.projectId ?? null,
  client: owner.client ?? null, sessionId: owner.sessionId ?? null });

// What an Agent sees of its own service: no command line or identity the OS reported.
function agentView(record) {
  const { serviceId, state, address, purpose, command, pid, startedAt, stoppedAt } = record;
  return { serviceId, state, address, purpose, command, pid, startedAt, stoppedAt };
}

