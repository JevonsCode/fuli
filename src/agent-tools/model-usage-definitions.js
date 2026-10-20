import { MODEL_BACKEND_ROLES } from '../model-backends/config.js';
import { enumSchema, objectSchema, stringSchema } from './schema.js';

const dateTime = { ...stringSchema(), format: 'date-time' };

export const MODEL_USAGE_DEFINITIONS = [
  { name: 'get_model_usage', title: 'READ · Built-in Agent model usage',
    description: 'Model API usage of the built-in Agents (assistant = Astro, bole, jefa, tonborg) by role, provider, model and channel, with each role\'s budget window. One record per attempt; requests are distinct requestIds. Unknown usage stays null, never 0; cost is only a configured-price estimate. No prompts or keys.',
    inputSchema: objectSchema({ role: enumSchema(MODEL_BACKEND_ROLES), from: dateTime, to: dateTime }) }
];
