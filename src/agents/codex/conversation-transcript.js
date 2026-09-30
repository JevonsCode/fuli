// Codex rollout v1: visible response items only; event_msg mirrors are omitted.
export function normalizeCodexRecord(record) {
  if (record?.type !== 'response_item') return [];
  const item = record.payload;
  if (item?.type === 'message' && ['user', 'assistant'].includes(item.role)) {
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
