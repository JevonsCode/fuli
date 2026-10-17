import { verifyCodexTranscript } from './conversation-transcript.js';

// Native rollout formats are versioned independently of Fuli. Unknown records
// never acknowledge context; a known compaction clears all earlier evidence.
export const codexPreferenceEvidence = Object.freeze({
  verify: verifyCodexTranscript,
  events(record) {
    if (record?.type === 'compacted') return [{ type: 'reset' }];
    if (record?.type !== 'response_item') return [];
    const item = record.payload;
    if (['function_call', 'custom_tool_call'].includes(item?.type)) {
      const name = item.type === 'custom_tool_call' && ['exec', 'wait'].includes(item.name)
        ? `functions.${item.name}` : item.name;
      return [{ type: 'call', id: item.call_id, name }];
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) {
      return [{ type: 'result', id: item.call_id, output: item.output }];
    }
    return [];
  }
});
