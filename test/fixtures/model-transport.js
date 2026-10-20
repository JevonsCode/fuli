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
