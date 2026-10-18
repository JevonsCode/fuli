import { adapter as adapter0 } from './codex/index.js';
import { adapter as adapter1 } from './claude-code/index.js';
import { adapter as adapter2 } from './cursor/index.js';
import { adapter as adapter3 } from './claude-desktop/index.js';
import { adapter as adapter4 } from './gemini/index.js';
import { adapter as adapter5 } from './opencode/index.js';
import { adapter as adapter6 } from './qwen-code/index.js';
import { adapter as adapter7 } from './kiro/index.js';

export const agentAdapters = Object.freeze([adapter0, adapter1, adapter2, adapter3, adapter4, adapter5, adapter6, adapter7]);
export function agentAdapter(id) {
  const adapter = agentAdapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new TypeError(`Unsupported agent: ${id}`);
  return adapter;
}
