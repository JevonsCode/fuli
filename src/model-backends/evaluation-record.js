import { z } from 'zod';

import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, requireJsonFormatVersion, updateVersionedJsonFileAtomic } from '../storage/json-format.js';

// Evaluations of a role's model run on this computer (rec#10 D-36.6), as the
// settings page names them: which case set, when, which model, and how often
// the model agreed with the labels. A result describes that set on that day,
// not the model's accuracy in general. The Tonborg review evaluation
// (acceptance/tonborg-review-eval/score.js --record) adds one when asked; the
// page only reads. Nothing here unlocks or blocks anything.

export const MODEL_EVALUATIONS_FORMAT = jsonFormat({ store: 'model-evaluations', versions: [1] });
const MAX_RESULTS = 200;

const text = z.string().trim().min(1).max(200);
const resultSchema = z.object({ role: text, operation: text, model: text, endpoint: text, set: text,
  evaluatedAt: z.string().datetime({ offset: true }), agreed: z.number().int().min(0), total: z.number().int().min(1) })
  .strict().refine(result => result.agreed <= result.total, 'agreed cannot exceed total');
const documentSchema = z.object({ version: z.literal(1), results: z.array(resultSchema).max(MAX_RESULTS) }).strict();

// The latest result, by time, for this role, operation, model and endpoint
// (the same model name served elsewhere is another result); null when there
// is none, or the file cannot be read as this FULI's format.
export function latestEvaluation(path, { role, operation, model, endpoint }, { read = readJsonFile } = {}) {
  const document = readDocument(path, read);
  return document?.results.filter(result => result.role === role && result.operation === operation && result.model === model
    && result.endpoint === endpoint).sort((a, b) => Date.parse(a.evaluatedAt) - Date.parse(b.evaluatedAt)).at(-1) ?? null;
}

// Keeps the newest MAX_RESULTS results.
export function recordEvaluation(path, result) {
  const entry = resultSchema.parse(result);
  updateVersionedJsonFileAtomic(path, MODEL_EVALUATIONS_FORMAT, current => {
    const results = current ? documentSchema.parse(current).results : [];
    return { version: 1, results: [...results, entry].slice(-MAX_RESULTS) };
  });
}

function readDocument(path, read) {
  try {
    const document = read(path, null);
    if (document === null) return null;
    requireJsonFormatVersion(document, MODEL_EVALUATIONS_FORMAT);
    return documentSchema.parse(document);
  } catch {
    return null;
  }
}
