// `#debug` at the very start of a prompt (any case), then a space, a line
// break or the end, asks FULI to keep this turn's full context for the person
// to read (debug-turns/recorder.js). It changes nothing else about the turn.
const DEBUG_TRIGGER = /^#debug(?:\s|$)/i;

export function isDebugPrompt(prompt) {
  return typeof prompt === 'string' && DEBUG_TRIGGER.test(prompt);
}
