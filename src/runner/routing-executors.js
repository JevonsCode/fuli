import { join } from 'node:path';

import { z } from 'zod';

import { resolveClientCommand, whichCommand } from '../../packages/roundtable/src/roundtable/wake.js';
import { SOURCE_APPLICATIONS } from '../agents/source-applications.js';
import { readJsonFile } from '../storage/json-file.js';

// The executors a runner's own Tonborg chooses from (docs/runner.md,
// "Executor judgment on a runner"): what the person declared in
// runner/executors.json on this computer, each with the models it can run,
// kept only while its local preflight passes now: the client's command is
// found on this computer (the command the declaration names, or the one FULI
// starts that client with). The host's executor directory is not read here;
// its executors are another computer's. FULI never writes this file.
export const RUNNER_EXECUTORS_FILE = join('runner', 'executors.json');
const VERSION = 1;

const text = (maximum) => z.string().trim().min(1).max(maximum);
const words = z.array(text(128)).max(32).default([]);
const modelSchema = z.object({ model: text(200), capabilities: words, strategyModes: words, reasoningEfforts: words,
  costRank: z.number().int().min(0).max(100).optional(), note: text(500).optional() }).strict();
const executorSchema = z.object({ executorId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), displayName: text(128),
  client: z.enum(SOURCE_APPLICATIONS), command: text(200).optional(), capabilities: words,
  models: z.array(modelSchema).min(1).max(32) }).strict();
const fileSchema = z.object({ version: z.literal(VERSION),
  executors: z.array(executorSchema).max(32).refine((list) => new Set(list.map((item) => item.executorId)).size === list.length,
    'each executorId appears once') }).strict();

// { state: 'absent' } | { state: 'invalid', error } | { state: 'ok', executors }.
export function readRunnerExecutors(dataDir, { read = readJsonFile } = {}) {
  let raw;
  try {
    raw = read(join(dataDir, RUNNER_EXECUTORS_FILE), null);
  } catch {
    return { state: 'invalid', error: `${RUNNER_EXECUTORS_FILE} could not be read as JSON` };
  }
  if (raw === null || raw === undefined) return { state: 'absent' };
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { state: 'invalid', error: `${RUNNER_EXECUTORS_FILE}: ${issue.path.join('.') || 'file'}: ${issue.message}` };
  }
  return { state: 'ok', executors: parsed.data.executors };
}

// The declared executors that can do this task here, in the shape Tonborg's
// judgment reads on the host (routing.js), and the ones left out with why.
// required: capabilities the task needs, lowercase.
export function preflightExecutors(executors, required, { resolve = resolveClientCommand, which = whichCommand } = {}) {
  const eligible = [];
  const leftOut = [];
  for (const executor of executors) {
    const found = executor.command ? which(executor.command) : resolve(executor.client);
    if (!found) {
      leftOut.push({ executorId: executor.executorId, reason: 'command_not_found' });
    } else if (!required.every((value) => executor.capabilities.some((capability) => capability.toLowerCase() === value))) {
      leftOut.push({ executorId: executor.executorId, reason: 'capability_missing' });
    } else {
      eligible.push({ executorId: executor.executorId, name: executor.displayName, client: executor.client,
        models: executor.models.map((model) => ({ ...model, available: true, sourceApplication: executor.client })) });
    }
  }
  return { eligible, leftOut };
}
