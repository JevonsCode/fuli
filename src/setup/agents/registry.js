import { adapter as claudeDesktop } from './claude-desktop/index.js';
import { adapter as gemini } from './gemini/index.js';
import { adapter as qwenCode } from './qwen-code/index.js';
import { adapter as kiro } from './kiro/index.js';
import { descriptorAdapter } from './descriptor-adapter.js';
import { loadClientDescriptorPacks } from './descriptor-packs.js';
import { installedClientPacks } from './client-pack-store.js';
const codeAdapters = [claudeDesktop, gemini, qwenCode, kiro];
export const agentAdapters = Object.freeze([
  ...loadClientDescriptorPacks({ reservedIds: codeAdapters.map(({ id }) => id) }).map(descriptorAdapter), ...codeAdapters
]);
export function configuredAgentAdapters(dataDir) {
  return dataDir ? [...installedClientPacks(dataDir).map(descriptorAdapter), ...codeAdapters] : agentAdapters;
}
export function agentAdapter(id, dataDir) {
  const adapter = configuredAgentAdapters(dataDir).find(candidate => candidate.id === id);
  if (!adapter) throw new TypeError(`Unsupported agent: ${id}`);
  return adapter;
}

// CLI package administration uses this registry port to inspect compatible descriptors.
export function clientDescriptorPacks(options) { return loadClientDescriptorPacks(options); }
export function clientPackTarget(pack, environment) { return descriptorAdapter(pack).detect(environment); }
