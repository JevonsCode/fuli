import { MODEL_BACKEND_ROLES } from '../model-backends/config.js';
import { enumSchema, integerSchema, objectSchema, stringSchema } from './schema.js';

const dateTime = { ...stringSchema(), format: 'date-time' };
const id = { ...stringSchema(), minLength: 1, maxLength: 256 };
const tokens = integerSchema({ minimum: 0 });

export const MODEL_BACKEND_DEFINITIONS = [
  { name: 'get_model_usage', title: 'READ · Built-in Agent model usage',
    description: 'Model API usage of the built-in Agents (assistant = Astro, bole, jefa, tonborg) by role, provider, model and channel, with each role\'s budget window. One record per attempt; requests are distinct requestIds. Unknown usage stays null, never 0; cost is only a configured-price estimate. No prompts or keys.',
    inputSchema: objectSchema({ role: enumSchema(MODEL_BACKEND_ROLES), from: dateTime, to: dateTime }) },
  { name: 'role_work', title: 'WRITE · Built-in Agent work package',
    description: 'Answer a built-in Agent\'s handed-off work package in this session. claim (optional packageId) returns instructions, evidence, answerSchema and a lease; submit sends answer within it. The host validates it like a model answer; the role keeps its permission gates. Late or mismatched answers are stale. Never an independent verification.',
    inputSchema: objectSchema({ action: enumSchema(['claim', 'submit']), taskContextToken: id, packageId: id, leaseToken: id,
      answer: { type: 'object' }, usage: objectSchema({ inputTokens: tokens, outputTokens: tokens }) }, ['action', 'taskContextToken']) }
];
