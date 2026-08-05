import { buildWritingTasteProfile } from './writing-taste-profile.js';

export async function getWritingTasteProfile(application, {
  personalSpaceId,
  personalProjectId = null,
  limit = 500
} = {}) {
  const [graph, conflictRecords] = await Promise.all([
    application.getKnowledgeGraph({
      spaceId: personalSpaceId,
      limit
    }),
    application.personal.listPreferenceConflicts(
      personalSpaceId,
      null,
      limit
    )
  ]);
  return buildWritingTasteProfile({
    graph,
    conflictRecords,
    personalSpaceId,
    personalProjectId
  });
}
