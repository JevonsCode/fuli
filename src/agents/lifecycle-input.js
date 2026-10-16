const MAX_HOOK_INPUT_BYTES = 256 * 1024;

// Hosts that pipe the payload through Windows PowerShell with a UTF-8
// $OutputEncoding (Cursor's CLI does) prepend a byte order mark. One leading
// BOM is transport framing, not JSON; anything else must still be valid JSON.
export function parseHookInput(buffer) {
  const text = Buffer.from(buffer).toString('utf8');
  return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
}

export async function readHookInput(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_HOOK_INPUT_BYTES) throw new TypeError('Hook input exceeds limit');
    chunks.push(chunk);
  }
  return parseHookInput(Buffer.concat(chunks));
}
