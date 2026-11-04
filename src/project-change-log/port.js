import { AUTHORED_FIELDS, fieldText } from '../graphiti/project-profile-authors.js';
import { positiveInteger, requiredString } from '../validation/values.js';
import { ProjectChangeStore } from './store.js';

// The fields a person reads as the project's profile. The assessment and the
// brief draft are left out: FULI recomputes them, so they say nothing about
// what someone changed; `authors` only follows the fields below.
const PROFILE_TEXT = Object.freeze({
  name: (profile) => fieldText(profile?.name),
  ...Object.fromEntries(AUTHORED_FIELDS.map((field) => [field, (profile) => fieldText(profile?.[field])])),
  lifecycle: (profile) => fieldText(profile?.lifecycle),
  sources: (profile) => (profile?.sources ?? []).map(sourceText).join('\n')
});

const PROJECT_ID_MAX_CHARS = 128;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function createProjectChangeLog({ path = ':memory:', now = () => new Date(),
  warn = (message) => process.stderr.write(`${message}\n`) } = {}) {
  const store = new ProjectChangeStore(path);

  return {
    // `previous` is the stored profile before the save (null for a new
    // project), `saved` what the Provider answered: a field an Agent was
    // refused is unchanged there. The save already happened, so a failure here
    // is reported and stops at this line.
    record({ personalSpaceId, projectId, writer, previous, saved }) {
      try {
        const changes = profileChanges(previous, saved.profile);
        if (!changes.length) return;
        store.add({ personalSpaceId, projectId, at: now().toISOString(), actor: changeActor(writer), changes });
      } catch (error) {
        warn(`The profile of project ${projectId} was saved, but its change log was not written: ${error?.message ?? error}`);
      }
    },

    list({ personalSpaceId, projectId, limit }) {
      const id = requiredString(projectId, 'projectId', PROJECT_ID_MAX_CHARS);
      const count = positiveInteger(limit ?? DEFAULT_LIMIT, 'limit', MAX_LIMIT);
      const entries = store.recent(personalSpaceId, id, count + 1);
      return { entries: entries.slice(0, count), hasMore: entries.length > count };
    },

    close: () => store.close()
  };
}

function profileChanges(previous, saved) {
  return Object.entries(PROFILE_TEXT).flatMap(([field, text]) => {
    const before = text(previous);
    const after = text(saved);
    return before === after ? [] : [{ field, before, after }];
  });
}

// An Agent writer with neither an id nor a name is FULI's own draft.
function changeActor({ kind, agentId = null, agentName = null }) {
  if (kind === 'person') return { kind, agentId: null, agentName: null };
  return agentId || agentName ? { kind, agentId, agentName } : { kind: 'fuli', agentId: null, agentName: null };
}

function sourceText({ title, uri, summary }) {
  return [title, uri, summary].filter(Boolean).join(' · ');
}
