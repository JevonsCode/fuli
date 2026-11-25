import { randomUUID } from 'node:crypto';

import { readJson, sendJson } from '../http/response.js';
import { CHUNK_BYTES, ownerChannel } from './owner-channel.js';
import { readOwnerExport } from './owner-export.js';
import { ownerInventory } from './owner-inventory.js';
import { RUNNER_PATHS } from './protocol.js';
import { grantScope } from './scope-grants.js';

export function hostOwnerProtocol({ app, store, enabled, withLease }) {
  const spaceId = () => app.config?.personal?.spaceId;
  const inventory = ownerInventory({ spaceId, registry: () => store.ownership(), pairing: device => store.grants(device).pairing() });
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
  let verifying = false;
  async function verify(device) {
    const pending = inventory.pending(device);
    const epoch = store.grants(device).pairing();
    if (!pending || verifying || (proofs.get(device)?.snapshot === pending.snapshot && proofs.get(device)?.epoch === epoch)) return;
    verifying = true;
    try {
      const checked = await issue({ owner: device, spaceId: spaceId(), scope: 'global', generation: 1,
        requestId: randomUUID(), action: 'catalog' });
      if (!checked.ok || !checked.result?.ok) return;
      const verified = [];
      for (const project of pending.projects) {
        const record = store.ownership().owner(project);
        const ask = (action, input) => issue({ owner: device, spaceId: spaceId(), scope: 'project:' + project,
          generation: record?.generation, requestId: randomUUID(), action, ...(input ? { input } : {}) });
        const summary = await ask('inventory');
        if (!summary.ok) return;
        const exported = await readOwnerExport(ask, summary.result);
        if (!exported.ok) return;
        const proof = await withLease('runner-owner-inventory', () => app.personal.verifyProjectExport({
          personalSpaceId: spaceId(), projectId: project, envelope: exported.text }));
        if (proof?.project !== project || proof?.digest !== exported.digest || proof.spaceId !== spaceId() || !store.isPaired(device)) return;
        verified.push({ ...proof, owner: device });
      }
      if (epoch === store.grants(device).pairing() && inventory.verified(device, pending.snapshot, verified, checked.result).ok) proofs.set(device, { snapshot: pending.snapshot, epoch });
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
        if (result.ok && proofs.get(fingerprint)?.snapshot !== body.snapshot) proofs.delete(fingerprint);
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
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once('close', cancel);
        try {
          const waiting = channel.pull(fingerprint, { signal: controller.signal });
          void verify(fingerprint).catch(() => {});
          const next = await waiting;
          if (!response.destroyed) {
            const needInventory = !inventory.pending(fingerprint) && proofs.get(fingerprint)?.epoch !== store.grants(fingerprint).pairing();
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
