// What one model request is made of, by source. Tokens come from the answer's
// own usage, so only their total is what was counted.

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

const systemText = (system) => textBlocks(system).join('\n\n');
const blockText = (block) => (block?.type === 'text' ? block.text ?? '' : JSON.stringify(block));
const contentText = (content) => (typeof content === 'string' ? content : (content ?? []).map(blockText).join('\n'));
const isFuliPiece = (piece) => FULI_CONTEXT.test(piece) && !PERSON_FILES.test(piece);
const isReminder = (piece) => /^\s*(<system-reminder>|<EXTREMELY_IMPORTANT>|[A-Za-z]+ hook additional context:)/.test(piece);

/** True for the request that opens a turn: it ends on the person's words, not a tool's answer. */
export function opensTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const at = turnStart(messages);
  if (!Array.isArray(body?.tools) || !body.tools.length || at < 0) return false;
  const { content } = messages[at];
  return !(Array.isArray(content) && content.some(block => block?.type === 'tool_result'));
}

// The person's latest message; a host may put its own system messages after it.
const turnStart = (messages) => {
  const at = messages.findLastIndex(message => message.role !== 'system');
  return messages[at]?.role === 'user' ? at : -1;
};

/** The request as Debug record parts, in reading order, each with who put it there. */
export function requestParts(body, usage) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const fuliTools = tools.filter(tool => /^mcp__fuli__/.test(tool?.name ?? ''));
  const clientTools = tools.filter(tool => !fuliTools.includes(tool));
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const parts = [
    { source: 'host', kind: 'model_system', text: systemText(body?.system) },
    { source: 'host', kind: 'model_client_tools', label: String(clientTools.length), text: JSON.stringify(clientTools, null, 2) },
    { source: 'fuli', kind: 'model_fuli_tools', label: String(fuliTools.length), text: JSON.stringify(fuliTools, null, 2) },
  ];
  const start = Math.max(turnStart(messages), 0);
  const earlier = messages.slice(0, start);
  if (earlier.length) parts.push({ source: 'host', kind: 'history', label: String(earlier.length),
    text: earlier.map(message => `[${message.role}] ${contentText(message.content)}`).join('\n\n') });
  let prompt = '';
  for (const message of messages.slice(start)) {
    for (const piece of textBlocks(message.content).flatMap(pieces).filter(text => text.trim())) {
      if (isFuliPiece(piece)) parts.push({ source: 'fuli', kind: 'model_context', text: piece });
      // Only the person's own message holds their words; a host's system message never does.
      else if (message.role !== 'user' || isReminder(piece)) parts.push({ source: 'host', kind: 'model_context', text: piece });
      else { parts.push({ source: 'person', kind: 'prompt', text: piece }); prompt ||= piece.trim(); }
    }
  }
  if (usage) parts.push({ source: 'host', kind: 'model_usage', text: JSON.stringify(usage, null, 2) });
  return { prompt: prompt || 'Model request', parts };
}

/** Token counts from a streamed or plain response, null when it reported none. */
export function usageFrom(text) {
  const usage = {};
  for (const match of text.matchAll(/"usage"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g)) {
    try { Object.assign(usage, JSON.parse(match[1])); } catch { /* A partial event carries nothing to count. */ }
  }
  return Object.keys(usage).length ? usage : null;
}
