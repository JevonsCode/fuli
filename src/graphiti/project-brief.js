import { realpath, stat } from 'node:fs/promises';
import { openWithoutFollowing } from '../system/open-without-following.js';
import { constants } from 'node:fs';
import path from 'node:path';
import { singleLine } from '../text/single-line.js';
import { findRepositoryRoot } from './project-path-context.js';

const BRIEF_LIMIT = 240;
const README_BYTES = 64 * 1024;

// A display excerpt, never an inferred domain description or a new instruction.
export function projectBrief(profile) {
  if (!profile) return null;
  const prefix = profile.brief_draft ? 'AI draft (editable): ' : '';
  const summary = excerpt(prefix + [profile.purpose, profile.scope, ...(profile.boundaries ?? [])]
    .filter(value => typeof value === 'string' && value.trim()).join(' · '));
  return { name: profile.name, summary };
}

export async function repositoryProjectDraft({ projectPath }) {
  const repository = projectPath && findRepositoryRoot(projectPath);
  const root = repository && await realpath(repository);
  if (root) for (const name of ['README.md', 'README.zh-CN.md', 'README', 'readme.md']) {
    let file;
    try {
      const candidate = await realpath(path.join(root, name));
      const relative = path.relative(root, candidate);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative === '..') continue;
      if (!(await stat(candidate)).isFile()) continue;
      file = await openWithoutFollowing(candidate, constants.O_RDONLY);
      if (!(await file.stat()).isFile()) continue;
      const buffer = Buffer.alloc(README_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const paragraphs = buffer.subarray(0, bytesRead).toString('utf8')
        .replace(/```[^]*?```/g, '').split(/\n\s*\n/);
      const paragraph = paragraphs.find(value => value.trim() && !/^(?:#|!|\[|<|\||`)/.test(value.trim()));
      const purpose = excerpt(paragraph);
      if (purpose) return draft(purpose, 'readme');
    } catch {
      // Missing/unreadable README requires an explicit brief; task prompts are transient.
    } finally { await file?.close(); }
  }
  return null;
}

function excerpt(value) { return [...singleLine(value)].slice(0, BRIEF_LIMIT).join(''); }
function draft(purpose, source) {
  return { purpose, brief_draft: { source, label: 'AI draft', editable: true } };
}
