import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The English and Chinese READMEs, and the docs pages they link to, describe
// the same product. A change made to only one language shows up here as a
// different outline or command table.
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const PAIRS = [
  ['README.md', 'README.zh-CN.md'],
  ...['install', 'how-it-works', 'external-knowledge', 'agent-tools', 'capabilities-and-limits', 'development']
    .map(page => [`docs/${page}.md`, `docs/${page}.zh-CN.md`]),
];
const FILES = PAIRS.flat();
const outline = text => text.split('\n').filter(line => /^#{2,3} /.test(line)).map(line => line.match(/^#+/)[0].length);
// Placeholder words are translated (options / 选项); flags and subcommands are not.
const commands = text => [...text.matchAll(/^\| `(fuli [^`]+)`/gm)]
  .map(match => match[1].replaceAll('\\|', '|').replaceAll('选项', 'options')).sort();

test('each English page and its Chinese twin keep the same outline and CLI commands', async () => {
  for (const [english, chinese] of PAIRS) {
    const [en, zh] = await Promise.all([read(english), read(chinese)]);
    assert.deepEqual(outline(zh), outline(en), english);
    assert.deepEqual(commands(zh), commands(en), english);
  }
  assert.ok(commands(await read('docs/install.md')).length > 10);
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

test('README and docs bold text renders as bold in both languages', async () => {
  for (const name of FILES) assert.deepEqual(literalBold(await read(name)), [], name);
  assert.deepEqual(literalBold('- **标题：**正文'), ['1: - **标题：**正文']);
  assert.deepEqual(literalBold('- **标题**：正文'), []);
});

// In a Mermaid diagram an ASCII semicolon ends the statement, so the rest of
// a message or note becomes a parse error on GitHub.
test('README and docs Mermaid diagrams have no statement-splitting semicolons', async () => {
  for (const name of ['README.md', 'README.zh-CN.md', 'docs/how-it-works.md', 'docs/how-it-works.zh-CN.md']) {
    const diagrams = [...(await read(name)).matchAll(/```mermaid\n([\s\S]*?)```/g)].map(match => match[1]);
    assert.ok(diagrams.length > 0, name);
    for (const diagram of diagrams) assert.deepEqual(diagram.split('\n').filter(line => line.includes(';')), [], name);
  }
});

// Every relative link in the READMEs and moved docs points at a file that exists.
test('README and docs relative links resolve to files in the repository', async () => {
  const { existsSync } = await import('node:fs');
  for (const name of FILES) {
    const text = await read(name);
    for (const [, target] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const url = new URL(decodeURI(target), new URL(`../${name}`, import.meta.url));
      assert.ok(existsSync(url), `${name} → ${target}`);
    }
  }
});
