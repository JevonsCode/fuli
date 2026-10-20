import { createInterface } from 'node:readline/promises';

export function writeLine(value) {
  process.stdout.write(`${value}\n`);
}

const ENTER = new Set(['\r', '\n', '\u0004']);
const ERASE = new Set(['\u007f', '\b']);
const CANCEL = '\u0003';

// Reads one line without echoing it, for secrets. A terminal is switched to
// raw mode and nothing typed is written back; piped input is read whole.
export async function readHiddenLine({ prompt, input = process.stdin, output = process.stderr }) {
  if (!input.isTTY) {
    let text = '';
    for await (const chunk of input) text += chunk;
    return text.replace(/[\r\n]+$/, '');
  }
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (settle, result) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      settle(result);
    };
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === CANCEL) return finish(reject, new Error('Key entry cancelled'));
        if (ENTER.has(character)) return finish(resolve, value);
        if (ERASE.has(character)) value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

// Asks one yes/no question. An empty answer takes `defaultYes`.
export async function confirmInTerminal(question, { defaultYes }) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question(question)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}
