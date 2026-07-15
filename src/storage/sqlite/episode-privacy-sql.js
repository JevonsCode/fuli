import { isRestrictedEpisode } from '../../security/episode-visibility.js';

const FUNCTION_NAME = 'episode_evidence_is_restricted';

export function registerEpisodePrivacyFunction(db) {
  db.function(
    FUNCTION_NAME,
    { deterministic: true },
    (sourceKind, body, sourceUri, metadataJson) => Number(isRestrictedEpisode({
      sourceKind,
      body,
      sourceUri,
      metadata: parseMetadata(metadataJson)
    }))
  );
}

export function sqliteEpisodeRestrictedSql(alias) {
  return `${FUNCTION_NAME}(
    ${alias}.source_kind,
    ${alias}.body,
    ${alias}.source_uri,
    ${alias}.metadata_json
  ) = 1`;
}

function parseMetadata(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { invalidMetadataRestricted: 'password=invalid-metadata' };
  }
}
