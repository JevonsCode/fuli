import { randomUUID } from 'node:crypto';

import { readJson, sendJson } from '../http/response.js';
import { CHUNK_BYTES, ownerChannel } from './owner-channel.js';
import { readOwnerExport } from './owner-export.js';
import { inventoryDigest, ownerInventory } from './owner-inventory.js';
import { RUNNER_PATHS } from './protocol.js';
import { grantScope } from './scope-grants.js';

export function hostOwnerProtocol({ app, store, enabled, withLease, onConnected = () => {}, now = Date.now }) {
  const spaceId = () => app.config?.personal?.spaceId;
  const inventory = ownerInventory({ spaceId, now, registry: () => store.ownership(), pairing: device => store.grants(device).pairing() });
  const admissible = job => {
    if (!enabled() || job.spaceId !== spaceId() || (!job.pairing || store.grants(job.owner).pairing() !== job.pairing)) return false;
    if (job.action === 'catalog') return job.scope === 'global' && Boolean(inventory.pending(job.owner));
    const state = store.ownership().owner(job.scope.slice('project:'.length));
    if (state?.owner !== job.owner || state.generation !== job.generation || state.state === 'conflict') return false;
    return state.state === 'owned' || ['inventory', 'export_chunk'].includes(job.action);
  };
  const channel = ownerChannel({ admit: admissible });
  const issue = (job, options) => channel.request({ ...job, pairing: store.grants(job.owner).pairing() }, options);
  const proofs = new Map();
  // A finished inventory is evidence for this pairing and catalog. Polls do
  // not wake the peer's graph to renew it. Transport failures back off.
  function unavailable(previous) {
    const delay = Math.min((previous?.delay ?? 30_000) * 2, 3_600_000);
    return { until: now() + delay, delay };
  }
  const terminal = code => ({ code, until: Infinity });
  let verifying = false;
  async function verify(device) {
    const report = inventory.pending(device);
    const epoch = store.grants(device).pairing();
    if (!report || !epoch || verifying) return;
    let state = proofs.get(device);
    if (!state || state.epoch !== epoch || state.snapshot !== report.snapshot) {
      const digest = inventoryDigest(report.projects);
      if (!state || state.epoch !== epoch || state.digest !== digest) {
        if (!state && proofs.size >= 16) return;
        state = { epoch, digest, projects: new Map(), next: 0 };
        proofs.set(device, state);
      }
      state.snapshot = report.snapshot;
      state.next = Math.min(state.next, now());
    }
    if (state.next > now()) return;
    verifying = true;
    const current = () => proofs.get(device) === state && epoch === store.grants(device).pairing() &&
      inventory.pending(device)?.snapshot === report.snapshot;
    try {
      if (!state.catalog) {
        if (state.catalogFailure?.until > now()) { state.next = state.catalogFailure.until; return; }
        const reply = await issue({ owner: device, spaceId: spaceId(), scope: 'global', generation: 1,
          requestId: randomUUID(), action: 'catalog' });
        if (!current()) return;
        if (!reply.ok || !reply.result?.ok || !inventory.acceptsCatalog(device, report.snapshot, reply.result)) {
          state.catalogFailure = reply.ok && reply.result?.ok ? terminal('inventory_changed') : unavailable(state.catalogFailure);
          state.next = state.catalogFailure.until;
          return;
        }
        state.catalog = reply.result;
      }
      let next = Infinity;
      for (const project of report.projects) {
        if (!current()) return;
        const record = store.ownership().owner(project);
        if (!record || record.state === 'conflict' || record.owner !== device) continue;
        const cached = state.projects.get(project);
        const prior = cached?.generation === record.generation ? cached : null;
        if (prior?.until > now()) { next = Math.min(next, prior.until); continue; }
        const ask = (action, input) => issue({ owner: device, spaceId: spaceId(), scope: 'project:' + project,
          generation: record.generation, requestId: randomUUID(), action, ...(input ? { input } : {}) });
        let outcome = unavailable(prior);
        try {
          const summary = await ask('inventory');
          if (summary.ok && summary.result?.ok) {
            const exported = await readOwnerExport(ask, summary.result);
            if (exported.ok) {
              const proof = await withLease('runner-owner-inventory', () => app.personal.verifyProjectExport({
                personalSpaceId: spaceId(), projectId: project, envelope: exported.text }));
              if (!current()) return;
              const verified = proof?.project === project && proof.digest === exported.digest &&
                inventory.verifyProject(device, report.snapshot, { ...proof, owner: device }, record.generation);
              outcome = terminal(verified ? 'verified' : 'export_unverified');
            } else if (exported.code !== 'export_changed') outcome = terminal(exported.code);
          } else if (['scope_too_large','export_unverified'].includes(summary.result?.code)) {
            outcome = terminal(summary.result.code);
          }
        } catch (error) {
          if ([400,403,409,413,422].includes(error?.status)) outcome = terminal('export_unverified');
        }
        state.projects.set(project, { generation: record.generation, ...outcome });
        next = Math.min(next, outcome.until);
      }
      if (current()) {
        store.ownership().checkedCatalog(device, epoch, report.projects);
        state.next = next;
      }
    } finally { verifying = false; }
  }
  return {
    offered: enabled,
    request: issue,
    async handle(request, response, { pathname, fingerprint }) {
      const helloReport = pathname === RUNNER_PATHS.hello && request.method === 'POST';
      if (!helloReport && ![RUNNER_PATHS.ownerPoll, RUNNER_PATHS.scopeRequest].includes(pathname)) return false;
      if (!enabled() || !store.grants(fingerprint).pairing()) { sendJson(response, 403, { code: 'owner_protocol_unavailable' }); return true; }
      if (request.method !== 'POST') { sendJson(response, 405, { code: 'invalid_method' }); return true; }
      const body = await readJson(request, { maxBytes: pathname === RUNNER_PATHS.ownerPoll ? 2 * CHUNK_BYTES : 40_000 });
      if (helloReport) {
        const result = inventory.accept(fingerprint, body);
        sendJson(response, result.ok ? 200 : 409, result);
      } else if (pathname === RUNNER_PATHS.scopeRequest) {
        if (!body || body.spaceId !== spaceId() || !grantScope(body.scope)) sendJson(response, 400, { code: 'scope_invalid' });
        else sendJson(response, 200, store.grants(fingerprint).request(body.scope));
      } else if (!body || body.spaceId !== spaceId() || body.version !== 1) {
        sendJson(response, 409, { code: 'owner_protocol_mismatch' });
      } else {
        if (body.result && !channel.reply(fingerprint, body.result).ok) {
          sendJson(response, 409, { code: 'owner_call_unknown' });
          return true;
        }
        if (body.connected === true && !body.result) onConnected(fingerprint);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once('close', cancel);
        try {
          const waiting = channel.pull(fingerprint, { signal: controller.signal });
          void verify(fingerprint).catch(() => {});
          const next = await waiting;
          if (!response.destroyed) {
            const proof = proofs.get(fingerprint);
            const needInventory = !inventory.pending(fingerprint) && (!proof || proof.next <= now() ||
              proof.epoch !== store.grants(fingerprint).pairing());
            sendJson(response, 200, { ...next, needInventory });
          }
        } finally { response.off('close', cancel); }
      }
      return true;
    },
    keep(devices) {
      channel.keep(devices);
      inventory.keep(devices);
      for (const device of proofs.keys()) if (!devices.has(device)) proofs.delete(device);
    },
    close() { channel.close(); proofs.clear(); }
  };
}
