import { isParticipantJob, MOVE_ACTION } from './move-wire.js';
import moveProblems from './move-problems.json' with { type: 'json' };
import { setTimeout as delay } from 'node:timers/promises';

import { ownerExport } from './owner-export.js';
import { validOwnerCall } from './owner-channel.js';
import { inventoryPages } from './owner-inventory.js';
import { RUNNER_PATHS } from './protocol.js';

// Runs only on a follower that has negotiated the owner protocol. It uses
// the existing outbound pinned connection. Every operation is checked again
// where it runs; callers cannot supply a URL, shell command or MCP tool name.
export function startOwnerWorker({ connection, descriptor, projects, identity, exportScope, catalog, dispatch = null,
  installPermit, movePhase = null, enroll = null, confirmGreeting = null, generation = () => null, now = Date.now, retryMs = 15_000, reportMs = 60_000 }) {
  const stopping = new AbortController();
  const { signal } = stopping;
  function owns(job) {
    const local = descriptor();
    if (!local || job.spaceId !== local.spaceId || job.owner !== identity || local.device !== identity ||
      signal.aborted || job.expiresAt <= now()) return false;
    if (job.action === MOVE_ACTION) return Boolean(movePhase) && isParticipantJob(job, local.authority);
    if (job.action === 'catalog') return job.scope === 'global' && job.generation === 1;
    if (!projects().includes(job.scope.slice('project:'.length))) return false;
    const current = generation(local, job.scope);
    if (current != null) return current === job.generation;
    // Existing projects can supply a proof during initial inventory. Until a
    // generation is installed, no business action may run.
    return job.generation === 1 && ['inventory','export_digest','export_chunk'].includes(job.action);
  }
  const exportPart = ownerExport({ owns, exportScope });
  async function serve(local) {
    const greeting = await connection.hello();
    if (greeting?.ownerProtocol !== 1 || greeting.spaceId !== local.spaceId || greeting.fingerprint !== local.authority) return;
    if (confirmGreeting && !confirmGreeting(greeting, local)) return;
    let result = null;
    let lastInventory = null;
    let inspected = -Infinity;
    let firstPoll = true;
    while (!signal.aborted && descriptor()?.authority === local.authority) {
      if ((!result || lastInventory === null) && now() - inspected >= reportMs) {
        inspected = now();
        const ids = projects().sort();
        const key = JSON.stringify(ids);
        if (key !== lastInventory) {
          for (const page of inventoryPages(local.spaceId, ids)) {
            const reply = await connection.postJson(RUNNER_PATHS.hello, page, { signal });
            if (reply.status !== 200 || !reply.body?.ok) return;
          }
          lastInventory = key;
        }
      }
      const reply = await connection.postJson(RUNNER_PATHS.ownerPoll, { version: 1, spaceId: local.spaceId, result, ...(firstPoll ? { connected: true } : {}) },
        { signal, timeoutMs: 20_000, maxBytes: 64 * 1024 });
      if (reply.status !== 200 || !reply.body || signal.aborted) return;
      firstPoll = false;
      if (reply.body.needInventory) { lastInventory = null; inspected = -Infinity; }
      const job = reply.body.job;
      result = null;
      if (!job) {
        await delay(250, undefined, { signal, ref: false });
        continue;
      }
      if (!validOwnerCall(job) || typeof job.receiptId !== 'string' || !Number.isSafeInteger(job.expiresAt)) return;
      const { requestId, receiptId, scope, spaceId, generation: revision } = job;
      let value = { ok: false, code: 'owner_action_refused' };
      const permit = reply.body.permit;
      if (installPermit && permit?.ok && permit.state === 'owned' && permit.spaceId === local.spaceId &&
        permit.owner === identity && job.owner === identity && job.generation === permit.generation &&
        permit.pairing === job.pairing && job.scope === 'project:' + permit.project && projects().includes(permit.project) &&
        descriptor()?.authority === local.authority && job.expiresAt > now() && generation(local, job.scope) == null) {
        installPermit(local, permit);
      }
      if (owns(job)) {
        try {
          if (job.action === MOVE_ACTION) value = await movePhase(job.input.phase, job.input.move, job.input.payload);
          else if (job.action === 'catalog') value = { ok: true, ...await catalog(job) };
          else if (['inventory','export_digest','export_chunk'].includes(job.action)) value = await exportPart(job);
          else if (dispatch) value = await dispatch(job, { signal, owns: () => owns(job) });
        } catch (error) {
          const code = error?.code;
          value = { ok: false, code: job.action === MOVE_ACTION && Object.hasOwn(moveProblems.codes, code)
            ? code : 'owner_action_unavailable' };
        }
      }
      result = { requestId, receiptId, scope, spaceId, generation: revision, value };
    }
  }
  const task = (async () => {
    while (!signal.aborted) {
      try {
        let local = descriptor();
        if (!local && enroll) {
          await enroll(signal);
          local = descriptor();
        }
        if (local) await serve(local);
        else if (!enroll) break;
      } catch { /* A failed connection or report is retried after the delay. */ }
      if (!signal.aborted) await delay(retryMs, undefined, { signal, ref: false }).catch(() => {});
    }
  })();
  return { async close() { stopping.abort(); await task; exportPart.close(); } };
}
