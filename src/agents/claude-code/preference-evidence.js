import { normalizeClaudeRecord, verifyClaudeTranscript } from './conversation-transcript.js';

export const claudePreferenceEvidence = Object.freeze({
  verify: verifyClaudeTranscript,
  // The same reading the transcript collector stores, so a session's own
  // native message can be matched to its stored event.
  normalize: normalizeClaudeRecord,
  // A record's place in the conversation tree. A rewind leaves the turns after
  // its point in the file as an abandoned branch; a resume replays only the
  // chain that ends at the latest record, by parentUuid (rec#11 D-69). A
  // sidechain or a record without a parentUuid field is not on that chain.
  link(record, sessionId) {
    if (record?.sessionId !== sessionId || typeof record.uuid !== 'string' || record.isSidechain === true
      || !Object.hasOwn(record, 'parentUuid')) return null;
    return { id: record.uuid, parent: typeof record.parentUuid === 'string' ? record.parentUuid : null };
  },
  events(record, sessionId) {
    if (record?.sessionId !== sessionId) return [];
    if (record.type === 'system' && record.subtype === 'compact_boundary') return [{ type: 'reset' }];
    // Hook-delivered task entry is stored as an attachment; `rendered` is the
    // exact text the model saw. Claude stores an oversized Hook output as a
    // preview, which does not parse as a frame and so stays a full delivery;
    // the task entry is bounded below that size (lifecycle-hook.js, D-54).
    if (record.type === 'attachment' && record.attachment?.type === 'hook_additional_context'
        && record.attachment.hookEvent === 'UserPromptSubmit' && typeof record.uuid === 'string') {
      const text = (Array.isArray(record.rendered) ? record.rendered : []).map(block => block?.content)
        .filter(content => typeof content === 'string').join('\n');
      return text ? [{ type: 'context', output: text }] : [];
    }
    if (!['assistant', 'user'].includes(record.type) || !Array.isArray(record.message?.content)) return [];
    return record.message.content.flatMap(block => {
      if (record.type === 'assistant' && block.type === 'tool_use') {
        return [{ type: 'call', id: block.id, name: block.name, input: block.input }];
      }
      if (record.type === 'user' && block.type === 'tool_result' && !block.is_error) {
        return [{ type: 'result', id: block.tool_use_id, output: block.content }];
      }
      return [];
    });
  }
});
