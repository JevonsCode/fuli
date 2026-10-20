import { dataUsage } from './data-directory.js';
import { agentAppType } from './manifest.js';

const HISTORY_LIMIT = 20;

// Management views: one compact row per app for the overview, and the full
// metadata of one app for preview and review. Neither returns code or data.
// Both show where each approval came in and the presence FULI verified, so a
// management page never presents an approval as more than was checked.
export function createAppViews(context) {
  const { store } = context;

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
          lastUsedAt: app.lastUsedAt, dataBytes: dataUsage(context.dataOf(app.appId)).bytes
        };
      })
    };
  }

  function read({ appId }) {
    const app = store.existingApp(appId);
    return {
      appId, personalSpaceId: app.personalSpaceId, agentId: app.agentId, name: app.name, status: app.status,
      version: app.activeVersion, dataFormat: app.dataFormat, dataBytes: dataUsage(context.dataOf(appId)).bytes,
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

  return { list, read };
}

function activeApproval(approval) {
  if (!approval) return null;
  const { approvedBy, entrypoint, presence, approvedAt } = approval;
  return { approvedBy, entrypoint, presence, approvedAt };
}

function approvalView(approval) {
  if (!approval) return null;
  const { digest, permissions, data, resident } = approval;
  return { digest, ...activeApproval(approval), permissions, data, resident };
}
