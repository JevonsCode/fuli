import {
  ApplicationError,
  ApplicationErrorCode
} from '../app/application-error.js';
import { JsonBodyTooLargeError } from './response.js';

const BAD_REQUEST_CODES = new Set([
  ApplicationErrorCode.NOT_FOUND,
  ApplicationErrorCode.VALIDATION
]);

export function mapHttpError(error) {
  if (error instanceof JsonBodyTooLargeError) {
    return { status: 413, body: { error: 'Request body too large' } };
  }

  if (error instanceof SyntaxError) {
    return { status: 400, body: { error: 'Malformed JSON' } };
  }

  if (error instanceof ApplicationError && BAD_REQUEST_CODES.has(error.code)) {
    return { status: 400, body: { error: error.message } };
  }

  return { status: 500, body: { error: 'Internal server error' } };
}
