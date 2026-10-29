// Codex rollout v1: visible response items only; event_msg mirrors are omitted.
export function normalizeCodexRecord(record) {
  // A locally written compaction summary; remote compaction leaves the message
  // empty and keeps only an encrypted item, which is never stored.
  if (record?.type === 'compacted') {
    const message = record.payload?.message;
    return typeof message === 'string' && message.trim() ? [{ role: 'summary', kind: 'compaction_summary', content: message }] : [];
  }
  if (record?.type !== 'response_item') return [];
  const item = record.payload;
  if (item?.type === 'message' && ['user', 'assistant'].includes(item.role)) {
    // Analysis can also be encoded as a message instead of a reasoning item.
    if (item.role === 'assistant' && item.channel === 'analysis') return [];
    const content = (item.content ?? []).filter(block => ['input_text', 'output_text'].includes(block.type))
      .map(block => block.text ?? '').join('\n');
    return content ? [{ role: item.role, kind: 'message', content }] : [];
  }
  if (['function_call', 'custom_tool_call'].includes(item?.type)) {
    return [{ role: 'assistant', kind: 'tool_call', content: JSON.stringify({
      call_id: item.call_id, name: item.name, arguments: item.arguments ?? item.input
    }) }];
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) {
    return [{ role: 'tool', kind: 'tool_result', content: JSON.stringify({ call_id: item.call_id, output: item.output }) }];
  }
  return [];
}
export function verifyCodexTranscript(firstRecord, sessionId) {
  return firstRecord?.type === 'session_meta' && firstRecord.payload?.id === sessionId;
}
