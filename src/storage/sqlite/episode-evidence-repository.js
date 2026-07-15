import {
  MAX_EPISODE_METADATA_BYTES,
  MAX_EPISODE_METADATA_FIELD_BYTES,
  normalizeCorrectionEvidencePreviewOptions,
  normalizeEvidencePreviewOptions,
  previewEpisode
} from '../episode-evidence-preview.js';
import { sqliteEpisodeRestrictedSql } from './episode-privacy-sql.js';

export class EpisodeEvidenceRepository {
  constructor(db) {
    this.db = db;
    this.correctionStatements = new Map();
    this.sourceStatement = db.prepare(sourceQuery());
  }

  source(spaceId, episodeId, options = {}) {
    const normalized = normalizeEvidencePreviewOptions(options);
    const row = this.sourceStatement.get({
      spaceId, episodeId,
      bodyChars: normalized.maxBodyBytes,
      bodyBytes: normalized.maxBodyBytes,
      metadataChars: MAX_EPISODE_METADATA_BYTES,
      metadataBytes: MAX_EPISODE_METADATA_BYTES,
      includeRestricted: Number(normalized.includeRestricted)
    });
    return previewEpisode(mapSourceRow(row), normalized);
  }

  corrections(spaceId, factIds, options = {}) {
    const normalized = normalizeCorrectionEvidencePreviewOptions(options);
    if (factIds.length === 0) return [];
    const statement = this.#correctionStatement(factIds.length);
    const parameters = {
      spaceId,
      bodyChars: normalized.maxBodyBytes,
      bodyBytes: normalized.maxBodyBytes,
      fieldChars: MAX_EPISODE_METADATA_FIELD_BYTES,
      fieldBytes: MAX_EPISODE_METADATA_FIELD_BYTES,
      correctionLimit: normalized.maxCorrectionsPerFact,
      includeRestricted: Number(normalized.includeRestricted)
    };
    factIds.forEach((factId, index) => { parameters[`factId${index}`] = factId; });
    const groups = [...new Set(factIds)].map((factId) => ({
      factId,
      episodes: [],
      truncated: false
    }));
    const byFactId = new Map(groups.map((group) => [group.factId, group]));
    for (const row of statement.all(parameters)) {
      const group = byFactId.get(row.fact_id);
      group.episodes.push(previewEpisode(
        mapCorrectionRow(row),
        normalized,
        { correction: true }
      ));
      group.truncated = row.correction_count > normalized.maxCorrectionsPerFact;
    }
    return groups;
  }

  #correctionStatement(factCount) {
    if (!this.correctionStatements.has(factCount)) {
      this.correctionStatements.set(factCount, this.db.prepare(correctionQuery(factCount)));
    }
    return this.correctionStatements.get(factCount);
  }
}

function sourceQuery() {
  return `
    SELECT id, space_id, source_kind,
      substr(body, 1, @bodyChars) AS body_preview,
      length(CAST(body AS BLOB)) > @bodyBytes AS body_truncated,
      source_uri,
      substr(metadata_json, 1, @metadataChars) AS metadata_preview,
      length(CAST(metadata_json AS BLOB)) > @metadataBytes AS metadata_truncated,
      created_at
    FROM episodes source
    WHERE id = @episodeId AND space_id = @spaceId
      AND (@includeRestricted = 1 OR NOT ${sqliteEpisodeRestrictedSql('source')})
  `;
}

function correctionQuery(factCount) {
  const factIds = Array.from({ length: factCount }, (_, index) => `@factId${index}`).join(', ');
  const fields = ['kind', 'factId', 'action'];
  const selected = fields.map((field) => `
      substr(CAST(json_extract(metadata_json, '$.${field}') AS TEXT), 1, @fieldChars)
        AS metadata_${field.toLowerCase()}`
  ).join(',');
  const clipped = fields.map((field) => `
      length(CAST(json_extract(metadata_json, '$.${field}') AS BLOB)) > @fieldBytes`
  ).join(' OR ');
  return `
    WITH ranked AS (
      SELECT correction.rowid AS correction_rowid,
        json_extract(metadata_json, '$.factId') AS fact_id,
        row_number() OVER (
          PARTITION BY json_extract(metadata_json, '$.factId')
          ORDER BY created_at DESC, correction.rowid DESC
        ) AS correction_rank,
        count(*) OVER (
          PARTITION BY json_extract(metadata_json, '$.factId')
        ) AS correction_count
      FROM episodes correction
      WHERE space_id = @spaceId
        AND json_extract(metadata_json, '$.kind') = 'lens_correction'
        AND json_extract(metadata_json, '$.factId') IN (${factIds})
        AND (@includeRestricted = 1 OR NOT ${sqliteEpisodeRestrictedSql('correction')})
    )
    SELECT correction.id, correction.space_id, correction.source_kind,
      substr(body, 1, @bodyChars) AS body_preview,
      length(CAST(body AS BLOB)) > @bodyBytes AS body_truncated,
      source_uri,${selected}, ranked.fact_id, ranked.correction_count,
      ((${clipped}) OR EXISTS (
        SELECT 1 FROM json_each(metadata_json)
        WHERE key NOT IN ('kind', 'factId', 'action')
      )) AS metadata_truncated,
      correction.created_at
    FROM ranked
    JOIN episodes correction ON correction.rowid = ranked.correction_rowid
    WHERE ranked.correction_rank <= @correctionLimit
    ORDER BY ranked.fact_id, ranked.correction_rank
  `;
}

function mapSourceRow(row) {
  if (!row) return null;
  return mapRow(row, row.metadata_truncated ? {} : JSON.parse(row.metadata_preview));
}

function mapCorrectionRow(row) {
  if (!row) return null;
  const metadata = {};
  for (const [key, column] of [
    ['kind', 'metadata_kind'], ['factId', 'metadata_factid'], ['action', 'metadata_action']
  ]) if (typeof row[column] === 'string') metadata[key] = row[column];
  return mapRow(row, metadata);
}

function mapRow(row, metadata) {
  return {
    id: row.id,
    spaceId: row.space_id,
    sourceKind: row.source_kind,
    body: row.body_preview,
    bodyTruncated: row.body_truncated === 1,
    sourceUri: row.source_uri,
    metadata,
    metadataTruncated: row.metadata_truncated === 1,
    createdAt: row.created_at
  };
}
