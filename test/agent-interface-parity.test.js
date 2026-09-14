import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';

test('every statically declared console mutation has an interface parity entry', () => {
  const canonical = (route) => route.split('?')[0].replace(/:[A-Za-z][A-Za-z0-9]*/g, ':param');
  const covered = new Set(agentInterfaceCatalog().uiMutationParity.map((entry) => canonical(entry.route)));
  const methods = { postJson: 'POST', putJson: 'PUT', patchJson: 'PATCH', deleteJson: 'DELETE' };
  function scan(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isDirectory()) { scan(file); continue; }
      if (!/\.(ts|vue)$/.test(file) || file.includes('.spec.')) continue;
      const raw = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, file.endsWith('.vue') ? raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '' : raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && methods[node.expression.text]) {
          const argument = node.arguments[0];
          const route = argument && (ts.isStringLiteralLike(argument) ? argument.text : ts.isTemplateExpression(argument)
            ? argument.head.text + argument.templateSpans.map((span) => ':param' + span.literal.text).join('') : null);
          if (route?.startsWith('/')) {
            const key = canonical(`${methods[node.expression.text]} ${route}`);
            const matches = [...covered].some((entry) => {
              const declared = entry.split('/');
              const invoked = key.split('/');
              return declared.length === invoked.length && declared.every((segment, index) =>
                segment === invoked[index] || segment === ':param' || invoked[index] === ':param');
            });
            assert.equal(matches, true, `${file}: ${route}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(fileURLToPath(new URL('../web/src', import.meta.url)));
});

test('knowledge mutations accept complete UI payloads and retain Agent attribution', async () => {
  const definitions = new Map(listAgentTools().map((tool) => [tool.name, tool]));
  const conflict = {
    personalSpaceId: 'space-a', conflictId: 'conflict-a', reason: 'Review later',
    preferenceKey: 'reply_style', preferenceScope: 'project', preferenceProjectId: 'project-a',
    leftItemId: 'left', leftItemKind: 'entity', rightItemId: 'right', rightItemKind: 'entity',
  };
  const replacement = {
    personalSpaceId: 'space-a', itemKind: 'entity', itemId: 'old',
    action: 'link_replacement', reason: 'Superseded', replacementItemId: 'new', replacementItemKind: 'entity',
  };
  const app = {
    getAgentAccessPolicy: () => ({ enabled: true }),
    deferPreferenceConflict: (input) => input,
    reviseKnowledgeItem: (input) => input,
  };
  for (const [name, input] of [['defer_preference_conflict', conflict], ['revise_personal_knowledge', replacement]]) {
    assert.equal(jsonSchemaToZod(definitions.get(name).inputSchema).safeParse(input).success, true, name);
    assert.deepEqual(await callAgentTool(app, name, input), { ...input, operationActor: 'agent' });
  }
});

const REQUIRED_AGENT_MUTATIONS = new Map([
  ['PATCH /api/capture-policy', 'update_capture_policy'],
  ['POST /api/external-knowledge/bindings', 'create_external_knowledge_binding'],
  ['PATCH /api/external-knowledge/bindings/:bindingId/targets', 'update_external_knowledge_binding_targets'],
  ['POST /api/external-knowledge/bindings/:bindingId/sync', 'sync_external_knowledge_binding'],
  ['DELETE /api/external-knowledge/bindings/:bindingId', 'delete_external_knowledge_binding'],
  ['PATCH /api/external-knowledge/conflict-policy', 'update_external_knowledge_conflict_policy'],
  ['DELETE /api/projects/:projectId', 'delete_public_project'],
]);

const REQUIRED_LOCAL_USER_BOUNDARIES = new Set([
  'PATCH /api/agent-access-policy',
  'PUT /api/system/settings',
  'POST /api/knowledge/batch-confirmation',
  'POST /api/knowledge/:itemKind/:itemId/preference-scope',
  'POST /api/preference-conflicts/:conflictId/complete',
  'PATCH /employee-workspaces/:templateId/:projectId/api/work-items/:itemId/status',
  'PATCH /employee-workspaces/:templateId/:projectId/api/projects/:projectId/sharing',
]);

test('Agent interface catalog covers UI mutations with a tool or an explicit local-user boundary', () => {
  const catalog = agentInterfaceCatalog();
  const tools = new Set(listAgentTools().map(({ name }) => name));
  const byRoute = new Map(catalog.uiMutationParity.map((entry) => [entry.route, entry]));

  for (const [route, toolName] of REQUIRED_AGENT_MUTATIONS) {
    assert.equal(byRoute.get(route)?.access, 'agent', route);
    assert.equal(byRoute.get(route)?.toolName, toolName, route);
    assert.equal(tools.has(toolName), true, toolName);
  }
  for (const route of REQUIRED_LOCAL_USER_BOUNDARIES) {
    const entry = byRoute.get(route);
    assert.equal(entry?.access, 'local_user_only', route);
    assert.match(entry?.reason ?? '', /human|local|device|access/i, route);
    assert.equal(entry?.toolName, undefined, route);
  }
  for (const entry of catalog.uiMutationParity.filter(({ access }) => access === 'agent')) {
    const names = entry.toolNames ?? [entry.toolName];
    assert.ok(names.length > 0, `${entry.route} must name an Agent tool`);
    for (const name of names) assert.equal(tools.has(name), true, `${entry.route}: ${name}`);
  }
  for (const workflow of catalog.readWorkflows) {
    for (const name of workflow.toolNames) assert.equal(tools.has(name), true, `${workflow.domain}: ${name}`);
  }
  assert.deepEqual(byRoute.get('PATCH /api/project-agent-learning/:evidenceId')?.toolNames, [
    'ignore_project_agent_routing_learning',
    'reset_project_agent_routing_learning',
  ]);
  assert.equal(catalog.coverage.total, catalog.uiMutationParity.length);
  assert.equal(
    catalog.coverage.agentControlled + catalog.coverage.localUserOnly,
    catalog.coverage.total,
  );
});

test('external knowledge configuration is controllable through explicit Agent tools', async () => {
  const calls = [];
  const app = {
    getAgentAccessPolicy: () => ({ enabled: true, updatedAt: null }),
    externalKnowledge: {
      listConnectorTypes: () => [{ type: 'mcp' }],
      discover: async (input) => calls.push(['discover', input]),
      listBindings: async () => calls.push(['list-bindings']),
      createBinding: async (input) => calls.push(['create-binding', input]),
      checkBinding: async (id) => calls.push(['check-binding', id]),
      syncBinding: async (id, input) => calls.push(['sync-binding', id, input]),
      retrieveBinding: async (id, input) => calls.push(['retrieve-binding', id, input]),
      updateBindingTargets: async (id, input) => calls.push(['targets', id, input]),
      deleteBinding: async (id) => calls.push(['delete-binding', id]),
    },
    connectedKnowledge: {
      getConflictPolicy: (input) => calls.push(['get-policy', input]),
      updateConflictPolicy: async (input) => calls.push(['update-policy', input]),
    },
    getCapturePolicy: () => ({ enabled: true, updatedAt: null }),
    updateCapturePolicy: (input) => calls.push(['capture-policy', input]),
    deletePublicProject: async (input) => calls.push(['delete-public-project', input]),
  };

  await callAgentTool(app, 'list_external_knowledge_connectors', {});
  await callAgentTool(app, 'discover_external_knowledge_sources', { connectorType: 'mcp' });
  await callAgentTool(app, 'list_external_knowledge_bindings', {});
  await callAgentTool(app, 'create_external_knowledge_binding', {
    name: 'Docs', connectorType: 'mcp', connectorConfig: {}, source: {},
    targets: [{ personalSpaceId: 'space-a', personalProjectId: 'project-a', mode: 'live' }],
  });
  await callAgentTool(app, 'check_external_knowledge_binding', { bindingId: 'binding-a' });
  await callAgentTool(app, 'sync_external_knowledge_binding', { bindingId: 'binding-a', maxPages: 2 });
  await callAgentTool(app, 'retrieve_external_knowledge_binding', { bindingId: 'binding-a', query: 'release' });
  await callAgentTool(app, 'update_external_knowledge_binding_targets', {
    bindingId: 'binding-a',
    expectedTargetsVersion: 'a'.repeat(64),
    targets: [{ personalSpaceId: 'space-a', personalProjectId: 'project-a', mode: 'mirror' }],
  });
  await callAgentTool(app, 'delete_external_knowledge_binding', { bindingId: 'binding-a' });
  await callAgentTool(app, 'get_external_knowledge_conflict_policy', { personalProjectId: 'project-a' });
  await callAgentTool(app, 'update_external_knowledge_conflict_policy', {
    personalSpaceId: 'space-a', personalProjectId: 'project-a', mode: 'agent_decide',
  });
  await callAgentTool(app, 'get_capture_policy', {});
  await callAgentTool(app, 'update_capture_policy', { enabled: false });
  await callAgentTool(app, 'delete_public_project', {
    projectId: 'public-a', providerUrl: 'https://provider.example.test',
  });

  assert.deepEqual(calls.map(([name]) => name), [
    'discover', 'list-bindings', 'create-binding', 'check-binding', 'sync-binding',
    'retrieve-binding', 'targets', 'delete-binding', 'get-policy', 'update-policy',
    'capture-policy', 'delete-public-project',
  ]);
});

test('list_agent_interfaces returns the same parity contract exposed in code', async () => {
  const result = await callAgentTool({
    getAgentAccessPolicy: () => ({ enabled: true, updatedAt: null }),
  }, 'list_agent_interfaces', {});
  assert.deepEqual(result, agentInterfaceCatalog());
});
