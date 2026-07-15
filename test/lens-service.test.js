import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError, ApplicationErrorCode } from '../src/app/application-error.js';
import { LensService } from '../src/lens/lens-service.js';
import { FactScope, FactStatus, Sensitivity, SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';
import { STORE_METHODS } from '../src/storage/store-port.js';

test('explicit user fact is confirmed with personal scope, supplied sensitivity, confidence, and source', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const lens = new LensService(store);

  const result = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我更熟悉 JavaScript',
    sourceKind: 'conversation',
    sensitivity: Sensitivity.PRIVATE,
    confidence: 0.9
  });

  assert.equal(result.fact.status, FactStatus.CONFIRMED);
  assert.equal(result.fact.scope, FactScope.PERSONAL);
  assert.equal(result.fact.sensitivity, Sensitivity.PRIVATE);
  assert.equal(result.fact.confidence, 0.9);
  assert.equal(store.getEpisode(result.fact.sourceEpisodeId).body, '我更熟悉 JavaScript');
});

test('direct observations are observed and inferred observations are suggested', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const lens = new LensService(store);

  const direct = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_minimal_ui',
    value: 'true',
    evidenceText: '用户直接说希望界面保持克制',
    inference: 'direct',
    confidence: 0.8
  });
  const inferred = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_explicit_modules',
    value: 'true',
    evidenceText: '用户连续要求拆分模块',
    inference: 'inferred'
  });

  assert.equal(direct.fact.status, FactStatus.OBSERVED);
  assert.equal(inferred.fact.status, FactStatus.SUGGESTED);
  assert.equal(direct.fact.scope, FactScope.PERSONAL);
  assert.equal(inferred.fact.scope, FactScope.PERSONAL);
  assert.equal(direct.fact.confidence, 0.8);
  assert.equal(store.getEpisode(inferred.fact.sourceEpisodeId).body, '用户连续要求拆分模块');
  assert.throws(
    () => lens.submitUserObservation({
      personalSpaceId: personal.id,
      predicate: 'prefers_explicit_modules',
      value: 'true',
      evidenceText: '用户确认了这个偏好',
      inference: 'confirmed'
    }),
    (error) => error instanceof ApplicationError && error.code === ApplicationErrorCode.VALIDATION
  );
});

test('repeated explicit facts preserve sources and leave one equivalent current fact', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const lens = new LensService(store);

  const first = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '第一次明确表达偏好'
  });
  const second = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '第二次明确表达偏好'
  });

  assert.equal(store.listEpisodes().length, 2);
  assert.equal(store.listFacts({ includeHistorical: true }).length, 2);
  assert.deepEqual(store.currentFacts(personal.id).map((fact) => fact.id), [second.fact.id]);
  assert.equal(store.getFact(first.fact.id).replacedByFactId, second.fact.id);
});

test('weaker repeated observations preserve evidence without replacing stronger authority', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const lens = new LensService(store);

  const first = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: '第一次观察',
    inference: 'direct'
  });
  const second = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: '第二次观察',
    inference: 'inferred'
  });

  assert.equal(store.listEpisodes().length, 2);
  assert.equal(store.listFacts({ includeHistorical: true }).length, 2);
  assert.deepEqual(store.currentFacts(personal.id).map((fact) => fact.id), [first.fact.id]);
  assert.equal(second.fact.invalidAt !== null, true);
  assert.equal(second.fact.replacedByFactId, first.fact.id);
});

