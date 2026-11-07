import { readFileSync } from 'node:fs';

export function fixtures() {
  return JSON.parse(readFileSync(new URL('./fixtures/messages.json', import.meta.url), 'utf8'));
}

// A fake provider transport answering with the given results in order; an Error entry is thrown.
export function scriptedTransport(results) {
  const calls = [];
  const transport = async (payload) => {
    calls.push(payload);
    const next = results[Math.min(calls.length - 1, results.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}
