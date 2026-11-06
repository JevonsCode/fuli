import { createJudgmentBackend } from '../../src/judgment/backend.js';
import { createJudgmentEngine } from '../../src/judgment/engine.js';
import { createJudgmentService } from '../../src/judgment/service.js';
import { JudgmentStore } from '../../src/judgment/store.js';
import { readModelBackendConfig } from '../../src/model-backends/config.js';
import { modelFetch } from '../../src/model-backends/model-fetch.js';
import { createModelBackendPort } from '../../src/model-backends/port.js';
import { createRoleWorkBridge } from '../../src/model-backends/role-work.js';
import { RoleWorkStore } from '../../src/model-backends/role-work-store.js';
import { ModelUsageLedger } from '../../src/model-backends/usage-ledger.js';
import { completePreferences } from '../../test/fixtures/collaboration-preferences.js';
import { createAnthropicGatewayTransport } from './anthropic-gateway-transport.js';
import { CHAT_PATH, OLLAMA_ORIGIN, createLocalOllamaTransport } from './local-ollama-transport.js';

// One Tonborg knowledge_review of one synthetic candidate through FULI's
// production path (rec#26): the judgment service and engine build the request
// (engine.js review: instructions, schema and DATA { policy, preferences,
// memory, feedback, candidates }), the judgment backend turns DATA into
// evidence items (backend.js judgmentRequest, decisions ['propose']), the
// role-work bridge calls the model port, and the port's openai_chat adapter
// talks to the local Ollama only, or, given a gateway, its anthropic_messages
// adapter talks to that one Anthropic-compatible endpoint only. The Provider
// is a synthetic stand-in that offers the one candidate and has no write
// path; every store is in memory.

export const SYNTHETIC_SPACE = 'synthetic-space';
export const SYNTHETIC_PROJECT = 'synthetic-alpha';
const OPERATION = 'knowledge_review';
const CONNECTION = 'evaluated-model';
// The gateway checks no key (rec#26); the port still requires a key reference for
// anthropic_messages, so it gets this placeholder and never a stored secret.
const GATEWAY_KEY = Object.freeze({ ref: 'evaluation-gateway', value: 'placeholder' });
// Room for the production review prompt and one verdict; the port enforces both.
const EVAL_BUDGET = Object.freeze({ maxInputTokens: 16_000, maxOutputTokens: 800, timeoutMs: 120_000,
  windowHours: 24, maxTokensPerWindow: 50_000_000 });
// A gateway model may count hidden reasoning against max_tokens (gpt-5.6 spends
// about 2,400 on one review), so 800 cuts every answer off. A role saved with
// no per-call output limit gets the port's default; the evaluation does the same.
const GATEWAY_BUDGET = Object.freeze({ ...EVAL_BUDGET, maxOutputTokens: null });
// Provider calls that would change knowledge; the stand-in refuses them all.
const PROVIDER_WRITES = Object.freeze(['recordKnowledgeReviewProgress']);