test('confirmed restricted authority survives equivalent direct and inferred observations', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const lens = new LensService(store);
  const confirmed = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_small_modules',
    value: 'true',
    sourceText: '我确认偏好小模块',
    sensitivity: Sensitivity.RESTRICTED,
    confidence: 0.93
  });
  const direct = recordEquivalent(lens, personal.id, FactStatus.OBSERVED, 'direct evidence');
  const inferred = recordEquivalent(lens, personal.id, FactStatus.SUGGESTED, 'inferred evidence');

  assert.deepEqual(store.currentFacts(personal.id).map((fact) => fact.id), [confirmed.fact.id]);
  assert.equal(store.getFact(confirmed.fact.id).sensitivity, Sensitivity.RESTRICTED);
  assert.equal(store.getFact(confirmed.fact.id).confidence, 0.93);
  for (const result of [direct, inferred]) {
    assert.equal(result.fact.invalidAt !== null, true);
    assert.equal(result.fact.replacedByFactId, confirmed.fact.id);
  }
  assert.equal(store.listEpisodes().length, 3);
  assert.equal(store.listFacts({ includeHistorical: true }).length, 3);
});

test('equivalent facts obey confirmed, observed, suggested precedence with latest equal authority winning', () => {
  const cases = [
    [FactStatus.SUGGESTED, FactStatus.SUGGESTED],
    [FactStatus.SUGGESTED, FactStatus.OBSERVED],
    [FactStatus.SUGGESTED, FactStatus.CONFIRMED],
    [FactStatus.OBSERVED, FactStatus.SUGGESTED],
    [FactStatus.OBSERVED, FactStatus.OBSERVED],
    [FactStatus.OBSERVED, FactStatus.CONFIRMED],
    [FactStatus.CONFIRMED, FactStatus.SUGGESTED],
    [FactStatus.CONFIRMED, FactStatus.OBSERVED],
    [FactStatus.CONFIRMED, FactStatus.CONFIRMED]
  ];

  for (const [existingStatus, incomingStatus] of cases) {
    const store = new FileStore(':memory:');
    const personal = store.createSpace(`${existingStatus}-${incomingStatus}`, SpaceKind.PERSONAL);
    const lens = new LensService(store);
    const existing = recordEquivalent(lens, personal.id, existingStatus, 'existing evidence');
    const incoming = recordEquivalent(lens, personal.id, incomingStatus, 'incoming evidence');
    const incomingWins = statusRank(incomingStatus) >= statusRank(existingStatus);
    const winner = incomingWins ? incoming.fact : existing.fact;
    const loser = incomingWins ? store.getFact(existing.fact.id) : incoming.fact;

    assert.deepEqual(store.currentFacts(personal.id).map((fact) => fact.id), [winner.id]);
    assert.equal(loser.invalidAt !== null, true);
    assert.equal(loser.replacedByFactId, winner.id);
    assert.equal(store.listEpisodes().length, 2);
    assert.equal(store.listFacts({ includeHistorical: true }).length, 2);
  }
});

test('a write collapses legacy equivalent current duplicates to the strongest latest fact', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const statuses = [
    FactStatus.CONFIRMED,
    FactStatus.OBSERVED,
    FactStatus.CONFIRMED,
    FactStatus.SUGGESTED
  ];
  const legacy = statuses.map((status, index) => {
    const episode = store.addEpisode(personal.id, 'legacy', `legacy evidence ${index}`);
    return store.addFact(personalFact({
      spaceId: personal.id,
      sourceEpisodeId: episode.id,
      status,
      sensitivity: index === 2 ? Sensitivity.RESTRICTED : Sensitivity.NORMAL,
      confidence: index === 2 ? 0.91 : 0.6
    }));
  });

  const incoming = recordEquivalent(
    new LensService(store),
    personal.id,
    FactStatus.SUGGESTED,
    'new weak evidence'
  );
  const winner = legacy[2];

  assert.deepEqual(store.currentFacts(personal.id).map((fact) => fact.id), [winner.id]);
  assert.equal(store.getFact(winner.id).sensitivity, Sensitivity.RESTRICTED);
  assert.equal(store.getFact(winner.id).confidence, 0.91);
  for (const fact of [...legacy.filter((item) => item.id !== winner.id), incoming.fact]) {
    const historical = store.getFact(fact.id);
    assert.equal(historical.invalidAt !== null, true);
    assert.equal(historical.replacedByFactId, winner.id);
  }
});

