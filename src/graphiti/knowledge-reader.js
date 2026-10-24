// Who reads personal knowledge from the Provider (graph-provider
// knowledge_visibility.py). Knowledge an FLA wrote, and a preference given to
// one FLA, is that FLA's: an Agent reads it only as that FLA, in its project.
// An Agent read names the FLA of its task, or nothing for a plain session;
// the Provider authorizes the FLA it names. The person's full read is the
// console's alone and takes its human-review port (src/knowledge-owner-reads).

// The reader of a task: its FLA in its project, or null for a plain session.
export function taskKnowledgeReader(task) {
  return task?.projectAgentId
    ? { personalProjectId: task.personalProjectId ?? null, projectAgentId: task.projectAgentId }
    : null;
}

// The reader as the Provider's request fields; a plain session names none.
export function providerReaderFields(reader) {
  return reader?.projectAgentId
    ? { reader_project_id: reader.personalProjectId, reader_agent_id: reader.projectAgentId }
    : {};
}

// The Provider's graph read, for an Agent's reader or (none) the console's port.
export function graphReadPath(spaceId, { limit, personalProjectId = null, offset = null, reader = null }) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (personalProjectId) query.set('personal_project_id', personalProjectId);
  if (offset !== null) query.set('offset', String(offset));
  for (const [key, value] of Object.entries(providerReaderFields(reader))) query.set(key, value);
  return `/v1/spaces/${encodeURIComponent(spaceId)}/graph?${query}`;
}

// The Provider's preference conflicts. An Agent's read is a plain session's and
// leaves out every conflict naming an FLA's own item; the console's port reads all.
export function preferenceConflictsPath(personalSpaceId, { status = null, limit = 500, offset = 0 }) {
  const query = new URLSearchParams({ personal_space_id: personalSpaceId, limit: String(limit) });
  if (status) query.set('status', status);
  if (offset) query.set('offset', String(offset));
  return `/v1/preference-conflicts?${query}`;
}

// The Provider's publication drafts. An Agent's read leaves out a draft of an
// FLA's work, made before the Provider refused them; the console's port reads all.
export function publicationDraftsPath(personalSpaceId, { status = 'pending', metadataOnly = false } = {}) {
  const query = new URLSearchParams({ personal_space_id: personalSpaceId, status });
  if (metadataOnly) query.set('metadata_only', 'true');
  return `/v1/publication-drafts?${query}`;
}
