import { spawn } from 'node:child_process';

// Own exactly one child/process group; never search for or kill unrelated clients.
export function runParticipantProcess(command, args, { cwd, env = process.env, signal,
  input, timeoutMs = 300_000, maxOutputBytes = 2_000_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', outputBytes = 0, failure, settled = false, hardTimer;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.on('error', () => child.kill()); killer.unref();
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(hardTimer); signal?.removeEventListener('abort', abort);
      kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      if (error || failure) reject(error ?? failure); else resolve({ code, stdout: output });
    };
    const stop = (code) => {
      if (failure || settled) return;
      failure = Object.assign(new Error(code), { code }); kill();
      hardTimer = setTimeout(() => finish(failure), 2000);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('turn_timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { stop('output_too_large'); return; }
      output += chunk.toString('utf8');
    });
    // Drain upstream stderr without echoing keys, prompts, settings or credentials.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(Object.assign(new Error('Participant process unavailable'), { code: 'runtime_unavailable' })));
    child.on('close', (code) => finish(null, code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function parseParticipantEvents(application, result) {
  const events = result.stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  let body = '', sessionId = null, usage = null, failed = result.code !== 0;
  let codexCompleted = false, pendingCodexError = false;
  for (const event of events) {
    sessionId ??= event.thread_id ?? event.session_id ?? null;
    if (application === 'codex') {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') body = event.item.text ?? '';
      if (event.type === 'turn.completed') {
        usage = event.usage ?? null; codexCompleted = true; pendingCodexError = false;
      }
      if (event.type === 'error') pendingCodexError = true;
      if (event.type === 'turn.failed') failed = true;
    } else if (event.type === 'result') {
      body = event.structured_output ? JSON.stringify(event.structured_output) : event.result ?? ''; usage = event.usage ?? null; failed ||= Boolean(event.is_error);
    }
  }
  const actual = { sourceApplication: application, sessionId, model: null,
    usage: usage ? { source: 'executor', ...usage } : null, evidenceLevel: 'real_cli' };
  if (application === 'codex' && (!codexCompleted || pendingCodexError)) failed = true;
  if (failed) throw Object.assign(new Error('Participant execution failed; inspect client authorization locally'), { code: 'runtime_failed', actual });
  if (!body || Buffer.byteLength(body) > 16_384) throw Object.assign(new Error('Participant final response missing or too large'), { code: 'response_invalid', actual });
  return { body, actual };
}