test('allows nonsecret restricted facts and rejects credentials at every sensitivity', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const lens = new LensService(store);

  const restricted = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'has_access_boundary',
    value: 'team leads only',
    sourceText: '这个偏好只对团队负责人可见',
    sensitivity: Sensitivity.RESTRICTED
  });
  assert.equal(restricted.fact.sensitivity, Sensitivity.RESTRICTED);

  for (const sensitivity of Object.values(Sensitivity)) {
    assert.throws(() => lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'credential',
      value: 'glpat-abcdefghijklmnopqrst',
      sourceText: '保存这个访问凭据',
      sensitivity
    }), /sensitive content/i);
  }
  assert.equal(store.listEpisodes().length, 1);
  assert.equal(store.listFacts({ includeHistorical: true }).length, 1);
});

test('restricted content is rejected before a transaction or episode write', () => {
  const baseStore = new FileStore(':memory:');
  const personal = baseStore.createSpace('我', SpaceKind.PERSONAL);
  let transactions = 0;
  const store = overrideStore(baseStore, {
    transaction(fn) {
      transactions += 1;
      return baseStore.transaction(fn);
    }
  });
  const lens = new LensService(store);

  assert.throws(
    () => lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'credential',
      value: 'sk-live-12345678901234567890',
      sourceText: '记住 sk-live-12345678901234567890'
    }),
    /sensitive content/i
  );
  assert.equal(transactions, 0);
  assert.equal(baseStore.listEpisodes().length, 0);
  assert.equal(baseStore.listFacts({ includeHistorical: true }).length, 0);
});

test('confirmation preserves original and confirmation episodes and replaces the observation atomically', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const lens = new LensService(store);
  const observed = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: '用户多次要求小模块',
    inference: 'inferred'
  });

  const confirmed = lens.confirmObservation({
    personalSpaceId: personal.id,
    factId: observed.fact.id,
    sourceText: '确认：我确实偏好小模块'
  });
  const oldFact = store.getFact(observed.fact.id);

  assert.equal(confirmed.fact.status, FactStatus.CONFIRMED);
  assert.equal(confirmed.fact.scope, FactScope.PERSONAL);
  assert.equal(oldFact.invalidAt !== null, true);
  assert.equal(oldFact.replacedByFactId, confirmed.fact.id);
  assert.equal(store.getEpisode(observed.fact.sourceEpisodeId).body, '用户多次要求小模块');
  assert.equal(store.getEpisode(confirmed.episode.id).body, '确认：我确实偏好小模块');
  assert.equal(store.listFacts({ includeHistorical: true }).length, 2);
  assert.equal(store.listEpisodes().length, 2);
});

test('confirmation invalidates every equivalent current fact', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const firstEpisode = store.addEpisode(personal.id, 'observation', 'first evidence');
  const secondEpisode = store.addEpisode(personal.id, 'observation', 'second evidence');
  const confirmedEpisode = store.addEpisode(personal.id, 'conversation', 'earlier confirmation');
  const observed = store.addFact(personalFact({
    spaceId: personal.id,
    sourceEpisodeId: firstEpisode.id,
    status: FactStatus.OBSERVED
  }));
  store.addFact(personalFact({
    spaceId: personal.id,
    sourceEpisodeId: secondEpisode.id,
    status: FactStatus.SUGGESTED
  }));
  store.addFact(personalFact({
    spaceId: personal.id,
    sourceEpisodeId: confirmedEpisode.id,
    status: FactStatus.CONFIRMED
  }));

  const result = new LensService(store).confirmObservation({
    personalSpaceId: personal.id,
    factId: observed.id,
    sourceText: '我确认这个偏好'
  });

  assert.equal(store.currentFacts(personal.id).length, 1);
  assert.equal(store.currentFacts(personal.id)[0].id, result.fact.id);
  assert.equal(store.currentFacts(personal.id)[0].status, FactStatus.CONFIRMED);
  assert.equal(store.listFacts({ includeHistorical: true }).length, 4);
});

