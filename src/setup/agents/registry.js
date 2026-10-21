import { adapter as claudeDesktop } from './claude-desktop/index.js';
import { adapter as gemini } from './gemini/index.js';
import { adapter as opencode } from './opencode/index.js';
import { adapter as qwenCode } from './qwen-code/index.js';
import { adapter as kiro } from './kiro/index.js';
import { descriptorAdapter } from './descriptor-adapter.js';
import { loadClientDescriptorPacks } from './descriptor-packs.js';

// One agent adapter port with two implementations (rec#18 D-10). The lifecycle
// clients (codex, claude-code, cursor) are described by built-in descriptor
// packs; these five keep their code adapters until they migrate. Callers see
// the same { id, detect, connect, disconnect, status } either way; this is the
// only module that knows which implementation serves an id.
const codeAdapters = [claudeDesktop, gemini, opencode, qwenCode, kiro];

export const agentAdapters = Object.freeze([
  ...loadClientDescriptorPacks({ reservedIds: codeAdapters.map(({ id }) => id) }).map(descriptorAdapter),
  ...codeAdapters
]);
export function agentAdapter(id) {
  const adapter = agentAdapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new TypeError(`Unsupported agent: ${id}`);
  return adapter;
}
