// The person's FULI knowledge review in Codex (rec#22). Codex's TUI rejects an
// unknown slash command before any hook runs, so `/flreview` never arrives;
// the person types `fuli review` there, like `fuli stop` (rec#5 C3b), and
// `flreview` is accepted as the same line without its slash. Unlike a session
// command the review is the model's work: the prompt hook passes the line on
// and names the installed `flreview` Skill. Only an exact line counts; a
// sentence that mentions the review, or the two words on separate lines, is
// an ordinary prompt.
const REVIEW_COMMAND = /^\s*[/$]?(?:fuli[ \t]+review|flreview)\s*$/i;

const GUIDANCE = 'The person typed `fuli review`: run the installed `flreview` Skill as an exact /flreview invocation.';
// A session FULI is off for starts no review; the hook answers the line itself.
export const CODEX_REVIEW_OFF_REASON = 'FULI: FULI 在本会话未启用，未开始知识复核。输入 fuli start 启用后，再输入 fuli review。';
// When the hook cannot confirm the session's state (a failure or timeout) the
// line is held back too: an unverified session may be one FULI is off for.
export const CODEX_REVIEW_UNVERIFIED_REASON = 'FULI: FULI 无法确认本会话的启停状态，未开始知识复核。'
  + '请稍后重新输入 fuli review，或输入 fuli status 查看本会话状态（shell 中为 `!fuli session status`）。';

export function isCodexReviewCommand(prompt) {
  return typeof prompt === 'string' && REVIEW_COMMAND.test(prompt);
}

// The task entry's context plus the line naming the Skill. It is appended
// after delivery, so it stays when preference delivery replaces the label.
export function withCodexReviewGuidance(output) {
  const hook = output.hookSpecificOutput;
  return { ...output, hookSpecificOutput: { ...hook,
    additionalContext: [hook?.additionalContext, GUIDANCE].filter(Boolean).join('\n') } };
}