test('confirmation rolls back both writes when replacement creation fails', () => {
  const baseStore = new FileStore(':memory:');
  const personal = baseStore.createSpace('我', SpaceKind.PERSONAL);
  const observed = new LensService(baseStore).submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: '用户多次要求小模块',
    inference: 'inferred'
  });
  const before = baseStore.exportSnapshot();
  const store = overrideStore(baseStore, {
    addFact() {
      throw new Error('injected confirmation failure');
    }
  });

  assert.throws(
    () => new LensService(store).confirmObservation({
      personalSpaceId: personal.id,
      factId: observed.fact.id,
      sourceText: '确认：我确实偏好小模块'
    }),
    /injected confirmation failure/
  );
  assert.deepEqual(baseStore.exportSnapshot(), before);
});

test('rejects missing, public, wrong-space, and already confirmed facts with application errors', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const otherPersonal = store.createSpace('另一人', SpaceKind.PERSONAL);
  const publicSpace = store.createSpace('工作', SpaceKind.PUBLIC);
  const lens = new LensService(store);
  const observed = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: '用户多次要求小模块',
    inference: 'inferred'
  });
  const other = lens.submitUserObservation({
    personalSpaceId: otherPersonal.id,
    predicate: 'prefers_other',
    value: 'true',
    evidenceText: '另一人的观察',
    inference: 'direct'
  });
  const confirmed = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我更熟悉 JavaScript'
  });

  assert.throws(
    () => lens.submitUserObservation({
      personalSpaceId: publicSpace.id,
      predicate: 'x',
      value: 'y',
      evidenceText: 'z',
      inference: 'direct'
    }),
    (error) => error instanceof ApplicationError && error.code === ApplicationErrorCode.VALIDATION
  );
  assert.throws(
    () => lens.confirmObservation({ personalSpaceId: 'missing', factId: observed.fact.id, sourceText: 'x' }),
    (error) => error instanceof ApplicationError && error.code === ApplicationErrorCode.NOT_FOUND
  );
  assert.throws(
    () => lens.confirmObservation({ personalSpaceId: personal.id, factId: other.fact.id, sourceText: 'x' }),
    (error) => error instanceof ApplicationError && error.code === ApplicationErrorCode.NOT_FOUND
  );
  assert.throws(
    () => lens.confirmObservation({ personalSpaceId: personal.id, factId: confirmed.fact.id, sourceText: 'x' }),
    (error) => error instanceof ApplicationError && error.code === ApplicationErrorCode.VALIDATION
  );
});

function overrideStore(store, overrides) {
  return Object.fromEntries(
    STORE_METHODS.map((method) => [
      method,
      overrides[method] ?? ((...args) => store[method](...args))
    ])
  );
}

function personalFact({
  spaceId,
  sourceEpisodeId,
  status,
  sensitivity = Sensitivity.NORMAL,
  confidence = 0.8
}) {
  return {
    spaceId,
    subject: 'user',
    predicate: 'prefers_small_modules',
    object: 'true',
    sourceEpisodeId,
    status,
    confidence,
    sensitivity,
    scope: FactScope.PERSONAL
  };
}

function recordEquivalent(lens, personalSpaceId, status, sourceText) {
  if (status === FactStatus.CONFIRMED) {
    return lens.rememberUserFact({
      personalSpaceId,
      predicate: 'prefers_small_modules',
      value: 'true',
      sourceText
    });
  }
  return lens.submitUserObservation({
    personalSpaceId,
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: sourceText,
    inference: status === FactStatus.OBSERVED ? 'direct' : 'inferred'
  });
}

function statusRank(status) {
  return {
    [FactStatus.SUGGESTED]: 1,
    [FactStatus.OBSERVED]: 2,
    [FactStatus.CONFIRMED]: 3
  }[status];
}
