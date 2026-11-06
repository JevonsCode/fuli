import { open } from 'node:fs/promises';

// What the person picked or typed in Claude Code's own question card
// (AskUserQuestion), read from the session's transcript, which Claude Code
// writes itself: the answer is a tool result whose `toolUseResult.answers` maps
// each question to the person's choice. Only answers to an AskUserQuestion of
// this session's main chain count, and only the transcript's tail is read.
const TAIL_BYTES = 4 * 1024 * 1024;
const QUESTION_TOOL = 'AskUserQuestion';

export async function claudeChoiceAnswers(path, sessionId) {
  const records = parse(await tail(path));
  const asked = new Set(records.flatMap(record => (record.type === 'assistant' && mainChain(record, sessionId)
    ? content(record).filter(block => block?.type === 'tool_use' && block.name === QUESTION_TOOL).map(block => block.id)
    : [])));
  return records.flatMap((record) => {
    if (record.type !== 'user' || !mainChain(record, sessionId)) return [];
    const answered = content(record).some(block => block?.type === 'tool_result' && asked.has(block.tool_use_id));
    const answers = record.toolUseResult?.answers;
    if (!answered || !answers || typeof answers !== 'object') return [];
    return Object.values(answers).filter(text => typeof text === 'string' && text.trim())
      .map(text => ({ text, at: typeof record.timestamp === 'string' ? record.timestamp : null }));
  });
}

const mainChain = (record, sessionId) => record.sessionId === sessionId && record.isSidechain !== true;
const content = record => (Array.isArray(record.message?.content) ? record.message.content : []);

async function tail(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A cut first line is not a record.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await file.close();
  }
}

function parse(text) {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
