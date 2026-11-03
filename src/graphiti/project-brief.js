import { singleLine } from '../text/single-line.js';
import { authorTag } from './project-profile-authors.js';

const BRIEF_LIMIT = 240;
// The fields the summary is made of; each carries its author's short tag.
const BRIEF_FIELDS = ['purpose', 'scope', 'boundaries'];

// A display excerpt, never an inferred domain description or a new instruction.
export function projectBrief(profile) {
  if (!profile) return null;
  const prefix = profile.brief_draft ? 'AI draft (editable): ' : '';
  const summary = excerpt(prefix + [profile.purpose, profile.scope, ...(profile.boundaries ?? [])]
    .filter(value => typeof value === 'string' && value.trim()).join(' · '));
  const authors = Object.fromEntries(BRIEF_FIELDS
    .filter(field => profile.authors?.[field])
    .map(field => [field, authorTag(profile.authors[field])]));
  return { name: profile.name, summary, ...(Object.keys(authors).length ? { authors } : {}) };
}

function excerpt(value) { return [...singleLine(value)].slice(0, BRIEF_LIMIT).join(''); }
