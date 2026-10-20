import {
  ApplicationError,
  ApplicationErrorCode,
  isControlledError
} from '../app/application-error.js';
import { JsonBodyTooLargeError } from './response.js';
import { ProviderRequestError } from '../graphiti/provider-client.js';
import { EmployeeError } from '../employees/manifest.js';
import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';

const BAD_REQUEST_CODES = new Set([
  ApplicationErrorCode.NOT_FOUND,
  ApplicationErrorCode.VALIDATION
]);

export function mapHttpError(error) {
  if (error instanceof ApplicationError && ['external_knowledge_busy', 'external_knowledge_conflict'].includes(error.code)) {
    return { status: 409, body: { error: error.message, code: error.code } };
  }
  if (error instanceof EmployeeError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  // A local store whose data format this version cannot use (rec#17): the
  // message says whether to upgrade, restore a backup or confirm a migration.
  if (error instanceof DataFormatError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof JsonBodyTooLargeError) {
    return { status: 413, body: { error: 'Request body too large' } };
  }

  if (error instanceof SyntaxError) {
    return { status: 400, body: { error: 'Malformed JSON' } };
  }

  if (isControlledError(error) && error.status >= 400 && error.status <= 499) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }

  if (isControlledError(error) && BAD_REQUEST_CODES.has(error.code)) {
    return { status: 400, body: { error: error.message } };
  }

  if (error instanceof ProviderRequestError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return { status, body: { error: error.message, code: error.code } };
  }

  if (error instanceof TypeError) {
    return { status: 400, body: { error: error.message } };
  }

  return { status: 500, body: { error: 'Internal server error' } };
}
