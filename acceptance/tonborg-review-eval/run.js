#!/usr/bin/env node
// Runs the frozen Tonborg review sets through FULI's production
// knowledge_review path against the local Ollama only (rec#26), each case
// `--runs` times, and keeps every raw request and response per case and run.
// It reads blind inputs only; labels are joined later by score.js.
//
//   node acceptance/tonborg-review-eval/run.js --cases <dir> --out <dir> \
//     [--model qwen3.5:4b] [--runs 3] [--seed 20261022] [--sets dev,holdout]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { isMainModule } from '../../src/system/main-module.js';
import { OLLAMA_ORIGIN, localOnlyFetch } from './local-ollama-transport.js';
import { createReviewPath } from './review-path.js';
import { validRuns } from './scoring.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUTCOMES = new Set(['approve', 'escalate']);

export function compactRow({ blindId, set, run }, review) {
  const verdict = review.modelVerdict;
  const valid = review.receipt?.status === 'completed' && Boolean(verdict) && OUTCOMES.has(review.record?.modelOutcome);
  return { blindId, set, run, valid, modelOutcome: valid ? review.record.modelOutcome : null, effectiveOutcome: valid ? hostOutcome(review.record) : null,
    interceptions: review.record?.interceptions ?? [],
    confidence: verdict?.confidence ?? null, receiptStatus: review.receipt?.status ?? null, receiptReason: review.receipt?.reason ?? null,
    recordError: review.record?.error ?? null, attempts: review.receipt?.attempts ?? 0, durationMs: review.receipt?.durationMs ?? review.wallMs,
    inputTokens: review.receipt?.usage?.inputTokens ?? null, outputTokens: review.receipt?.usage?.outputTokens ?? null };
}

// The host's own rules (confidence under 0.85, attention) without the D-24
// gate: the gate is what this evaluation decides, so it is not scored.
const NOT_SCORED = new Set(['gate_not_passed', 'manual_policy']);
const hostOutcome = record => record.interceptions.some(reason => !NOT_SCORED.has(reason)) ? 'escalate' : record.modelOutcome;

async function main() {
  const { values } = parseArgs({ options: { cases: { type: 'string' }, out: { type: 'string' }, model: { type: 'string', default: 'qwen3.5:4b' },
    runs: { type: 'string', default: '3' }, seed: { type: 'string', default: '20261022' }, sets: { type: 'string', default: 'dev,holdout' } } });
  if (!values.cases || !values.out) throw new TypeError('--cases and --out are required');
  const runs = validRuns(Number(values.runs)), sampling = { temperature: 0, seed: Number(values.seed) };
  const sets = values.sets.split(',');
  // Nothing in this process may reach another host, whichever module asks,
  // directly or by redirect.
  globalThis.fetch = localOnlyFetch(globalThis.fetch);

  const startedAt = new Date().toISOString();
  const model = await modelIdentity(values.model);
  const cases = Object.fromEntries(sets.map(set => [set, JSON.parse(readFileSync(join(values.cases, `${set}.json`), 'utf8'))]));
  mkdirSync(values.out, { recursive: true });
  const harness = { commit: git(['rev-parse', 'HEAD']), uncommittedChanges: git(['status', '--porcelain']) !== '' };
  writeJson(join(values.out, 'model.json'), { model, sampling, samplingNote: 'temperature and seed are added to each chat request; '
    + 'every other generation setting is the model default listed in parameters', runs, harness });

  const path = createReviewPath({ model: values.model, sampling });
  const rows = Object.fromEntries(sets.map(set => [set, []]));
  try {
    // Run after run over every case, so a case's repeats are not back to back.
    for (let run = 1; run <= runs; run += 1) {
      for (const set of sets) {
        for (const { blindId, candidate } of cases[set]) {
          const requestId = `tonborg-review-v2:${set}:${blindId}:run-${run}`;
          const startedCall = new Date().toISOString();
          const review = await path.review(candidate, requestId);
          const row = compactRow({ blindId, set, run }, review);
          rows[set].push(row);
          writeJson(join(values.out, 'raw', set, blindId, `run-${run}.json`), { blindId, set, run, requestId, startedAt: startedCall, ...review });
          process.stdout.write(`run ${run} ${set} ${blindId} ${row.receiptStatus} model=${row.modelOutcome} host=${row.effectiveOutcome} `
            + `conf=${row.confidence} ${row.durationMs}ms\n`);
        }
      }
    }
  } finally {
    path.close();
  }
  for (const set of sets) writeJson(join(values.out, `results-${set}.json`), rows[set]);
  const loaded = await ollama('/api/ps');
  writeJson(join(values.out, 'run-meta.json'), { startedAt, finishedAt: new Date().toISOString(), node: process.version,
    ollamaLoaded: loaded.models?.filter(entry => entry.name === values.model).map(({ name, digest, context_length, size_vram }) =>
      ({ name, digest, context_length, size_vram })) ?? [], sets: Object.fromEntries(sets.map(set => [set, cases[set].length])) });
}

async function modelIdentity(name) {
  const version = await ollama('/api/version');
  const listed = (await ollama('/api/tags')).models?.find(entry => entry.name === name);
  if (!listed) throw new Error(`${name} is not installed in the local Ollama; this evaluation never pulls a model`);
  const shown = await ollama('/api/show', { model: name });
  return { name, ollamaVersion: version.version, digest: listed.digest, modifiedAt: listed.modified_at, size: listed.size,
    details: shown.details, capabilities: shown.capabilities ?? null, parameters: shown.parameters ?? null,
    templateSha256: shown.template ? contentHash(shown.template) : null, endpoint: `${OLLAMA_ORIGIN}/v1` };
}

async function ollama(path, body) {
  const response = await globalThis.fetch(`${OLLAMA_ORIGIN}${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!response.ok) throw new Error(`Ollama ${path} answered ${response.status}`);
  return response.json();
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
