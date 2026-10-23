import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sha256Bytes } from '../security/digest.js';
import { presenceRefused, verifiedPresence } from './platforms.js';
import { WIN_HELPER_SHA256 } from './windows-helper-pin.js';

const HELPER_PATH = fileURLToPath(new URL('../../native/win32/fuli-win-helper.exe', import.meta.url));
const HELPER_PROTOCOL = 1;
// The local user answers the Hello dialog within this time, well inside the challenge window.
const HELLO_TIMEOUT_MS = 120_000;
// One JSON line; anything longer is not the helper's answer.
const MAX_OUTPUT_BYTES = 4096;
// The helper reports the Windows names of UserConsentVerifierAvailability (stage
// availability) and UserConsentVerificationResult (stage verification).
const AVAILABILITY_STATES = new Set(['DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy']);
const VERIFICATION_REFUSALS = Object.freeze({
  Canceled: 'presence_canceled', RetriesExhausted: 'presence_failed', DeviceNotPresent: 'presence_unavailable',
  NotConfiguredForUser: 'presence_unavailable', DisabledByPolicy: 'presence_unavailable', DeviceBusy: 'presence_unavailable'
});
// The helper needs the Windows directories and nothing of FULI's environment.
const HELPER_ENVIRONMENT = ['SystemRoot', 'windir', 'TEMP', 'TMP'];

// Windows Hello through fuli-win-helper.exe hello, which calls
// IUserConsentVerifierInterop for the console window (or a hidden window when
// there is none). The helper runs only after its bytes match the digest pinned
// in this package; a missing pin or helper, a digest mismatch, a failed start, a
// timeout or any output other than one well-formed answer for this challenge is
// presence_unavailable. Nothing falls back to another way of asking.
export function windowsHelloPresence({
  helperPath = HELPER_PATH, pinnedDigest = WIN_HELPER_SHA256, spawnHelper = spawn, timeoutMs = HELLO_TIMEOUT_MS
} = {}) {
  async function verify({ challengeId, message }) {
    const integrity = await helperIntegrity(helperPath, pinnedDigest);
    if (integrity) return integrity;
    const run = await runHelper({ spawnHelper, helperPath, timeoutMs,
      input: JSON.stringify({ protocol: HELPER_PROTOCOL, challengeId, message }) });
    return run.refusal ?? helperAnswer(run.output, challengeId);
  }
  return { kind: 'hello', verify };
}

async function helperIntegrity(helperPath, pinnedDigest) {
  if (!pinnedDigest) return presenceRefused('presence_unavailable', 'helper_not_pinned');
  let bytes;
  try {
    bytes = await readFile(helperPath);
  } catch {
    return presenceRefused('presence_unavailable', 'helper_missing');
  }
  return sha256Bytes(bytes) === pinnedDigest ? null : presenceRefused('presence_unavailable', 'helper_digest_mismatch');
}

function runHelper({ spawnHelper, helperPath, timeoutMs, input }) {
  const unavailable = (detail) => ({ refusal: presenceRefused('presence_unavailable', detail) });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnHelper(helperPath, ['hello'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false,
        env: Object.fromEntries(HELPER_ENVIRONMENT.filter((name) => process.env[name]).map((name) => [name, process.env[name]])) });
    } catch {
      resolve(unavailable('helper_start_failed'));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // Only the process started here is stopped.
    const timer = setTimeout(() => { child.kill(); finish(unavailable('helper_timeout')); }, timeoutMs);
    child.on('error', () => finish(unavailable('helper_start_failed')));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(unavailable('helper_output_invalid'));
      } else chunks.push(chunk);
    });
    child.on('close', (code) => finish(code === 0
      ? { output: Buffer.concat(chunks).toString('utf8') } : unavailable('helper_failed')));
    // The helper may exit before it reads its input; its exit code reports that.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function helperAnswer(output, challengeId) {
  const invalid = presenceRefused('presence_unavailable', 'helper_output_invalid');
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return invalid;
  let answer;
  try {
    answer = JSON.parse(lines[0]);
  } catch {
    return invalid;
  }
  if (answer?.protocol !== HELPER_PROTOCOL || answer.command !== 'hello' || answer.challengeId !== challengeId) return invalid;
  if (answer.stage === 'verification') {
    if (answer.result === 'Verified') return verifiedPresence();
    return Object.hasOwn(VERIFICATION_REFUSALS, answer.result)
      ? presenceRefused(VERIFICATION_REFUSALS[answer.result], `hello_${answer.result}`) : invalid;
  }
  if (answer.stage === 'availability' && AVAILABILITY_STATES.has(answer.result)) {
    return presenceRefused('presence_unavailable', `hello_${answer.result}`);
  }
  return invalid;
}
