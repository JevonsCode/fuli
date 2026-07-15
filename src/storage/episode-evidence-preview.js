export const MAX_EPISODE_EVIDENCE_BODY_BYTES = 16 * 1024;
export const MAX_EPISODE_METADATA_BYTES = 16 * 1024;
export const MAX_EPISODE_METADATA_FIELD_BYTES = 2048;
export const DEFAULT_CORRECTION_EVIDENCE_PER_FACT = 5;
export const MAX_CORRECTION_EVIDENCE_PER_FACT = 20;

export function normalizeEvidencePreviewOptions(options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_EPISODE_EVIDENCE_BODY_BYTES;
  if (
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes < 0 ||
    maxBodyBytes > MAX_EPISODE_EVIDENCE_BODY_BYTES
  ) {
    throw new TypeError(
      `Episode evidence body limit must be between 0 and ${MAX_EPISODE_EVIDENCE_BODY_BYTES}`
    );
  }
  return {
    maxBodyBytes,
    includeRestricted: options.includeRestricted === true
  };
}

export function normalizeCorrectionEvidencePreviewOptions(options = {}) {
  const normalized = normalizeEvidencePreviewOptions(options);
  const maxCorrectionsPerFact = options.maxCorrectionsPerFact ??
    DEFAULT_CORRECTION_EVIDENCE_PER_FACT;
  if (
    !Number.isInteger(maxCorrectionsPerFact) ||
    maxCorrectionsPerFact < 1 ||
    maxCorrectionsPerFact > MAX_CORRECTION_EVIDENCE_PER_FACT
  ) {
    throw new TypeError(
      `Correction evidence limit must be between 1 and ${MAX_CORRECTION_EVIDENCE_PER_FACT}`
    );
  }
  return { ...normalized, maxCorrectionsPerFact };
}

export function previewEpisode(episode, options, { correction = false } = {}) {
  if (!episode) return null;
  const { value: body, truncated: bodyTruncated } = clipUtf8(
    episode.body,
    options.maxBodyBytes
  );
  const metadata = correction
    ? previewCorrectionMetadata(episode.metadata)
    : previewSourceMetadata(episode.metadata);
  const truncatedFields = [];
  if (bodyTruncated || episode.bodyTruncated) truncatedFields.push('body');
  if (metadata.truncated || episode.metadataTruncated) truncatedFields.push('metadata');

  return {
    id: episode.id,
    spaceId: episode.spaceId,
    sourceKind: episode.sourceKind,
    body,
    sourceUri: episode.sourceUri,
    metadata: metadata.value,
    createdAt: episode.createdAt,
    truncatedFields
  };
}

export function clipUtf8(value, maxBytes) {
  const text = typeof value === 'string' ? value : '';
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return { value: text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

function previewSourceMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { value: {}, truncated: metadata !== undefined };
  }
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EPISODE_METADATA_BYTES) {
    return { value: {}, truncated: true };
  }
  return { value: JSON.parse(serialized), truncated: false };
}

function previewCorrectionMetadata(metadata) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
  const value = {};
  let truncated = Object.keys(source).some(
    (key) => !['kind', 'factId', 'action'].includes(key)
  );
  for (const key of ['kind', 'factId', 'action']) {
    if (typeof source[key] !== 'string') continue;
    const clipped = clipUtf8(source[key], MAX_EPISODE_METADATA_FIELD_BYTES);
    value[key] = clipped.value;
    truncated ||= clipped.truncated;
  }
  return { value, truncated };
}
