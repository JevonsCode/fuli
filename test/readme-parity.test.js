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
