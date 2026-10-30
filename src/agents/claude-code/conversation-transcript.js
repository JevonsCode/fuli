// Claude JSONL v1; thinking/redacted_thinking are intentionally never persisted.
export function normalizeClaudeRecord(record, sessionId) {
  if (record?.sessionId !== sessionId || !['user', 'assistant'].includes(record.type)) return [];
  const content = record.message?.content;
  // The summary Claude Code writes after compacting is stored as a user
  // record; it is the host's own words, never something the user said.
  if (record.isCompactSummary === true) return compactionSummary(content);
  if (typeof content === 'string') return content ? [{ role: record.type, kind: 'message', content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap(block => {
    if (block.type === 'text' && block.text) return [{ role: record.type, kind: 'message', content: block.text }];
    if (block.type === 'tool_use') return [{ role: 'assistant', kind: 'tool_call', content: JSON.stringify({
      call_id: block.id, name: block.name, input: block.input
    }) }];
    if (block.type === 'tool_result') return [{ role: 'tool', kind: 'tool_result', content: JSON.stringify({
      call_id: block.tool_use_id, output: block.content, is_error: block.is_error ?? false
    }) }];
    return [];
  });
}
function compactionSummary(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : '';
  return text ? [{ role: 'summary', kind: 'compaction_summary', content: text }] : [];
}
export function verifyClaudeTranscript(firstRecord, sessionId) {
  return firstRecord?.sessionId === sessionId;
}
