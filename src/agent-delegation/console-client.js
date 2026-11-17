import { activeRunnerCaller } from '../app/agent-request-context.js';
import { ApplicationError } from '../app/application-error.js';
import { DELEGATION_HEADER, DELEGATION_OPERATION_HEADER, encodeDelegation } from './delegation-header.js';

const REQUEST_TIMEOUT_MS = 120_000;

// Sends an FLA's change for the person to the local console (rec#11 D-81),
// which decides, runs and records it; this process only carries the call.
// consoleUrl() is read at each call, so a moved console is still found.
// A runner's call (docs/runner.md) is refused: it comes from another computer,
// and this request would reach the console from this one, past its loopback check.
export function createDelegatedConsoleClient({ consoleUrl, fetchImpl = globalThis.fetch }) {
  return {
    async send({ method, path, body, call }) {
      if (activeRunnerCaller()) {
        throw new ApplicationError('local_user_only', 'Delegated changes are made only on this computer; '
          + 'a runner\'s Agents cannot change FULI\'s settings. Make the change on the host.', { status: 403 });
      }
      let response;
      try {
        response = await fetchImpl(new URL(path, consoleUrl()).href, {
          method,
          headers: { 'content-type': 'application/json', [DELEGATION_HEADER]: encodeDelegation(call) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch {
        throw new ApplicationError('console_unreachable',
          'FULI 控制台没有响应：请先运行 fuli start。 / The FULI console did not answer; run fuli start first.', { status: 503 });
      }
      const answer = await response.json().catch(() => null);
      if (!response.ok) {
        throw new ApplicationError(answer?.code ?? 'delegated_change_failed',
          answer?.error ?? `The console refused the change (${response.status})`, { status: response.status });
      }
      return { result: answer, operationId: response.headers.get(DELEGATION_OPERATION_HEADER) };
    }
  };
}
