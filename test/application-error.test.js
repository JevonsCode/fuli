import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicationError,
  ApplicationErrorCode
} from '../src/app/application-error.js';
import { createApplication } from '../src/app/create-application.js';
import { FileStore } from '../src/store.js';

test('application not-found errors expose a generic code without HTTP state', () => {
  const app = createApplication({ store: new FileStore(':memory:') });

  assert.throws(
    () => app.requireSpaceId({ name: 'Missing', label: 'Space' }),
    (error) => {
      assert.equal(error instanceof ApplicationError, true);
      assert.equal(error.code, ApplicationErrorCode.NOT_FOUND);
      assert.equal('statusCode' in error, false);
      assert.equal(error.message, 'Space not found: Missing');
      return true;
    }
  );
});

test('application rejects invalid candidate decisions with a validation code', () => {
  const app = createApplication({ store: new FileStore(':memory:') });
  const { personal, space } = app.bootstrap();
  const candidate = app.remember({
    personalSpaceId: personal.id,
    targetSpaceId: space.id,
    sourceKind: 'chat',
    body: 'maybe split this module later'
  }).candidate;

  assert.throws(
    () => app.decideCandidate(candidate.id, 'archive'),
    (error) => {
      assert.equal(error instanceof ApplicationError, true);
      assert.equal(error.code, ApplicationErrorCode.VALIDATION);
      assert.equal('statusCode' in error, false);
      return true;
    }
  );
});

test('application uses not-found codes for active spaces and candidates', () => {
  const app = createApplication({ store: new FileStore(':memory:') });

  for (const action of [
    () => app.requireActivePersonalSpace(),
    () => app.decideCandidate('missing-candidate', 'sync')
  ]) {
    assert.throws(action, (error) => {
      assert.equal(error instanceof ApplicationError, true);
      assert.equal(error.code, ApplicationErrorCode.NOT_FOUND);
      assert.equal('statusCode' in error, false);
      return true;
    });
  }
});
