import { createCodexParticipant } from '../agents/codex/roundtable-participant.js';
import { createClaudeCodeParticipant } from '../agents/claude-code/roundtable-participant.js';
import { createGrokParticipant } from '../agents/grok/roundtable-participant.js';
import { createA2AParticipant } from '../agents/a2a/roundtable-participant.js';
import { createPiParticipant } from '../agents/pi/roundtable-participant.js';

export function createRoundtableParticipant(runtime, options) {
  const factories = { codex: createCodexParticipant, 'claude-code': createClaudeCodeParticipant,
    grok: createGrokParticipant, a2a: createA2AParticipant, pi: createPiParticipant };
  if (!factories[runtime]) throw new TypeError('Select codex, claude-code, pi, grok or a2a; MCP seats join through their client');
  return factories[runtime](options);
}
