import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

// One status, one colour (rec#11, 2026-10-27): every page colours a task, work,
// worker or plan-step status through statusTone in
// web/src/features/project-agents/task-labels.ts (a Badge variant, a UiChip
// tone or a data-tone attribute), never with its own `.is-<status>` colour rule.
// The Tonborg workbench and the employee pages are owned on other branches.
const ROOT = 'web/src';
const OWNED_ELSEWHERE = ['features/judgment/', 'features/employees/'];
const STATUSES = ['blocked', 'failed', 'awaiting_review', 'paused', 'awaiting_recruitment', 'queued',
  'backlog', 'completed', 'in_progress', 'cancelled'];
const STATUS_RULE = new RegExp(`([^{}]*\\.is-(?:${STATUSES.join('|')})\\b[^{}]*)\\{([^}]*)\\}`, 'g');

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(vue|css)$/.test(entry.name) ? [path] : [];
  });
}

test('no page colours a task status on its own; colours come from the shared status tone', () => {
  const offenders = [];
  for (const path of [...sources(ROOT), 'web/styles.css']) {
    const name = relative(ROOT, path).replaceAll('\\', '/');
    if (OWNED_ELSEWHERE.some((prefix) => name.startsWith(prefix))) continue;
    for (const [, selector, body] of readFileSync(path, 'utf8').matchAll(STATUS_RULE)) {
      if (/(^|[\s;])(color|background|border-color|stroke|fill)\s*:/.test(body)) offenders.push(`${name}: ${selector.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
