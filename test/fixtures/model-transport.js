// Fake model transports: streamed replies as the providers send them, so
// tests reach no real or paid model.
export function sse(events) {
  const body = events.map(({ event, data }) =>
    `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function openAiStream(content, { usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  model = 'qwen-test-actual', finish = 'stop' } = {}) {
  return sse([
    { data: { model, choices: [{ index: 0, delta: { role: 'assistant', content: content.slice(0, 5) } }] } },
    { data: { model, choices: [{ index: 0, delta: { content: content.slice(5) } }] } },
    { data: { model, choices: [{ index: 0, delta: {}, finish_reason: finish }] } },
    ...(usage ? [{ data: { model, choices: [], usage } }] : []),
    { data: '[DONE]' }
  ]);
}

export function anthropicStream(content, { start = { input_tokens: 100, output_tokens: 1 }, deltas = [{ output_tokens: 12 }],
  stopReason = 'end_turn', model = 'claude-test-actual' } = {}) {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { model, usage: start } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } },
    ...deltas.slice(0, -1).map(usage => ({ event: 'message_delta', data: { type: 'message_delta', delta: {}, usage } })),
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason }, usage: deltas.at(-1) } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ]);
}
