import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// A large team description does not fit one MCP answer. Export then keeps the
// template here and returns a short reference the same computer can resolve;
// the reference is bound to the personal space that made it and expires. It
// holds only the redacted portable template, never a secret, a path or an
// identity (see portable-text.js).
export const TEAM_TEMPLATE_REFS_FORMAT = jsonFormat({ store: 'team-template-refs', versions: [1] });
const REF = /^ttr-[0-9a-f]{32}$/;
// Only this feature's own records are ever pruned: an unrelated `.json` in the
// same directory (a person's file, another migration's record) is not ours.
const REF_FILE = /^ttr-[0-9a-f]{32}\.json$/;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REFS = 200;

export function createTeamTemplateRefs({ directory, now = () => new Date() } = {}) {
  if (!directory) throw new TypeError('team template references need a directory');
  const pathOf = ref => join(directory, `${ref}.json`);
  return {
    // The same space and template give the same reference, so exporting an
    // unchanged team twice replaces one file instead of adding another.
    put(template, { personalSpaceId, sourcePersonalProjectId = null }) {
      prune();
      const ref = `ttr-${contentHash([personalSpaceId, template.templateId]).slice(0, 32)}`;
      writeVersionedJsonFileAtomic(pathOf(ref), {
        version: 1,
        personalSpaceId,
        sourcePersonalProjectId,
        templateId: template.templateId,
        createdAt: now().toISOString(),
        template
      }, TEAM_TEMPLATE_REFS_FORMAT);
      return ref;
    },
    get(ref, { personalSpaceId }) {
      if (typeof ref !== 'string' || !REF.test(ref)) throw notFound();
      let stored;
      try {
        stored = JSON.parse(readFileSync(pathOf(ref), 'utf8'));
      } catch {
        throw notFound();
      }
      if (stored?.version !== 1 || stored.personalSpaceId !== personalSpaceId || !stored.template
          || stored.template.templateId !== stored.templateId || olderThanWeek(stored.createdAt)) {
        throw notFound();
      }
      return stored.template;
    }
  };

  function olderThanWeek(value) {
    const at = Date.parse(value ?? '');
    return Number.isNaN(at) || now().getTime() - at > MAX_AGE_MS;
  }

  // Expired references and, beyond the cap, the oldest ones go on the next
  // export. A failure to list or remove never blocks a new export.
  function prune() {
    let names;
    try {
      names = readdirSync(directory).filter(name => REF_FILE.test(name));
    } catch {
      return;
    }
    const kept = [];
    for (const name of names) {
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        if (now().getTime() - stat.mtimeMs > MAX_AGE_MS) {
          unlinkSync(path);
          continue;
        }
        kept.push({ path, mtimeMs: stat.mtimeMs });
      } catch { /* a file that disappeared is already gone */ }
    }
    kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const extra of kept.slice(0, Math.max(0, kept.length - MAX_REFS))) {
      try { unlinkSync(extra.path); } catch { /* another export removed it */ }
    }
  }
}

function notFound() {
  return new ApplicationError('team_template_reference_not_found',
    'This local template reference is unknown or expired; export the team again. Nothing was written.', { status: 404 });
}
