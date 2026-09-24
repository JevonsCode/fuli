// Claude JSONL v1; thinking/redacted_thinking are intentionally never persisted.
export function normalizeClaudeRecord(record, sessionId) {
  if (record?.sessionId !== sessionId || !['user', 'assistant'].includes(record.type)) return [];
  const content = record.message?.content;
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
export function verifyClaudeTranscript(firstRecord, sessionId) {
  return firstRecord?.sessionId === sessionId;
}
