#!/usr/bin/env node
// Build the repeatable benign fixture: one synthetic project and one workflow
// stored through the production Agent workflow port (proposed, then confirmed
// by the person). It refuses to overwrite an existing store.
//
//   node acceptance/skill-paired-eval/make-fixture.js --out <dir>
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { isMainModule } from '../../src/system/main-module.js';
import { createFixtureStore, FIXTURE_PROJECT_FILES } from './fixture.js';

const { values } = parseArgs({ options: { out: { type: 'string' } } });

function main() {
  if (!values.out) throw new TypeError('--out <dir> is required');
  const out = values.out;
  const store = join(out, 'agent-workflows.sqlite');
  if (existsSync(store)) throw new Error(`${store} already exists; choose another --out instead of overwriting it`);
  const project = join(out, 'project');
  mkdirSync(project, { recursive: true });
  for (const [path, text] of Object.entries(FIXTURE_PROJECT_FILES)) writeFileSync(join(project, path), text);
  const fixture = createFixtureStore({ path: store });
  const invocation = `node acceptance/skill-paired-eval/run.js --store "${store}" `
    + `--workflow-id ${fixture.workflowId} --mode deterministic --out "${join(out, 'results')}"`;
  process.stdout.write(`${JSON.stringify({ ...fixture, project, invocation }, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
