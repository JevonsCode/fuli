import { claudeChoiceAnswers } from './claude-code/choice-answers.js';
import { codexChoiceAnswers } from './codex/choice-answers.js';
import { locatePreferenceTranscript } from './preference-evidence.js';

// The person's answers in a client's own question card, for the relay check
// (agent-delegation/person-words.js): an FLA that asks with the host's
// single-choice UI can relay that choice as the person's words. Clients whose
// card answers FULI cannot read return none, and the FLA asks in chat instead.
const READERS = Object.freeze({ claude_code: claudeChoiceAnswers, claude: claudeChoiceAnswers, codex: codexChoiceAnswers });

export async function nativeChoiceAnswers(task, { env = process.env } = {}) {
  const reader = READERS[task?.sourceApplication];
  if (!reader || typeof task.sessionId !== 'string') return [];
  try {
    const transcript = await locatePreferenceTranscript(task.sourceApplication, task.sessionId, { env });
    return transcript ? await reader(transcript.path, task.sessionId) : [];
  } catch {
    return [];
  }
}
