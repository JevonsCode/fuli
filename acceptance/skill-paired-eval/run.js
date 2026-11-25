#!/usr/bin/env node
// Run one single-skill paired evaluation against one selected stored workflow
// version. The store is read-only: this command never proposes, confirms or
// records a run.
//
//   fuli-skill-eval --store <agent-workflows.sqlite> --list
//   fuli-skill-eval --store <...> --workflow-id <id> --show
//   fuli-skill-eval --store <...> --workflow-id <id> \
//     [--scenario <scenario.json>] --mode deterministic --out <dir>
//   fuli-skill-eval --store <...> --workflow-id <id> \
//     --mode opencode --model <provider/model> --provider-config <opencode.json> --out <dir>
//
// From a source checkout the same arguments run through
// `npm run measure:skill-paired --` or `node acceptance/skill-paired-eval/run.js`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { isMainModule } from '../../src/system/main-module.js';
import { createClient } from './clients.js';
import { renderReport } from './report.js';
import { evaluateSelectedWorkflow } from './runner.js';
import { DEFAULT_SCENARIO, loadScenario, safeRunDirectoryName } from './scenario.js';
import { listStoredWorkflows, readStoredWorkflow } from './selection.js';

const { values } = parseArgs({ options: {
  store: { type: 'string' },
  list: { type: 'boolean', default: false },
  show: { type: 'boolean', default: false },
  'workflow-id': { type: 'string' },
  version: { type: 'string' },
  'personal-space-id': { type: 'string' },
  'agent-id': { type: 'string' },
  scenario: { type: 'string' },
  out: { type: 'string' },
  'pair-id': { type: 'string' },
  mode: { type: 'string', default: 'deterministic' },
  model: { type: 'string' },
  'client-command': { type: 'string', default: 'opencode' },
  'provider-config': { type: 'string' },
  timeout: { type: 'string', default: '600' },
  'no-negative': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false }
} });

const USAGE = `Usage:
  fuli-skill-eval --store <agent-workflows.sqlite> --list [--personal-space-id <id>] [--agent-id <id>]
  fuli-skill-eval --store <...> --workflow-id <id> [--version <n>] --show
  fuli-skill-eval --store <...> --workflow-id <id> [--version <n>] --out <dir> [options]

  In a source checkout, run the same arguments with
  "npm run measure:skill-paired --" or "node acceptance/skill-paired-eval/run.js".

Run options:
  --scenario <file>               declarative JSON scenario; the built-in text fixture is used without it
  --mode deterministic|opencode   deterministic is a CI seam, not live-client evidence (default)
  --model <provider/model>        required with --mode opencode; the same model is used for every arm
  --client-command <command>      native OpenCode executable, default "opencode"
  --provider-config <file>        OpenCode config with the model provider; default ~/.config/opencode/opencode.json
  --timeout <seconds>             per arm, default 600
  --no-negative                   skip the unrelated negative control
  --json                          print the full result instead of the Markdown report
  --pair-id <id>                  one portable result-directory name; an existing one is refused

The workflow store is opened read-only. Choose exactly one workflow with
--workflow-id; the active version is used unless --version selects a stored one.
The scenario is validated before any workspace or result directory is written.`;

function defaultProviderConfig() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'opencode.json');
}

function commandOptions() {
  return { timeoutMs: Number(values.timeout) * 1000, model: values.model,
    command: values['client-command'], providerConfig: values['provider-config'] ?? defaultProviderConfig() };
}

function list() {
  const workflows = listStoredWorkflows(values.store, { personalSpaceId: values['personal-space-id'] ?? null,
    agentId: values['agent-id'] ?? null });
  if (!workflows.length) {
    process.stderr.write('No stored workflows matched. Nothing was changed.\n');
    process.exitCode = 1;
    return;
  }
  const rows = workflows.map(workflow => [
    workflow.workflowId, workflow.agentId, workflow.personalProjectId ?? '—', workflow.status,
    workflow.activeVersion ?? '—', workflow.shownVersion, workflow.stepCount, workflow.name
  ]);
  const header = ['workflowId', 'agent', 'project', 'status', 'active', 'shown', 'steps', 'name'];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map(row => String(row[index]).length)));
  const line = row => row.map((value, index) => String(value).padEnd(widths[index])).join('  ').trimEnd();
  process.stdout.write(`${line(header)}\n${rows.map(line).join('\n')}\n`);
}

async function main() {
  if (values.help) { process.stdout.write(`${USAGE}\n`); return; }
  if (!values.store) throw new TypeError('--store <agent-workflows.sqlite> is required');
  if (values.list) { list(); return; }
  if (!values['workflow-id']) throw new TypeError('Choose exactly one workflow with --workflow-id (see --list)');
  const version = values.version === undefined ? null : Number(values.version);
  if (version !== null && (!Number.isInteger(version) || version < 1)) throw new TypeError('--version is a positive integer');
  const selection = readStoredWorkflow(values.store, values['workflow-id'], { version });
  if (values.show) { process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`); return; }
  // Validate the scenario before creating the result directory or a workspace.
  const scenario = values.scenario ? loadScenario(values.scenario) : DEFAULT_SCENARIO;
  if (!values.out) throw new TypeError('--out <dir> is required to run a pair');
  // --pair-id is one directory name, never a path; an existing run directory is
  // refused by the runner so a retry cannot overwrite earlier evidence.
  const pairId = values['pair-id'] === undefined ? null : safeRunDirectoryName(values['pair-id']);
  const client = createClient({ mode: values.mode, ...commandOptions() });
  mkdirSync(values.out, { recursive: true });
  const result = await evaluateSelectedWorkflow({ selection, scenario, out: values.out, client,
    negative: !values['no-negative'], pairId });
  const report = renderReport(result);
  writeFileSync(join(result.runDirectory, 'report.md'), report);
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${report}\n`);
  const failed = result.pair.onPass !== true
    || (result.negativeControl.measured && result.negativeControl.pass !== true)
    || result.storeUnchanged === false
    || result.unavailable.length > 0;
  process.exitCode = failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
