// One single-skill paired evaluation: the same task, client and model with one
// selected stored workflow version off and on, then the same workflow on an
// unrelated negative control. Each arm gets a fresh temporary workspace; a live
// arm also gets a fresh isolated OpenCode home. The store is read-only. Results
// keep the actual output, files and checks per arm and name every case that was
// not measured.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { sha256File } from '../../src/security/digest.js';
import { writeArtifactFiles } from './artifacts.js';
import { DEFAULT_SCENARIO, safeRunDirectoryName } from './scenario.js';
import { gradeTask, measureNegativeControl, observeWorkspace } from './grading.js';
import { skillDigest } from './skill.js';

const SCHEMA = 'fuli.skill-paired-eval/1';

function armUnavailable({ arm, task, error, evidence = null }) {
  return {
    arm,
    task: task.id,
    kind: task.kind,
    skill: null,
    pass: null,
    grading: null,
    corrections: { count: null, unavailable: error.message },
    output: { stdout: '', stderr: '', exitCode: null, timedOut: false },
    files: {},
    changedPaths: [],
    newFiles: [],
    skipped: [],
    artifacts: null,
    evidence,
    unavailable: [error.message]
  };
}

function writeBaseline(workspace, files) {
  writeArtifactFiles(workspace, files, { label: 'scenario files' });
}

function unavailableFor(result, useSkill) {
  const items = [];
  if (result.artifacts?.error) items.push(result.artifacts.error);
  if (useSkill && result.evidence?.skillError) {
    items.push(`The live client could not read the selected Skill: ${result.evidence.skillError}`);
  }
  return items;
}

