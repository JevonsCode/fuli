import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The English and Chinese READMEs describe the same product. A change made to
// only one of them shows up here as a different outline or command table.
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const outline = text => text.split('\n').filter(line => /^#{2,3} /.test(line)).map(line => line.match(/^#+/)[0].length);
// Placeholder words are translated (options / 选项); flags and subcommands are not.
const commands = text => [...text.matchAll(/^\| `(fuli [^`]+)`/gm)]
  .map(match => match[1].replaceAll('\\|', '|').replaceAll('选项', 'options')).sort();

test('the English and Chinese READMEs keep the same outline and CLI commands', async () => {
  const [english, chinese] = await Promise.all([read('README.md'), read('README.zh-CN.md')]);
  assert.deepEqual(outline(chinese), outline(english));
  assert.deepEqual(commands(chinese), commands(english));
  assert.ok(commands(english).length > 10);
});

// CommonMark only treats ** as bold when it touches text the right way: a run
// next to punctuation must also face a space or punctuation on its outer side,
// so "**标题：**正文" shows the asterisks. Code spans and fences are skipped.
const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
function literalBold(text) {
  let fence = false;
  const found = [];
  text.split('\n').forEach((raw, index) => {
    if (/^\s*```/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const line = raw.replace(/`[^`]*`/g, span => 'x'.repeat(span.length));
    const runs = [...line.matchAll(/\*\*/g)].map(match => match.index);
    for (let pair = 0; pair + 1 < runs.length; pair += 2) {
      const [open, close] = [runs[pair], runs[pair + 1]];
      const at = position => line[position] ?? ' ';
      const opens = !SPACE.test(at(open + 2)) && (!PUNCTUATION.test(at(open + 2)) || SPACE.test(at(open - 1)) || PUNCTUATION.test(at(open - 1)));
      const closes = !SPACE.test(at(close - 1)) && (!PUNCTUATION.test(at(close - 1)) || SPACE.test(at(close + 2)) || PUNCTUATION.test(at(close + 2)));
      if (!opens || !closes) found.push(`${index + 1}: ${raw.trim()}`);
    }
  });
  return found;
}

test('README bold text renders as bold in both languages', async () => {
  for (const name of ['README.md', 'README.zh-CN.md']) assert.deepEqual(literalBold(await read(name)), [], name);
  assert.deepEqual(literalBold('- **标题：**正文'), ['1: - **标题：**正文']);
  assert.deepEqual(literalBold('- **标题**：正文'), []);
});

// In a Mermaid diagram an ASCII semicolon ends the statement, so the rest of
// a message or note becomes a parse error on GitHub.
test('README Mermaid diagrams have no statement-splitting semicolons', async () => {
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const diagrams = [...(await read(name)).matchAll(/```mermaid\n([\s\S]*?)```/g)].map(match => match[1]);
    assert.ok(diagrams.length > 0, name);
    for (const diagram of diagrams) assert.deepEqual(diagram.split('\n').filter(line => line.includes(';')), [], name);
  }
});
