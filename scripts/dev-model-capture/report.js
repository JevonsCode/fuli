// What one model request is made of, by source (dev only). Sizes are exact
// bytes. Tokens come from the response's own usage and are shared out by bytes,
// so a section's tokens are an estimate; the total is what the provider counted.

const size = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');
const textBlocks = (content) => (typeof content === 'string' ? [content]
  : (Array.isArray(content) ? content : []).filter(block => block?.type === 'text').map(block => block.text ?? ''));
// FULI's task entry and rules, however a host wraps them in the turn.
const FULI_CONTEXT = /Fuli task context|taskContextToken|fuli:\/\/rules\//;
// The person's own instruction and memory files, which may talk about FULI.
const PERSON_FILES = /Contents of .*(CLAUDE|AGENTS|MEMORY)\.md/;

// A host packs several things into one text block: reminder tags, and each
// hook's context one after another. FULI's share is counted per piece, so a
// block that merely mentions FULI next to other hooks' text is not FULI's.
const pieces = (text) => text.split(/(?=<system-reminder>)|(?<=<\/system-reminder>)|(?=\b[A-Za-z]+ hook additional context:)|(?=<EXTREMELY_IMPORTANT>)|(?<=<\/EXTREMELY_IMPORTANT>)/);

function messageSections(messages = []) {
  let fuliContext = 0;
  let total = 0;
  for (const message of messages) {
    total += size(message.content);
    for (const text of textBlocks(message.content)) {
      for (const piece of pieces(text)) if (FULI_CONTEXT.test(piece) && !PERSON_FILES.test(piece)) fuliContext += size(piece);
    }
  }
  return { fuliContext, conversation: total - fuliContext };
}

export function requestSections(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const fuliTools = tools.filter(tool => /^mcp__fuli__/.test(tool?.name ?? ''));
  const otherTools = tools.filter(tool => !fuliTools.includes(tool));
  return {
    system: size(body?.system),
    clientTools: size(otherTools),
    fuliTools: size(fuliTools),
    ...messageSections(body?.messages),
  };
}

/** Token counts from a streamed or plain response, null when it reported none. */
export function usageFrom(text) {
  const usage = {};
  for (const match of text.matchAll(/"usage"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g)) {
    try { Object.assign(usage, JSON.parse(match[1])); } catch { /* A partial event carries nothing to count. */ }
  }
  return Object.keys(usage).length ? usage : null;
}

export function reportLine(record) {
  const sections = record.body ? requestSections(record.body) : record.sections;
  const bytes = Object.values(sections).reduce((sum, value) => sum + value, 0);
  const usage = record.usage ?? {};
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const shares = Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, {
    bytes: value,
    share: bytes ? Math.round((value / bytes) * 1000) / 10 : 0,
    tokens: bytes ? Math.round((value / bytes) * input) : 0,
  }]));
  return { at: record.at, model: record.model, inputTokens: input, cachedTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0, sections: shares };
}
