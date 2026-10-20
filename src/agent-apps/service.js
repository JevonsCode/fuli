import { dirname, join } from 'node:path';

import { AGENT_APP_TOOL_NAMES } from '../agent-tools/agent-app-definitions.js';
import { createAppTokens } from './app-tokens.js';
import { createAppRemoval } from './removal.js';
import { AgentAppStore } from './store.js';
import { createAppVersions } from './versions.js';
import { createAppViews } from './views.js';

// Agent apps live in FULI's own data directory beside employee packages, never
// in the read-only Agent directory projection under agents/.
export function agentAppRoot(runtimeConfigPath) {
  return join(dirname(runtimeConfigPath), 'agent-apps');
}

// The Agent app port. Agents reach submit/list/read through their FULI tools;
// approve, disable, rollback, deletion and export belong to the local user's
// CLI and HTTP routes; issueToken/verifyToken are the App Host port the app
// runner uses. resolveOwner is absent where no Agent can submit (the CLI).
export function createAgentAppService({ root, providerIdentity = null, resolveOwner = null, toolNames, clock = () => new Date() }) {
  const store = new AgentAppStore(join(root, 'registry.sqlite'));
  const context = {
    store, clock, resolveOwner,
    provider: providerIdentity === null ? null : String(providerIdentity).replace(/\/+$/, ''),
    now: () => clock().toISOString(),
    packagesOf: (appId) => join(root, 'packages', appId),
    packageOf: (appId, version) => join(root, 'packages', appId, version),
    dataOf: (appId) => join(root, 'data', appId),
    // An app may call any Agent tool except those that grow or manage apps.
    grantable: () => new Set(toolNames().filter((name) => !AGENT_APP_TOOL_NAMES.includes(name))
      .map((name) => `fuli.${name}`))
  };
  return {
    ...createAppVersions(context),
    ...createAppRemoval(context),
    ...createAppTokens(context),
    ...createAppViews(context),
    close: () => store.close()
  };
}
