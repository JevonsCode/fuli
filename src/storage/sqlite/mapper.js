export function mapSpace(row) {
  return row ? {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    createdAt: row.created_at
  } : null;
}

export function mapSubscription(row) {
  return row ? {
    personalSpaceId: row.personal_space_id,
    spaceId: row.space_id,
    mode: row.mode,
    createdAt: row.created_at
  } : null;
}

export function mapEpisode(row) {
  return row ? {
    id: row.id,
    spaceId: row.space_id,
    sourceKind: row.source_kind,
    body: row.body,
    sourceUri: row.source_uri,
    metadata: JSON.parse(row.metadata_json),
    createdAt: row.created_at
  } : null;
}

export function mapFact(row) {
  return row ? {
    id: row.id,
    spaceId: row.space_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    sourceEpisodeId: row.source_episode_id,
    status: row.status,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    scope: row.scope,
    validAt: row.valid_at,
    invalidAt: row.invalid_at,
    replacedByFactId: row.replaced_by_fact_id
  } : null;
}

export function mapCandidate(row) {
  return row ? {
    id: row.id,
    personalSpaceId: row.personal_space_id,
    targetSpaceId: row.target_space_id,
    episodeId: row.episode_id,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  } : null;
}

export function mapOutbox(row) {
  return row ? {
    id: row.id,
    kind: row.kind,
    aggregateId: row.aggregate_id,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    lastError: row.last_error
  } : null;
}

export function mapImport(row) {
  return row ? {
    contentHash: row.content_hash,
    sourcePath: row.source_path,
    importedAt: row.imported_at
  } : null;
}
