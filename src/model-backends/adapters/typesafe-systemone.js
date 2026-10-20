import { httpFailure } from '../failures.js';
import { reportedUsage } from '../usage.js';
import { attemptFailure, errorDetails, postJson, readFailure, readJsonBody, retryAfterMs } from './exchange.js';

// Jev (TypeSafe) typed decisions through POST /v1/systemone, as documented at
// docs.typesafe.ai/api: only bounded Choice and Score sub-steps. Free-text
// planning is never squeezed into Choice/Score, so other outputs are refused.
// The provider's confidence is reported as-is; it is not a calibrated FULI
// accuracy.

const DEFINITION = 'typesafe_systemone';
const QUESTION = 'answer';

export const typeSafeSystemOneAdapter = Object.freeze({
  protocol: 'typesafe_systemone',
  outputMode: 'typed',
  repairable: false,
  supports: request => ['choice', 'score'].includes(request.output.type) && request.decisions.includes('propose'),
  async call({ connection, secret, request, signal, fetchImpl }) {
    const unknown = { usage: reportedUsage({ definition: DEFINITION }) };
    const sent = await postJson({ fetchImpl, signal, url: `${connection.endpoint}/systemone`,
      headers: { authorization: `Bearer ${secret}` },
      body: {
        model: connection.model,
        state: { evidence: request.evidence.map(({ id, text }) => ({ id, text })) },
        questions: { [QUESTION]: question(request) }
      } });
    if (sent.failure) return attemptFailure(sent.failure, unknown);
    const { response } = sent;
    if (!response.ok) {
      return attemptFailure(httpFailure(response.status, await errorDetails(response),
        { retryAfterMs: retryAfterMs(response.headers) }), unknown);
    }
    let body;
    try {
      body = await readJsonBody(response);
    } catch (error) {
      return attemptFailure(readFailure(error), unknown);
    }
    const answer = body?.answers?.[QUESTION];
    const matches = answer?.type === request.output.type;
    return {
      ok: true,
      payload: request.output.type === 'choice' ? { choice: matches ? answer.choice : undefined } : { score: matches ? answer.score : undefined },
      reportedConfidence: typeof answer?.confidence === 'number' && answer.confidence >= 0 && answer.confidence <= 1 ? answer.confidence : null,
      usage: reportedUsage({ inputTokens: body?.usage?.input_tokens, outputTokens: body?.usage?.output_tokens, definition: DEFINITION }),
      actualModel: typeof body?.model === 'string' ? body.model : null
    };
  }
});

function question({ instructions, output }) {
  return output.type === 'choice'
    ? { type: 'choice', instructions, criteria: Object.fromEntries(output.options.map(option => [option.id, option.description])) }
    : { type: 'score', instructions, criteria: output.levels };
}
