import { existsSync } from 'node:fs';

import { dataUsage } from './data-directory.js';
import { agentAppType } from './manifest.js';
import { createRunGate } from './run-gate.js';

const HISTORY_LIMIT = 20;

// Management views: one compact row per app for the overview, and the full
// metadata of one app for preview and review. Neither returns code or data.
// Both show where each approval came in, the confirmation and trust mode it
// went through and what the run gate answers now, so a management page never
// presents an approval as more than was checked.
export function createAppViews(context) {
  const { store } = context;
  const { runGate } = createRunGate(context);

  function list({ personalSpaceId = null, agentId = null } = {}) {
    return {
      apps: store.apps({ personalSpaceId, agentId }).map((app) => {
        const versions = store.versions(app.appId);
        const shown = versions.find(({ version }) => version === app.activeVersion) ?? versions.at(-1);
        return {
          appId: app.appId, agentId: app.agentId, name: app.name, title: shown?.manifest.title ?? null,
          type: shown ? agentAppType(shown.manifest) : null, status: app.status, version: app.activeVersion,
          pendingVersions: versions.filter(({ state }) => state === 'pending').map(({ version }) => version),
          approval: activeApproval(store.approval(app.appId, app.activeVersion)),
          run: runGate({ appId: app.appId }), instance: instanceView(app.appId), lastUsedAt: app.lastUsedAt,
          dataBytes: dataUsage(context.dataOf(app.appId)).bytes, ...orphanData(app)
        };
      })
    };
  }

  function read({ appId }) {
    const app = store.existingApp(appId);
    return {
      appId, personalSpaceId: app.personalSpaceId, agentId: app.agentId, name: app.name, status: app.status,
      version: app.activeVersion, run: runGate({ appId }), instance: instanceView(appId), owner: ownerView(appId),
      dataFormat: app.dataFormat, ...orphanData(app),
      dataBytes: dataUsage(context.dataOf(appId)).bytes,
      lastUsedAt: app.lastUsedAt, createdAt: app.createdAt, updatedAt: app.updatedAt,
      versions: store.versions(appId).map((version) => ({
        version: version.version, state: version.state, digest: version.digest,
        title: version.manifest.title, description: version.manifest.description,
        type: agentAppType(version.manifest), permissions: version.manifest.permissions,
        resident: version.manifest.resident, data: version.manifest.data,
        files: version.files, bytes: version.bytes, submittedAt: version.submittedAt,
        approval: approvalView(store.approval(appId, version.version))
      })),
      history: store.events(appId, HISTORY_LIMIT)
    };
  }

  // While sealing, which write tool it waits for and since when.
  function instanceView(appId) {
    const instance = store.instance(appId);
    if (!instance) return null;
    const { instanceId, generation, mode, state, version, startedAt, sealedAt, stoppedAt, stopReason } = instance;
    const waiting = state === 'sealing' ? store.lastEvent(appId, 'seal_waiting_for_writes') : null;
    return { instanceId, generation, mode, state, version, startedAt, sealedAt, stoppedAt, stopReason,
      ...(waiting ? { waitingFor: { toolName: waiting.detail.toolName, since: waiting.at } } : {}) };
  }

  function ownerView(appId) {
    const { ownerKind, pid, acquiredAt, heartbeatAt } = store.owner(appId);
    return ownerKind ? { ownerKind, pid, since: acquiredAt, heartbeatAt } : null;
  }

  // A deleted app whose data directory came back (only a manual restore does that) is kept and shown.
  function orphanData(app) {
    return app.status === 'deleted' && existsSync(context.dataOf(app.appId)) ? { orphanDataDirectory: true } : {};
  }

  return { list, read };
}

function activeApproval(approval) {
  if (!approval) return null;
  const { approvedBy, entrypoint, presence, verification, challengeId, verifiedAt, trustMode, termsVersion, approvedAt } = approval;
  return { approvedBy, entrypoint, presence, verification, challengeId, verifiedAt, trustMode, termsVersion, approvedAt };
}

function approvalView(approval) {
  if (!approval) return null;
  const { digest, permissions, data, resident } = approval;
  return { digest, ...activeApproval(approval), permissions, data, resident };
}
