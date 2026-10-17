import { createInterface } from 'node:readline/promises';

export function writeLine(value) {
  process.stdout.write(`${value}\n`);
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
