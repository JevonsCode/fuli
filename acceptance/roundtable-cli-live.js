// Opt-in real client/model acceptance. Never invoked by node --test or CI.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRoundtableServer } from '../src/roundtables/server.js';
import { runRoundtableWorker } from '../src/roundtables/worker.js';
import { createRoundtableParticipant } from '../src/roundtables/participant-registry.js';
import { runParticipantProcess } from '../src/roundtables/process.js';
import { writeFileSync } from 'node:fs';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new TypeError(`${name} requires a value`);
  return value;
}

if (!process.argv.includes('--run')) {
  console.log('Opt-in: node acceptance/roundtable-cli-live.js --run [--output report.json] [--reasoning-effort low] [--implementer-runtime pi --implementer-model MODEL]. Runs seven real turns in a disposable authorized workspace. Moderator/reviewer use your existing Codex login; optional Pi implementer uses your explicitly selected local Ollama model.');
} else {
  const implementerRuntime = option('--implementer-runtime') ?? 'codex';
  const implementerModel = option('--implementer-model');
  const reasoningEffort = option('--reasoning-effort');
  const outputPath = option('--output');
  if (!['codex', 'pi'].includes(implementerRuntime)) throw new TypeError('Acceptance implementer runtime must be codex or pi');
  if (reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new TypeError('Select a supported explicit Codex reasoning effort');
  const directory = mkdtempSync(join(tmpdir(), 'fuli-roundtable-live-'));
  const host = await createRoundtableServer({ dataDir: directory, port: 0 });
  const owner = { kind: 'owner' };
  const controller = new AbortController();
  const marker = `FULI_ROUNDTABLE_${randomUUID()}`;
  const targetPath = join(directory, 'roundtable-evidence.txt');
  const goal = `Create roundtable-evidence.txt in the authorized workspace with exact contents ${marker} and no trailing newline. Discuss briefly, plan, implement, independently review that file's exact contents, then synthesize the actual result and any dissent. Discussion and planning turns only propose the steps and are read-only for every seat. The implementer receives write permission only during its implementation turn. The reviewer reads and verifies the actual file only during its review turn. Do not change any other files or contact external services. Moderator and reviewer are always read-only. Report structured JSON with actual artifact references and explicit review verdict.`;
  const room = host.service.create({ goal, mode: 'collaboration', limits: { maxRounds: 1, maxMessages: 12, maxDurationMs: 1_800_000, turnTimeoutMs: 300_000 },
    seats: [{ id: 'moderator', name: 'Moderator', role: 'moderator', runtime: 'codex' },
      { id: 'implementer', name: 'Implementer', role: 'implementer', runtime: implementerRuntime, execution: { permission: 'workspace-write', workspace: directory } },
      { id: 'reviewer', name: 'Reviewer', role: 'reviewer', runtime: 'codex' }] }, owner).room;
  const workerEvents = [], invitationTokens = [], dispatches = [], processDiagnostics = [];
  const sensitiveValues = Object.entries(process.env).filter(([key, value]) => /token|secret|password|credential|api.?key/i.test(key) && typeof value === 'string' && value.length >= 8).map(([, value]) => value);
  const sanitize = value => {
    let serialized = JSON.stringify(value);
    for (const secret of [...invitationTokens, ...sensitiveValues]) {
      serialized = serialized.split(secret).join('[REDACTED]');
      serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    }
    serialized = serialized.split(JSON.stringify(directory).slice(1, -1)).join('<scratch-workspace>');
    serialized = serialized.split(directory.replaceAll('\\', '/')).join('<scratch-workspace>');
    serialized = serialized.split(host.url).join('<local-coordinator>');
    return JSON.parse(serialized);
  };
  const workers = room.seats.map((seat) => {
    const token = host.service.invite({ roomId: room.id, seatId: seat.id }, owner).seatToken;
    invitationTokens.push(token);
    const workerEnvironment = { ...process.env, FULI_ROUNDTABLE_TOKEN: token };
    const model = seat.id === 'implementer' ? implementerModel : undefined;
    const observedRunProcess = async (command, args, options) => {
      const receipt = { seatId: seat.id, category: args.includes('exec') ? 'codex_exec' : args.includes('--print') ? 'pi_dispatch' : 'preflight_or_isolation', startedAt: new Date().toISOString() };
      processDiagnostics.push(receipt);
      try {
        const result = await runParticipantProcess(command, args, options);
        receipt.finishedAt = new Date().toISOString(); receipt.exitCode = result.code;
        if (receipt.category !== 'preflight_or_isolation') {
          const events = result.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
          receipt.eventTypes = events.slice(-200).map(event => event.type);
          receipt.eventTypesTruncated = events.length > 200;
          receipt.terminalOutcome = events.findLast(event => ['turn.completed', 'turn.failed'].includes(event.type))?.type ?? null;
          receipt.errors = sanitize(events.filter(event => ['error', 'turn.failed', 'extension_error'].includes(event.type)).map(event => ({ type: event.type, message: String(event.message ?? event.error?.message ?? event.error ?? '').slice(0, 200) })));
          const final = events.findLast(event => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item?.text;
          if (final) { let envelope; try { envelope = JSON.parse(final); } catch { envelope = final.slice(0, 16_384); } receipt.finalEnvelopeBeforeParser = sanitize(envelope); }
        }
        return result;
      } catch (error) { receipt.finishedAt = new Date().toISOString(); receipt.error = error.code ?? error.name; throw error; }
    };
    const participant = createRoundtableParticipant(seat.runtime, { workspace: directory, env: workerEnvironment, model,
      reasoningEffort: seat.runtime === 'codex' ? reasoningEffort : undefined, runProcess: observedRunProcess });
    const observedParticipant = { ...participant, async dispatch(input) {
      const receipt = { seatId: seat.id, turnId: input.turn.turnId, phase: input.turn.context.phase,
        allowWrite: input.allowWrite, startedAt: new Date().toISOString() };
      dispatches.push(receipt);
      try {
        const result = await participant.dispatch(input);
        receipt.finishedAt = new Date().toISOString(); receipt.actual = sanitize(result.actual);
        let envelope; try { envelope = JSON.parse(result.body); } catch { envelope = result.body; }
        receipt.finalEnvelope = sanitize(envelope);
        return result;
      } catch (error) { receipt.finishedAt = new Date().toISOString(); receipt.error = error.code ?? error.name; throw error; }
    } };
    return runRoundtableWorker({ url: host.url, roomId: room.id, runtime: seat.runtime, workspace: directory,
      allowWrite: seat.role === 'implementer', env: workerEnvironment, signal: controller.signal, participant: observedParticipant,
      onEvent: (event) => { const receipt = sanitize({ seat: seat.id, ...event }); workerEvents.push(receipt); console.log(JSON.stringify(receipt)); } }).catch((error) => {
        const receipt = sanitize({ seat: seat.id, status: 'worker_error', error: error.code ?? error.name, message: error.message });
        workerEvents.push(receipt); console.log(JSON.stringify(receipt)); return receipt;
      });
  });
  let snapshot, report;
  const deadline = Date.now() + 1_800_000;
  try {
    while (Date.now() < deadline) {
      snapshot = host.service.read({ roomId: room.id }, owner);
      if (snapshot.room.status === 'draft' && snapshot.room.seats.every((seat) => seat.joinedAt !== null)) host.service.control({ roomId: room.id, action: 'start' }, owner);
      if (['paused', 'waiting_input', 'cancelled', 'failed', 'waiting_auth'].includes(snapshot.room.status)) break;
      if (workerEvents.some(event => event.status === 'worker_error')) break;
      await delay(250);
    }
    snapshot = host.service.read({ roomId: room.id }, owner);
    let artifactMatches = false, artifact = { exists: false, relativePath: 'roundtable-evidence.txt', expectedSha256: createHash('sha256').update(marker).digest('hex') };
    try {
      const content = readFileSync(targetPath);
      artifactMatches = content.toString('utf8') === marker;
      artifact = { ...artifact, exists: true, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), exactContentsMatch: artifactMatches };
    } catch (error) { artifact.error = error.code ?? error.name; }
    const phases = new Map(dispatches.map(dispatch => [dispatch.turnId, dispatch.phase]));
    const actual = snapshot.messages.filter((message) => message.actual).map((message) => ({ phase: phases.get(message.turnId) ?? 'unknown',
      seatId: message.seatId, status: message.status, ...message.actual }));
    const review = snapshot.messages.findLast((message) => message.seatId === 'reviewer' && message.verification?.reported?.passed !== null);
    report = { checkedAt: new Date().toISOString(), evidenceLevel: 'real_cli_local_network',
      runtime: implementerRuntime === 'codex' ? 'codex' : 'mixed', configuredRuntimes: [...new Set(room.seats.map(seat => seat.runtime))], physicalComputers: 1, independentSeats: 3,
      requestedReasoningEffort: reasoningEffort ?? null,
      status: snapshot.room.status, phase: snapshot.room.phase, stopReason: snapshot.room.stopReason,
      artifactMatches, reviewPassed: review?.verification?.reported?.passed === true,
      reachedSynthesis: snapshot.room.phase === 'synthesis' && Boolean(snapshot.outcome),
      humanAcceptance: 'not_performed', artifact, actual,
      diagnostics: sanitize({ messages: snapshot.messages.map(({ body, ...message }) => ({ ...message, body })),
        attempts: snapshot.attempts, events: snapshot.events, tasks: snapshot.tasks, workerEvents, dispatches, processDiagnostics,
        workspaceAuthorization: { coordinatorPermission: room.seats.find(seat => seat.id === 'implementer').execution.permission,
          implementerLocalWriteEnabled: true, reviewerLocalWriteEnabled: false,
          targetWorkspaceMatchesWorker: true } }) };
    if (!artifactMatches || !report.reviewPassed || !report.reachedSynthesis) process.exitCode = 1;
  } finally {
    controller.abort(); const workerResults = await Promise.allSettled(workers); await host.close();
    const absolute = resolve(directory), root = resolve(tmpdir());
    if (!absolute.startsWith(`${root}\\`) && !absolute.startsWith(`${root}/`)) throw new Error('Unexpected test workspace path');
    rmSync(absolute, { recursive: true, force: true });
    if (report) {
      report.diagnostics.workerEvents = sanitize(workerEvents);
      report.diagnostics.dispatches = sanitize(dispatches);
      report.diagnostics.workerResults = sanitize(workerResults);
      report.diagnostics.processDiagnostics = sanitize(processDiagnostics);
      report.cleanup = { cancellationRequested: true, workerPromisesSettled: true, coordinatorClosed: true, ownedWorkspaceRemoved: true };
      console.log(JSON.stringify(report));
      if (outputPath) writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2));
    }
  }
}
