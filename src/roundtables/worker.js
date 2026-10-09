import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { createRoundtableParticipant } from './participant-registry.js';
import { PARTICIPANT_RESULT_SCHEMA, parseRoundtableParticipantResult } from './result-contract.js';
import { createRoundtableTaskPrompt } from './turn-prompt.js';

export function validateCoordinatorUrl(value, { allowHttp = false } = {}) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowHttp)))) {
    throw new TypeError('Coordinator requires HTTPS or explicit HTTP test mode');
  }
  return url.origin;
}

export async function runRoundtableWorker({ url, roomId, runtime, workspace = process.cwd(),
  allowWrite = false, model, a2aUrl, env = process.env, signal, once = false,
  allowHttp = false, fetchImpl = globalThis.fetch, participant: configuredParticipant, onEvent = () => {} }) {
  const base = validateCoordinatorUrl(url, { allowHttp });
  const token = env.FULI_ROUNDTABLE_TOKEN;
  if (!token) throw new TypeError('Set FULI_ROUNDTABLE_TOKEN to your seat invitation');
  const participant = configuredParticipant ?? createRoundtableParticipant(runtime, { workspace, model, url: a2aUrl, env });
  const call = async (operation, input = {}, requestSignal = signal) => {
    const response = await fetchImpl(`${base}/roundtable-peer/v1/rooms/${encodeURIComponent(roomId)}/${operation}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input), redirect: 'error', signal: requestSignal
    });
    if (!response.ok) throw Object.assign(new Error(`Roundtable ${operation} failed (${response.status})`), { code: 'coordinator_error', status: response.status });
    return response.json();
  };
  try {
    const ready = await participant.preflight({ signal });
    if (!ready.ready) throw Object.assign(new Error(`Participant not ready: ${ready.reason}`), { code: ready.code ?? ready.reason });
    await call('join'); onEvent({ status: 'joined', runtime });
    while (!signal?.aborted) {
      const snapshot = await call('read');
      if (['concluded', 'cancelled', 'failed'].includes(snapshot.room.status)) return { status: snapshot.room.status };
      const turn = await call('claim');
      if (!turn) { if (once) return { status: 'waiting_turn' }; await delay(1000, undefined, { signal }); continue; }
      const controller = new AbortController();
      const turnSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const deadline = typeof turn.deadline === 'number' ? turn.deadline : Date.parse(turn.deadline);
      if (!Number.isFinite(deadline)) throw new TypeError('Invalid coordinator deadline');
      const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      const watcher = setInterval(() => {
        void call('read', {}, turnSignal).then((state) => {
          const current = state.currentTurn;
          if (['cancelled', 'failed', 'concluded'].includes(state.room.status) ||
              !current || current.id !== turn.turnId || current.attemptId !== turn.attemptId ||
              current.fence !== turn.fence || current.status !== 'claimed') controller.abort();
        }).catch(() => controller.abort());
      }, 1000);
      let result;
      try {
        const seat = turn.context?.seat;
        const permitted = allowWrite && turn.context?.phase === 'implementation' && seat?.role === 'implementer' &&
          seat.execution?.permission === 'workspace-write' && resolve(seat.execution.workspace) === resolve(workspace);
        const prompt = `${createRoundtableTaskPrompt(turn.context, { allowWrite: permitted })}\nReturn ONLY a JSON object matching this schema, within 16 KiB: ${JSON.stringify(PARTICIPANT_RESULT_SCHEMA)}. Implementation requires real artifact references. Review requires an explicit passed true/false verdict and evidence. For other phases passed can be null.`;
        const dispatched = await participant.dispatch({ prompt, turn, signal: turnSignal, allowWrite: permitted, resultSchema: PARTICIPANT_RESULT_SCHEMA });
        result = parseRoundtableParticipantResult(dispatched, turn.context?.phase);
      } catch (error) {
        const code = error.code ?? 'runtime_failed';
        result = { body: error.body ?? `Participant interrupted: ${code}`,
          status: ['waiting_auth', 'waiting_input'].includes(code) ? 'blocked' : 'failed',
          blockedReason: ['waiting_auth', 'waiting_input'].includes(code) ? code : undefined,
          actual: { sourceApplication: runtime, model: null, sessionId: null, usage: null,
            evidenceLevel: 'execution_failure', ...error.actual,
            ...(error.remoteTaskId ? { remoteTaskId: error.remoteTaskId } : {}),
            cancellationConfirmed: typeof error.cancellationConfirmed === 'boolean' ? error.cancellationConfirmed : null } };
      } finally { clearTimeout(timeout); clearInterval(watcher); controller.abort(); }
      const artifacts = (result.artifacts ?? []).map((artifact) => typeof artifact === 'string' ? artifact : {
        id: artifact.id ?? artifact.artifactId, ...(artifact.name ? { name: artifact.name } : {}),
        ...(artifact.uri ? { uri: artifact.uri } : {}), ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {})
      });
      const submitted = await call('submit', {
        ...result, turnId: turn.turnId, attemptId: turn.attemptId, fence: turn.fence,
        artifacts, idempotencyKey: `attempt-${turn.attemptId}`, ...(result.kind ? { kind: result.kind } : {}), status: result.status ?? 'completed'
      });
      onEvent({ status: result.status ?? 'completed', runtime, turnId: turn.turnId });
      if (once || ['failed', 'blocked'].includes(result.status)) return { status: result.status ?? 'completed', submitted };
    }
    return { status: 'cancelled' };
  } finally { await participant.close?.(); }
}