// gateway: { endpoint, headers } of an Anthropic-compatible gateway, or null for the local Ollama.
// fetchImpl defaults to the port's own, which also reaches a model on a port fetch blocks (such as 6666).
export function createReviewPath({ model, sampling, fetchImpl = modelFetch, gateway = null, budget = gateway ? GATEWAY_BUDGET : EVAL_BUDGET }) {
  let exchanges = [];
  const evaluated = evaluatedBackend({ model, sampling, fetchImpl, gateway, onExchange: exchange => exchanges.push(exchange) });
  const config = { version: 1,
    connections: { [CONNECTION]: evaluated.connection },
    roles: { tonborg: { enabled: true, connection: CONNECTION, allowedOperations: [OPERATION], budget, fallbackToSession: false,
      egress: { approvedProjects: [{ personalSpaceId: SYNTHETIC_SPACE, personalProjectId: SYNTHETIC_PROJECT }], allowUnassigned: false } } } };
  const port = createModelBackendPort({ readConfig: () => readModelBackendConfig('inline', { read: () => config }),
    secrets: { read: async ref => {
      if (gateway && ref === GATEWAY_KEY.ref) return GATEWAY_KEY.value;
      throw new Error('The evaluation uses no secrets');
    } },
    ledger: new ModelUsageLedger(':memory:'), fetchImpl: evaluated.transport });
  const refuse = what => async () => { throw new Error(`${what} is not part of the evaluation`); };
  const bridge = createRoleWorkBridge({ port, store: new RoleWorkStore(':memory:'), verifySession: refuse('A session claim'), resumers: {} });
  const backend = createJudgmentBackend({ bridge, legacy: refuse('A CLI judgment client') });
  // Everything outside DATA of the first request; every later request must repeat it exactly.
  let instructionArea = null;

  async function review(candidate, requestId) {
    exchanges = [];
    const provider = syntheticProvider(candidate);
    const judged = [];
    const judge = async call => {
      const response = await backend(call);
      judged.push({ call, response });
      return response;
    };
    const service = createJudgmentService({ app: provider.app, openStore: () => new JudgmentStore(':memory:'),
      engine: createJudgmentEngine({ app: provider.app, judge }) });
    const started = Date.now();
    let result;
    try {
      result = await service.review({ personalSpaceId: SYNTHETIC_SPACE, personalProjectId: SYNTHETIC_PROJECT, requestId, limit: 1 });
    } finally {
      service.close();
    }
    const wallMs = Date.now() - started;
    const [{ call, response } = {}] = judged;
    const record = result.records.find(item => item.target === candidate.candidate_key) ?? result.records.at(-1) ?? null;
    const chats = exchanges.filter(exchange => evaluated.isChat(exchange.url));
    instructionArea = assertReviewBoundary({ call, chats, candidate, record, provider, instructionArea, messagesOf: evaluated.messagesOf });
    return {
      judgment: call ? { operation: call.operation, instructions: call.instructions, data: call.data, schema: call.schema } : null,
      exchanges: chats,
      modelVerdict: response?.status === 'answered' ? response.value.decisions?.[0] ?? null : null,
      receipt: response?.modelReceipt ?? record?.modelReceipt ?? null,
      // outcome is the host's gated outcome; modelOutcome and interceptions are what the host's gate (D-24, D-36) recorded beside it.
      record: record && { target: record.target, outcome: record.outcome, modelOutcome: record.aiReview?.modelOutcome ?? null,
        interceptions: record.aiReview?.interceptions ?? [], confidence: record.confidence ?? null,
        summary: record.summary ?? null, error: record.error ?? null, execution: record.execution.status },
      wallMs
    };
  }

  return { review, close: () => { bridge.close(); port.close(); } };
}

// The connection under evaluation, its checked transport, and how to read the
// system text and first user turn back out of one of its requests (a repair appends turns).
function evaluatedBackend({ model, sampling, fetchImpl, gateway, onExchange }) {
  if (!gateway) {
    return { connection: { protocol: 'openai_chat', endpoint: `${OLLAMA_ORIGIN}/v1`, model, secretRef: null, reasoningEffort: 'none' },
      transport: createLocalOllamaTransport({ sampling, fetchImpl, onExchange }),
      isChat: url => new URL(url).pathname === CHAT_PATH,
      messagesOf: body => ({ system: body.messages[0]?.content, user: body.messages[1]?.content }) };
  }
  return { connection: { protocol: 'anthropic_messages', endpoint: gateway.endpoint, model, secretRef: GATEWAY_KEY.ref, headers: gateway.headers },
    // The gateway transport serves nothing but the messages route.
    transport: createAnthropicGatewayTransport({ endpoint: gateway.endpoint, sampling, fetchImpl, onExchange }),
    isChat: () => true,
    messagesOf: body => ({ system: body.system, user: body.messages[0]?.content }) };
}

