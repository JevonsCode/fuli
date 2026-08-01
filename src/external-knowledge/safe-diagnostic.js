import { detectSensitiveContent } from '../security/sensitive-content.js';

const PROTECTED_DIAGNOSTIC = 'External source failed; protected diagnostic omitted.';

export function safeExternalSourceDiagnostic(reason) {
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  if (detectSensitiveContent(message).restricted) return PROTECTED_DIAGNOSTIC;
  const normalized = message
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000);
  return normalized || 'External source failed without a diagnostic.';
}
