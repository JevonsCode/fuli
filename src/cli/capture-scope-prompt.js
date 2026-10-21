import { questionInTerminal, writeLine } from './terminal-io.js';

// A new installation's question in an interactive terminal (rec#5 C10).
// Setup without a TTY (an Agent's shell, a script, a pipe) or with --yes never
// asks, so the question stays open and the console asks it, and no option
// answers it. A TTY is not proof that a person is there: a local program with
// a pseudo-terminal, like one that can reach the loopback console, is inside
// the console's existing trust boundary (rec#11 D-19).
const CHOICES = Object.freeze(['all', 'selected', 'off']);
const QUESTION = [
  'FULI 要在哪些项目里记录？ / Where should FULI record?',
  '  1) 全部项目 / All projects',
  '  2) 只记我选的项目 / Only projects I choose',
  '  3) 先不记录 / Not yet',
  'Choose 1-3, or press Enter to decide later in the console: '
].join('\n');

// '' decides later; anything but 1-3 is asked again.
export function parseCaptureScopeAnswer(text) {
  const answer = String(text).trim();
  if (!answer) return null;
  if (!/^[1-3]$/.test(answer)) throw new RangeError('Choose 1, 2 or 3');
  return CHOICES[Number(answer) - 1];
}

export async function askCaptureScope({ question = questionInTerminal, write = writeLine } = {}) {
  for (;;) {
    try {
      return parseCaptureScopeAnswer(await question(QUESTION));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      write(error.message);
    }
  }
}

// What setup says about the question once it has run: the answer saved, or
// where to answer it while recording stays off.
export function captureScopeSummary(outcome, consoleUrl) {
  const settings = consoleUrl ? `${consoleUrl}/settings` : 'the console settings';
  if (outcome?.status === 'answered') {
    if (outcome.choice === 'all') return `Recording: all projects. Change it any time in ${settings}.`;
    if (outcome.choice === 'off') return `Recording: off (记录已关闭). Turn it on any time in ${settings}.`;
    return 'Recording: only projects you choose; folders outside them are not recorded. No project is chosen yet: '
      + `turn on 记忆这个项目 on a project page, or pick projects in ${settings}.`;
  }
  if (outcome?.status === 'gone') return `Recording: the capture settings changed meanwhile, so nothing was changed here. Check ${settings}.`;
  return `Recording: off until you choose where FULI records. Open ${consoleUrl ?? 'the console'} to choose.`;
}