function syntheticProvider(candidate) {
  const writes = [];
  const refuseWrite = name => async () => {
    writes.push(name);
    throw new Error(`${name}: the evaluation has no write path`);
  };
  const app = {
    config: { personal: { spaceId: SYNTHETIC_SPACE } },
    listPersonalProjects: async () => [{ project_id: SYNTHETIC_PROJECT, profile: { lifecycle: 'active' } }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg',
      profile: { status: 'active', allowedClients: ['codex', 'claude_code'], capabilities: ['fuli.employee:tonborg'] } }],
    // A complete preference answer with no rules: every case is judged on its candidate alone.
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    startKnowledgeReview: async () => ({ review_id: 'synthetic-review' }),
    listKnowledgeReviewCandidates: async () => ({ candidates: [structuredClone(candidate)], total_candidate_count: 1 }),
    finishKnowledgeReview: async () => ({}),
    readKnowledgeReviewDecision: async () => ({ decision: null }),
    ...Object.fromEntries(PROVIDER_WRITES.map(name => [name, refuseWrite(name)]))
  };
  return { app, writes };
}

// rec#26: the candidate reaches the model only inside DATA, the only decision
// is propose, no tools are offered and nothing is written. The instruction
// area (system message, TASK and DECISIONS) must be the same text for every
// candidate, so no candidate text can be in it; a substring search would
// mistake a short title such as "Preference" inside the fixed rules for a leak.
// Returns the instruction area for the next review to compare with.
function assertReviewBoundary({ call, chats, candidate, record, provider, instructionArea, messagesOf }) {
  if (provider.writes.length) throw new Error(`The review tried to write: ${provider.writes.join(', ')}`);
  if (record && record.execution.status !== 'not_applied') {
    throw new Error(`A review record left the evaluation with execution ${record.execution.status}`);
  }
  if (!call) return instructionArea;
  if (call.operation !== OPERATION || call.policy.mode !== 'manual') {
    throw new Error('The evaluation must run knowledge_review under the default manual policy');
  }
  if (!call.data.candidates?.some(item => item.candidate_key === candidate.candidate_key)) {
    throw new Error('The candidate is missing from the judgment DATA');
  }
  let area = instructionArea;
  for (const chat of chats) {
    const { system: sent, user } = messagesOf(JSON.parse(chat.requestBody));
    const system = withoutPromptModeSchema(sent);
    const [task, decisions, dataLine, ...rest] = user.split('\n');
    if (rest.length || task !== `TASK: ${call.instructions}` || decisions !== 'DECISIONS: propose' || !dataLine?.startsWith('DATA: ')) {
      throw new Error('The user message must be exactly TASK, DECISIONS: propose and DATA');
    }
    const outside = `${system}\n${task}\n${decisions}`;
    if (area !== null && outside !== area) throw new Error('The instruction area changed with the candidate');
    area = outside;
    const evidence = JSON.parse(dataLine.slice('DATA: '.length)).evidence;
    const offered = JSON.parse(evidence.find(item => item.id === 'candidates')?.text ?? '[]');
    if (JSON.stringify(offered) !== JSON.stringify(call.data.candidates)) throw new Error('DATA does not carry the candidates as the engine built them');
  }
  return area;
}

// Once an endpoint ignores the output schema, the port writes the schema into
// the system text for every later call (prompt.js promptForMode). That suffix
// names the candidate's key in its target enum, so it is set apart before the
// instruction area is compared; it must still be one JSON schema and nothing else.
const PROMPT_MODE_SCHEMA = '\nThe reply must match this JSON schema: ';

function withoutPromptModeSchema(system) {
  const at = system.indexOf(PROMPT_MODE_SCHEMA);
  if (at < 0) return system;
  JSON.parse(system.slice(at + PROMPT_MODE_SCHEMA.length));
  return system.slice(0, at);
}
