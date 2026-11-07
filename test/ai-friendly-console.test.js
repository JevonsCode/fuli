import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog, interfaceForRoute } from '../src/agent-tools/interface-catalog.js';

// The AI-friendly console (docs/ai-friendly-console.md): the console page
// tools a browser AI calls (WebMCP) and the 「让 AI 来做」 prompts a person
// copies into their own Agent may only name what FULI's interface catalog
// and Agent tools really offer.

const WEB = fileURLToPath(new URL('../web/src', import.meta.url));
const RUN_DELEGATED = new Set(['agent_delegable', 'agent_delegable_off', 'agent_relayed']);

function files(directory, accept) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path, accept) : accept(path) ? [path] : [];
  });
}

// Every `routes: [...]` and `route: '…'` string a page tool file declares, by tool name.
function declaredRoutes(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const tools = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const property = (name) => node.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText() === name);
      const name = property('name')?.initializer;
      const routes = property('routes')?.initializer;
      if (name && ts.isStringLiteral(name) && routes && ts.isArrayLiteralExpression(routes)) {
        const used = [];
        (function collect(child) {
          if (ts.isPropertyAssignment(child) && child.name.getText() === 'route' && ts.isStringLiteral(child.initializer)) used.push(child.initializer.text);
          if (ts.isCallExpression(child) && /\.read$/.test(child.expression.getText()) && child.arguments[0]) used.push(`GET ${child.arguments[0].getText()}`);
          ts.forEachChild(child, collect);
        })(node);
        tools.push({ name: name.text, routes: routes.elements.map((element) => element.text), used });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return tools;
}

test('every console page tool reaches only catalog routes or reads, and declares each route it uses', () => {
  const tools = files(WEB, (path) => /page-tools\.ts$/.test(path)).flatMap(declaredRoutes);
  assert.deepEqual(tools.map(({ name }) => name).sort(), ['fuli_configure_model_role', 'fuli_list_decisions', 'fuli_open_page',
    'fuli_read_model_settings', 'fuli_read_settings', 'fuli_search_knowledge', 'fuli_test_model_role', 'fuli_update_settings']);
  for (const tool of tools) {
    for (const route of tool.routes) {
      if (route.startsWith('GET /api/')) continue;
      assert.ok(interfaceForRoute(route), `${tool.name}: ${route} has no interface catalog entry`);
    }
    for (const route of tool.used.filter((used) => !used.startsWith('GET '))) {
      assert.ok(tool.routes.includes(route), `${tool.name} uses ${route} without declaring it`);
    }
  }
  // rec#10 on fuli#784: a page tool only does what the delegation gate lets an FLA do; no page tool reaches a
  // route that is the person's own (a key, the endpoint listing, a decision recorded as theirs).
  for (const tool of tools) {
    for (const route of tool.routes.filter((route) => !route.startsWith('GET '))) {
      assert.ok(['agent_delegable', 'agent_delegable_off'].includes(interfaceForRoute(route).access), `${tool.name}: ${route}`);
    }
  }
});

async function promptsModule() {
  const source = readFileSync(join(WEB, 'features/ai-help/ai-task-prompts.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const CONTEXT = { console: 'http://127.0.0.1:2999', area: 'Synthetic card', guide: 'https://example.test/models/' };
// Words in the prompts that look like tool names but are protocol or field names.
const NOT_TOOLS = new Set(['openai_embeddings', 'openai_chat']);

test('「让 AI 来做」 prompts name only real Agent tools and run_delegated_action routes, in both languages', async () => {
  const { AI_TASK_IDS, aiTaskPrompt } = await promptsModule();
  const tools = new Set([...listAgentTools().map(({ name }) => name), 'fuli_call']);
  const consoleSource = files(fileURLToPath(new URL('../src', import.meta.url)), (path) => path.endsWith('.js'))
    .map((path) => readFileSync(path, 'utf8')).join('\n');
  for (const task of AI_TASK_IDS) {
    for (const locale of ['zh-CN', 'en-US']) {
      const prompt = aiTaskPrompt(task, locale, CONTEXT);
      assert.ok(prompt.includes(CONTEXT.console), `${task}/${locale} names the console`);
      for (const [, route] of prompt.matchAll(/[「"]((?:GET|POST|PUT|PATCH|DELETE) \/[^」"]+)[」"]/g)) {
        const entry = interfaceForRoute(route);
        assert.ok(entry, `${task}/${locale}: ${route} is no catalog route`);
        assert.ok(RUN_DELEGATED.has(entry.access), `${task}/${locale}: ${route} is ${entry.access}, not a run_delegated_action route`);
      }
      for (const [, path] of prompt.matchAll(/GET http:\/\/127\.0\.0\.1:2999(\/api\/[a-z/-]+)/g)) {
        assert.ok(consoleSource.includes(`'${path}'`), `${task}/${locale}: the console has no read route ${path}`);
      }
      for (const [word] of prompt.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
        if (!NOT_TOOLS.has(word)) assert.ok(tools.has(word), `${task}/${locale}: ${word} is no FULI tool`);
      }
    }
  }
});

test('the model prompt keeps a key out of every tool and output, and the catalog says how keys arrive', async () => {
  const { aiTaskPrompt } = await promptsModule();
  for (const locale of ['zh-CN', 'en-US']) {
    const prompt = aiTaskPrompt('models', locale, CONTEXT);
    assert.match(prompt, /fuli models set-key \S+ --endpoint/);
    assert.match(prompt, /stdin|标准输入/);
    assert.match(prompt, /POST \/api\/model-backends\/roles\/:role\/check/);
    assert.match(prompt, new RegExp(CONTEXT.guide.replaceAll('.', '\\.')));
  }
  const models = agentInterfaceCatalog().readWorkflows.find(({ domain }) => domain === 'model-backends');
  assert.match(models.guidance, /fuli models set-key <secretRef> --endpoint <url> on stdin/);
  assert.equal(interfaceForRoute('POST /api/model-backends/roles/:role/check').category, 'model_settings');
});
