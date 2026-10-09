export const PARTICIPANT_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['body', 'status', 'artifacts', 'verification', 'dissent'],
  properties: {
    body: { type: 'string', minLength: 1, maxLength: 12000 },
    status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
    artifacts: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
      required: ['id', 'uri'], properties: { id: { type: 'string', minLength: 1, maxLength: 1024 }, uri: { type: 'string', minLength: 1, maxLength: 2048 } } } },
    verification: { type: 'object', additionalProperties: false, required: ['passed', 'summary'],
      properties: { passed: { type: ['boolean', 'null'] }, summary: { type: 'string', maxLength: 2048 } } },
    dissent: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 1024 } }
  }
};

export function parseRoundtableParticipantResult(result, phase) {
  let envelope;
  try { envelope = JSON.parse(result.body); } catch {
    throw Object.assign(new Error('Participant must return the requested JSON result envelope'), { code: 'result_contract_invalid', actual: result.actual });
  }
  if (!envelope || typeof envelope.body !== 'string' || !envelope.body.trim() || Buffer.byteLength(envelope.body) > 16_384 ||
      !['completed', 'failed', 'blocked'].includes(envelope.status) || !Array.isArray(envelope.artifacts) || envelope.artifacts.length > 20 ||
      envelope.artifacts.some(artifact => !artifact || !boundedText(artifact.id, 1024) || !boundedText(artifact.uri, 2048)) ||
      !Array.isArray(envelope.dissent) || envelope.dissent.length > 16 || envelope.dissent.some(item => !boundedText(item, 2048)) ||
      Buffer.byteLength(JSON.stringify(envelope.dissent), 'utf8') > 8192 ||
      !envelope.verification || ![true, false, null].includes(envelope.verification.passed) ||
      typeof envelope.verification.summary !== 'string' || Buffer.byteLength(envelope.verification.summary, 'utf8') > 2048) {
    throw Object.assign(new Error('Invalid participant result structure'), { code: 'result_contract_invalid', actual: result.actual });
  }
  if (envelope.status === 'completed' && phase === 'review' && typeof envelope.verification.passed !== 'boolean') {
    throw Object.assign(new Error('Review requires an explicit verification verdict'), { code: 'review_verdict_required', actual: result.actual });
  }
  if (envelope.status === 'completed' && phase === 'implementation' && envelope.artifacts.length === 0) {
    throw Object.assign(new Error('Implementation requires actual artifact references'), { code: 'artifact_required', actual: result.actual });
  }
  const artifacts = [...envelope.artifacts, ...(Array.isArray(result.artifacts) ? result.artifacts : [])];
  if (artifacts.length > 20 || artifacts.some(artifact => typeof artifact === 'string' ? !boundedText(artifact, 1024) :
    !artifact || !boundedText(artifact.id ?? artifact.artifactId, 1024) ||
    ['name', 'uri', 'mimeType', 'kind'].some(key => artifact[key] !== undefined && !boundedText(artifact[key], 2048)))) {
    throw Object.assign(new Error('Invalid or excessive adapter artifact references'), { code: 'result_contract_invalid', actual: result.actual });
  }
  return { ...result, body: envelope.body, status: envelope.status,
    artifacts, verification: envelope.verification, dissent: envelope.dissent };
}

function boundedText(value, bytes) {
  return typeof value === 'string' && Boolean(value.trim()) && Buffer.byteLength(value, 'utf8') <= bytes;
}
