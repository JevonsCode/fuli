import { verifyClaudeTranscript } from './conversation-transcript.js';

export const claudePreferenceEvidence = Object.freeze({
  verify: verifyClaudeTranscript,
  events(record, sessionId) {
    if (record?.sessionId !== sessionId) return [];
    if (record.type === 'system' && record.subtype === 'compact_boundary') return [{ type: 'reset' }];
    if (!['assistant', 'user'].includes(record.type) || !Array.isArray(record.message?.content)) return [];
    return record.message.content.flatMap(block => {
      if (record.type === 'assistant' && block.type === 'tool_use') {
        return [{ type: 'call', id: block.id, name: block.name }];
      }
      if (record.type === 'user' && block.type === 'tool_result' && !block.is_error) {
        return [{ type: 'result', id: block.tool_use_id, output: block.content }];
      }
      return [];
    });
  }
});
