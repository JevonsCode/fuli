// `#fulidebug` at the very start of a prompt (any case), then a space, a line
// break or the end, asks FULI to keep this turn's full context for the person
// to read (debug-turns/recorder.js).
const DEBUG_TRIGGER = /^#fulidebug(?:\s+|$)/i;

export function isDebugPrompt(prompt) {
  return typeof prompt === 'string' && DEBUG_TRIGGER.test(prompt);
}

/** The prompt as the person meant it: FULI's own work never sees the mark. */
export function withoutDebugMark(prompt) {
  return isDebugPrompt(prompt) ? prompt.replace(DEBUG_TRIGGER, '') : prompt;
}

export const DEBUG_MARK_NOTICE = 'The leading #fulidebug is a FULI recording mark, not part of the request: ignore it.';

// A host hook can add to a turn but cannot edit the person's words, so the model
// still receives the mark. One line for the model says it is not the request;
// nothing is shown to the person.
export function withDebugMarkNotice(output, prompt) {
  const specific = output?.hookSpecificOutput;
  if (!isDebugPrompt(prompt) || !specific) return output;
  return { ...output, hookSpecificOutput: { ...specific,
    additionalContext: specific.additionalContext ? `${specific.additionalContext}\n${DEBUG_MARK_NOTICE}` : DEBUG_MARK_NOTICE } };
}