async function runArm({ arm, task, useSkill, selection, client, files }) {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-skill-pair-'));
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    writeBaseline(workspace, files);
    const result = await client.run({ task, selection: useSkill ? selection : null, workspace, files });
    const unavailable = unavailableFor(result, useSkill);
    if (result.artifacts?.error) {
      return { observation: null, record: { ...armUnavailable({ arm, task,
        error: new Error(result.artifacts.error), evidence: result.evidence }), client: client.identity, startedAt,
        durationMs: Date.now() - started } };
    }
    let written = null;
    if (result.artifacts?.files) {
      try {
        written = writeArtifactFiles(workspace, result.artifacts.files, { label: 'client artifacts' });
      } catch (error) {
        return { observation: null, record: { ...armUnavailable({ arm, task, error, evidence: result.evidence }),
          client: client.identity, startedAt, durationMs: Date.now() - started } };
      }
    }
    const observation = observeWorkspace({ directory: workspace, baseline: files,
      stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: result.timedOut,
      corrections: result.corrections, correctionsUnavailable: result.correctionsUnavailable });
    const grading = gradeTask(task, observation);
    return {
      observation,
      record: {
        arm,
        task: task.id,
        kind: task.kind,
        skill: useSkill ? { used: true, workflowId: selection.workflowId, version: selection.version,
          selectionId: selection.selectionId } : { used: false },
        client: client.identity,
        startedAt,
        durationMs: Date.now() - started,
        output: { stdout: observation.stdout, stderr: observation.stderr, exitCode: observation.exitCode,
          timedOut: observation.timedOut },
        files: observation.files,
        changedPaths: observation.changedPaths,
        newFiles: observation.newFiles,
        skipped: observation.skipped,
        pass: grading.pass,
        grading,
        corrections: grading.corrections,
        artifacts: written,
        evidence: result.evidence ?? null,
        unavailable
      }
    };
  } catch (error) {
    if (error.code !== 'client_unavailable') throw error;
    return {
      observation: null,
      record: { ...armUnavailable({ arm, task, error }), client: client.identity, startedAt,
        durationMs: Date.now() - started }
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function pairEffect(off, on) {
  const offPass = off?.pass ?? null;
  const onPass = on?.pass ?? null;
  if (offPass === null || onPass === null) return 'unknown';
  if (onPass && !offPass) return 'on_only';
  if (onPass && offPass) return 'both_pass';
  if (!onPass && offPass) return 'off_only';
  return 'neither_pass';
}

export async function evaluateSelectedWorkflow({ selection, out, client, scenario = DEFAULT_SCENARIO,
  negative = true, now = () => new Date(), pairId = null } = {}) {
  if (!selection?.selectionId) throw new TypeError('evaluateSelectedWorkflow needs one selected workflow version');
  if (!out) throw new TypeError('evaluateSelectedWorkflow needs an output directory');
  if (!client?.run) throw new TypeError('evaluateSelectedWorkflow needs a client');
  if (!scenario?.positive || !scenario?.negative) throw new TypeError('evaluateSelectedWorkflow needs a validated scenario');
  const runName = pairId === null ? `${now().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`
    : safeRunDirectoryName(pairId);
  const runDirectory = join(out, runName);
  mkdirSync(out, { recursive: true });
  try {
    // Exclusive: a retry with an existing pair id must fail rather than replace
    // an earlier report and its evidence.
    mkdirSync(runDirectory);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`A result directory already exists for pair "${runName}": ${runDirectory}. `
        + 'Choose a new --pair-id so earlier evidence is not overwritten.');
    }
    throw error;
  }

  let storeBefore;
  let storeUnavailable = null;
  try { storeBefore = await sha256File(selection.storePath); } catch (error) { storeUnavailable = error.message; }

  const positiveOff = await runArm({ arm: 'positive-off', task: scenario.positive, useSkill: false,
    selection, client, files: scenario.files });
  const positiveOn = await runArm({ arm: 'positive-on', task: scenario.positive, useSkill: true,
    selection, client, files: scenario.files });
  const negativeOn = negative
    ? await runArm({ arm: 'negative-on', task: scenario.negative, useSkill: true, selection, client, files: scenario.files })
    : null;

  const negativeControl = !negativeOn
    ? { measured: false, skillRead: null, triggered: null, pass: null, unavailable: 'The negative control was not run (--no-negative).' }
    : negativeOn.record.unavailable.length ? { measured: false, skillRead: null, triggered: null, pass: null,
      unavailable: negativeOn.record.unavailable.join('; ') }
    : measureNegativeControl(scenario.negative, negativeOn.observation,
      { skillRead: negativeOn.record.evidence?.skillRead ?? null });

  let storeAfter = null;
  try { storeAfter = await sha256File(selection.storePath); } catch (error) { storeUnavailable ??= error.message; }
  const storeUnchanged = storeBefore === null || storeAfter === null ? null : storeBefore === storeAfter;

  const unavailable = [
    ...positiveOff.record.unavailable,
    ...positiveOn.record.unavailable,
    ...(negativeOn?.record.unavailable ?? []),
    ...(negativeControl.unavailable ? [negativeControl.unavailable] : []),
    ...(storeUnavailable ? [storeUnavailable] : [])
  ];

  const result = {
    schema: SCHEMA,
    generatedAt: now().toISOString(),
    mode: client.identity.evidenceKind === 'live_client' ? 'live_client' : 'deterministic',
    evidenceKind: client.identity.evidenceKind,
    liveClient: client.identity.live,
    notes: client.identity.live
      ? ['This run used a real OpenCode v2 client in an isolated temporary setup and sent model requests to the configured provider. '
        + 'Whether upstream execution happened is reported per arm only when step events confirm it. '
        + 'It is evidence for this run only; it does not prove FULI delivered anything beyond the one selected Skill.']
      : ['Deterministic seam only: it exercises the harness with a built-in stand-in, not a model and not a live client. '
        + 'It contacts no provider. It is not evidence about a client.'],
    selection: {
      storeFile: basename(selection.storePath),
      storeSha256: storeBefore,
      workflowId: selection.workflowId,
      version: selection.version,
      selectionId: selection.selectionId,
      name: selection.name,
      purpose: selection.purpose,
      steps: selection.steps,
      ...(selection.workMap ? { workMap: selection.workMap } : {}),
      ...(selection.lesson ? { lesson: selection.lesson } : {}),
      usedWorkflowCount: 1,
      status: selection.status,
      active: selection.active,
      confirmed: selection.confirmed,
      confirmedBy: selection.confirmedBy,
      confirmedAt: selection.confirmedAt,
      source: selection.source,
      createdBy: selection.createdBy,
      personalSpaceId: selection.personalSpaceId,
      agentId: selection.agentId,
      personalProjectId: selection.personalProjectId,
      skillSha256: skillDigest(selection)
    },
    setup: {
      scenario: scenario.name ?? null,
      scenarioFiles: Object.keys(scenario.files).sort(),
      positiveTask: scenario.positive.id,
      negativeTask: negative ? scenario.negative.id : null,
      client: client.identity,
      isolation: client.identity.live
        ? 'Each arm used a fresh temporary workspace, a fresh isolated OpenCode home and a separate --standalone process; '
          + 'no MCP server or plugin was configured; only the selected Skill tool was allowed; the configured model provider '
          + 'is contacted when the client sends a request, and actual upstream execution is read per arm from step events.'
        : 'Each arm used a fresh temporary workspace; the workflow store was opened read-only and no run was recorded. '
          + 'The deterministic seam contacted no provider.',
      workspaceDisposed: true
    },
    arms: {
      positiveOff: positiveOff.record,
      positiveOn: positiveOn.record,
      negativeOn: negativeOn?.record ?? null
    },
    pair: {
      sameTask: true,
      offPass: positiveOff.record.pass,
      onPass: positiveOn.record.pass,
      effect: pairEffect(positiveOff.record, positiveOn.record)
    },
    negativeControl,
    storeUnchanged,
    unavailable,
    runDirectory
  };
  writeFileSync(join(runDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
