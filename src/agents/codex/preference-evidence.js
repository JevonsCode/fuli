import { normalizeCodexRecord, verifyCodexTranscript } from './conversation-transcript.js';

const HOOK_CONTEXT_KIND = 'hooks.additional_context';

// Native rollout formats are versioned independently of Fuli. Unknown records
// never acknowledge context; a known compaction clears all earlier evidence.
export const codexPreferenceEvidence = Object.freeze({
  verify: verifyCodexTranscript,
  // The same reading the transcript collector stores, so a session's own
  // native message can be matched to its stored event.
  normalize: normalizeCodexRecord,
  events(record) {
    if (record?.type === 'compacted') return [{ type: 'reset' }];
    if (record?.type !== 'response_item') return [];
    const item = record.payload;
    const context = hookContext(item);
    if (context !== null) return [{ type: 'context', id: null, output: context }];
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

// Codex records a command hook's additional context as a developer message
// whose one input_text part carries the harness kind hooks.additional_context
// and command-hook provenance (openai/codex d6817454: core/src/hook_runtime.rs
// record_additional_contexts, core/src/context/hook_additional_context.rs,
// protocol/src/models/item_metadata.rs). A user, a pasted copy or a tool result
// cannot carry that kind; older rollouts without it prove nothing. An oversized
// context is spilled to a file and replaced by a preview, which never parses
// as a complete frame.
function hookContext(item) {
  const metadata = item?.internal_chat_message_metadata_passthrough;
  const [part, ...rest] = Array.isArray(item?.content) ? item.content : [];
  if (item?.type !== 'message' || item.role !== 'developer' || rest.length || part?.type !== 'input_text'
      || typeof part.text !== 'string' || metadata?.content_item_kinds?.length !== 1
      || metadata.content_item_kinds[0] !== HOOK_CONTEXT_KIND || metadata.content_item_metadata?.length !== 1) return null;
  const provenance = metadata.content_item_metadata[0]?.provenance;
  return provenance?.type === 'harness' && provenance.hook === true ? part.text : null;
}
