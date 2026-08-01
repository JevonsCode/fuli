import { mkdirSync } from 'node:fs';

import { createConnectorCatalog } from './catalog.js';
import { ConnectedKnowledgeSearch } from './connected-search.js';
import { KnowledgeConflictPolicyStore } from './conflict-policy.js';
import { ExternalKnowledgeRegistry } from './registry.js';
import { ExternalKnowledgeService } from './service.js';

export function openExternalKnowledgeRuntime({
  app,
  paths,
  env = process.env,
  fetchImpl = globalThis.fetch,
  mcpOpenSession,
  sleep
}) {
  assertPaths(paths);
  mkdirSync(paths.externalKnowledgeConnectorDir, { recursive: true });
  const connectors = createConnectorCatalog({
    customConnectorDirectory: paths.externalKnowledgeConnectorDir,
    fetchImpl,
    mcpOpenSession,
    sleep
  });
  const externalKnowledge = new ExternalKnowledgeService({
    app,
    registry: new ExternalKnowledgeRegistry(paths.externalKnowledgeRegistryPath),
    connectors,
    env
  });
  const connectedKnowledge = new ConnectedKnowledgeSearch({
    app,
    externalKnowledge,
    policies: new KnowledgeConflictPolicyStore(
      paths.externalKnowledgeConflictPolicyPath
    )
  });
  return { externalKnowledge, connectedKnowledge };
}

export function attachExternalKnowledgeRuntime(app, options) {
  const runtime = openExternalKnowledgeRuntime({ app, ...options });
  Object.defineProperties(app, {
    externalKnowledge: {
      configurable: true,
      enumerable: false,
      value: runtime.externalKnowledge
    },
    connectedKnowledge: {
      configurable: true,
      enumerable: false,
      value: runtime.connectedKnowledge
    }
  });
  return app;
}

function assertPaths(paths) {
  for (const name of [
    'externalKnowledgeRegistryPath',
    'externalKnowledgeConflictPolicyPath',
    'externalKnowledgeConnectorDir'
  ]) {
    if (typeof paths?.[name] !== 'string' || !paths[name]) {
      throw new TypeError(`External knowledge path is required: ${name}`);
    }
  }
}
