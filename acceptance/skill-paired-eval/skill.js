// The treatment of the on arm: exactly one selected stored workflow version,
// written as one native Skill for a normal Agent discovery path. The off arm
// gets no Skill. Nothing here invents steps: ordered steps, the lesson's
// trigger/scope/pitfalls/evidence and the work map's acceptance are the stored
// version's own fields, rendered when present.
import { singleLine, singleLineExcerpt } from '../../src/text/single-line.js';
import { sha256Bytes } from '../../src/security/digest.js';

const DESCRIPTION_LIMIT = 120;

function bulletList(items) {
  return items.map(item => `- ${singleLine(item)}`);
}

export function skillSlug(name) {
  const slug = singleLine(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'fuli-selected-workflow';
}

export function skillMarkdown(selection) {
  const steps = selection.steps.map((step, index) => {
    const detail = step.detail ? ` — ${singleLine(step.detail)}` : '';
    return `${index + 1}. **${singleLine(step.title)}**${detail}`;
  });
  const lesson = selection.lesson;
  const acceptance = selection.workMap?.acceptance;
  return [
    '---',
    `name: ${skillSlug(selection.name)}`,
    `description: ${singleLineExcerpt(selection.purpose, DESCRIPTION_LIMIT)}`,
    '---',
    '',
    `# ${singleLine(selection.name)}`,
    '',
    singleLine(selection.purpose),
    '',
    'Apply this Skill only when the task matches the scope below. If the task is unrelated, ignore it.',
    '',
    ...(lesson?.trigger ? ['## When to use', '', singleLine(lesson.trigger), ''] : []),
    ...(lesson?.scope ? ['## Scope', '', singleLine(lesson.scope), ''] : []),
    ...(Array.isArray(lesson?.pitfalls) && lesson.pitfalls.length
      ? ['## Pitfalls', '', ...bulletList(lesson.pitfalls), ''] : []),
    ...(Array.isArray(lesson?.acceptanceEvidence) && lesson.acceptanceEvidence.length
      ? ['## Acceptance evidence', '', ...bulletList(lesson.acceptanceEvidence), ''] : []),
    '## Steps',
    '',
    ...steps,
    '',
    ...(Array.isArray(acceptance) && acceptance.length
      ? ['## Acceptance', '', ...bulletList(acceptance), ''] : [])
  ].join('\n');
}

export function skillDigest(selection) {
  return sha256Bytes(Buffer.from(skillMarkdown(selection), 'utf8'));
}
