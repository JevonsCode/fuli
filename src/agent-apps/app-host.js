import { randomBytes } from 'node:crypto';

import { ApplicationError } from '../app/application-error.js';
import { createAppDataFs, isDataPath } from './app-data-fs.js';
import { appConflict, appForbidden } from './errors.js';

const CALL_ID_BYTES = 8;
// A write tool holding the gate longer than this is recorded (D-28.17).
const SLOW_WRITE_MS = 10_000;
// Three refused scopes within ten minutes seal the instance (D-28.14).
const SCOPE_VIOLATION_LIMIT = 3;
const SCOPE_VIOLATION_WINDOW_MS = 10 * 60_000;

// The App Host port: how an instance this process hosts calls a host tool.
// A transport (the instance's host socket, rec#7 PR③) parses a request and
// calls callTool; authorizeCall is its first half, which checks everything
// before the call is queued:
// 1. the tool exists for apps and carries no egress, model or launch mark;
// 2. the token is current for a running instance this process hosts, and its
//    version grants the tool (app-tokens.js);
// 3. scope (D-28.14): a scope field set to anything but the app's own value,
//    or a data path outside data/<appId>, is refused (scope_violation, with
//    the field) and recorded; only then does the host set the scope fields
//    itself. Nothing is silently overwritten.
// run() then executes the tool. A write tool runs whole inside the app's write
// gate (D-28.17), after checking that its instance is still current and not
// sealed, so a call queued behind a seal writes nothing. Every call gets its
// own data port (app-data-fs.js), closed as soon as the call settles; the host
// waits for the port's operations to drain, checks the owner fence once more
// in the commit transaction and only then lets the gate go and returns the
// result (D-28.26, D-28.31). A read tool runs outside the gate; if its
// instance was sealed meanwhile its result is discarded.
export function createAppHost(context) {
  const { store, leases, gates, instances, now } = context;

  function authorizeCall({ token, toolName, input = {} }) {
    const tool = context.hostTools().get(toolName);
    if (!tool || tool.marks.length) {
      throw new ApplicationError('tool_not_permitted', `Apps may not call ${toolName}`, { status: 403 });
    }
    const grant = instances.verifyToken({ token, toolName });
    const hosted = instances.hosted(grant.appId);
    if (hosted?.instanceId !== grant.instanceId) {
      throw appConflict('instance_superseded', 'This process does not host that instance');
    }
    const callId = `call-${randomBytes(CALL_ID_BYTES).toString('hex')}`;
    const scoped = scopedInput({ grant, hosted, tool, toolName, input });
    const call = { grant, lease: hosted.lease, tool, toolName, input: scoped, callId };
    return { callId, run: () => (tool.effect === 'write' ? runWrite(call) : runRead(call)) };
  }

  function scopedInput({ grant, hosted, tool, toolName, input }) {
    const trusted = { personalSpaceId: grant.personalSpaceId, agentId: grant.agentId, appId: grant.appId };
    const violated = tool.scopeFields.find((field) => Object.hasOwn(input, field) && input[field] !== trusted[field])
      ?? tool.dataPathFields.find((field) => Object.hasOwn(input, field) && !isDataPath(input[field]));
    if (violated !== undefined) {
      const count = store.transaction(() => {
        if (!leases.owns(hosted.lease)) return 0;
        store.recordEvent({ appId: grant.appId, at: now(), action: 'scope_violation',
          detail: { toolName, field: violated, instanceId: grant.instanceId } });
        const since = new Date(context.clock().getTime() - SCOPE_VIOLATION_WINDOW_MS).toISOString();
        return store.countEvents(grant.appId, 'scope_violation', since);
      });
      // The refusal stands either way; a seal that fails shows in the instance state.
      if (count >= SCOPE_VIOLATION_LIMIT) instances.seal(grant.appId, 'scope_violations').catch(() => {});
      throw appForbidden('scope_violation', `${toolName} was called outside this app's scope (${violated})`,
        { toolName, field: violated });
    }
    return { ...input, ...Object.fromEntries(tool.scopeFields.map((field) => [field, trusted[field]])) };
  }

  function current({ grant }) {
    const instance = store.instance(grant.appId);
    if (!instance || instance.instanceId !== grant.instanceId || instance.generation !== grant.generation) return 'instance_superseded';
    return instance.sealedAt ? 'app_sealed' : null;
  }

  function runWrite(call) {
    const { grant, lease, toolName, callId } = call;
    return gates.run(grant.appId, { taskId: callId, toolName, since: now() }, async () => {
      const ended = current(call);
      if (ended) {
        recordIfOwned(lease, grant.appId, 'write_fenced', { toolName, callId, reason: ended });
        throw appConflict(ended, 'This app instance ended before the write ran; nothing was written');
      }
      leases.assertOwned(lease);
      const started = context.clock().getTime();
      const outcome = await runWithPort(call);
      const elapsed = context.clock().getTime() - started;
      if (elapsed > SLOW_WRITE_MS) recordIfOwned(lease, grant.appId, 'slow_write_tool', { toolName, callId, elapsed });
      store.transaction(() => {
        if (!leases.owns(lease)) {
          throw appConflict('write_fenced_after_fs', 'Another FULI process took over this app during the write; '
            + 'nothing more is recorded', { op: toolName });
        }
        store.recordEvent({ appId: grant.appId, at: now(), action: 'write_committed', detail: { toolName, callId } });
      });
      return delivered(outcome);
    });
  }

  async function runRead(call) {
    const outcome = await runWithPort(call);
    if (current(call) || store.instance(call.grant.appId).state !== 'running') {
      throw appConflict('result_discarded', 'The app instance was stopped while this read ran; its result is discarded');
    }
    return delivered(outcome);
  }

  // Settle → close the port (no new operation) → drain what was started.
  async function runWithPort({ grant, lease, tool, toolName, input, callId }) {
    const data = createAppDataFs({ callId, toolName, root: context.dataOf(grant.appId), fs: context.dataFs,
      assertOwned: () => leases.assertOwned(lease),
      onClosedUse: (detail) => recordIfOwned(lease, grant.appId, 'write_port_closed', detail) });
    const running = Promise.resolve().then(() => tool.run(input, { dataFs: data.port }));
    // Registered first, so the port closes in the first reaction to the settlement.
    const settled = running.then((value) => { data.close(); return { value }; },
      (error) => { data.close(); return { error }; });
    const outcome = await settled;
    if (data.pending() > 0) {
      recordIfOwned(lease, grant.appId, 'write_tool_detached_io', { toolName, callId, pending: data.pending() });
    }
    await data.drained();
    return outcome;
  }

  function recordIfOwned(lease, appId, action, detail) {
    store.transaction(() => {
      if (leases.mayRecord(lease)) store.recordEvent({ appId, at: now(), action, detail });
    });
  }

  return {
    authorizeCall,
    callTool: async (request) => authorizeCall(request).run()
  };
}

function delivered({ value, error }) {
  if (error) throw error;
  return value;
}
