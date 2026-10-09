import { fail, text } from './domain.js';

export const ROUNDTABLE_PROTOCOL = Object.freeze({
  name: 'fuli-roundtable',
  version: '1'
});

const MAX_PROFILE_CAPABILITIES = 32;
const MAX_CAPABILITY_BYTES = 128;
const MAX_QUERY_BYTES = 128;

/**
 * Self profiles are public declarations. They never change the coordinator's
 * seat role, runtime, execution permission or private Agent context.
 */
export function normalizeSelfProfile(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_self_profile', 'selfProfile must be an object');
  }
  const result = {};
  if (value.responsibility !== undefined) result.responsibility = text(value.responsibility, 'selfProfile.responsibility', 2048);
  if (value.introduction !== undefined) result.introduction = text(value.introduction, 'selfProfile.introduction', 2048);
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length > MAX_PROFILE_CAPABILITIES) {
      fail('invalid_self_profile', `selfProfile.capabilities must contain at most ${MAX_PROFILE_CAPABILITIES} entries`);
    }
    const capabilities = value.capabilities.map((capability) => text(capability, 'selfProfile.capability', MAX_CAPABILITY_BYTES));
    if (new Set(capabilities.map(capability => capability.toLocaleLowerCase())).size !== capabilities.length) {
      fail('invalid_self_profile', 'selfProfile.capabilities must be unique');
    }
    result.capabilities = capabilities;
  }
  if (!Object.keys(result).length) fail('invalid_self_profile', 'selfProfile must declare responsibility, capabilities or introduction');
  return result;
}

export function normalizeCapabilityQuery(value) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, 'capabilityQuery', MAX_QUERY_BYTES).toLocaleLowerCase();
}

export function matchesCapabilityQuery(seat, query) {
  if (!query) return true;
  const profile = seat.selfProfile;
  return Array.isArray(profile?.capabilities) && profile.capabilities.some(capability => capability.toLocaleLowerCase().includes(query));
}

export function publicRoster(seats, query = null) {
  return seats.filter(seat => matchesCapabilityQuery(seat, query));
}

export function nextRoundtableAction(room, seat) {
  if (!seat.joinedAt) return { action: 'join', required: true, seatId: seat.id, reason: 'seat_not_joined' };
  if (room.status === 'concluded' || room.status === 'cancelled' || room.status === 'failed') {
    return { action: 'done', required: false, reason: room.status };
  }
  const turn = room.currentTurn;
  if (turn) {
    const ownTurn = turn.seatId === seat.id;
    if (room.status !== 'active') {
      return { action: 'wait', required: ownTurn, reason: room.stopReason ?? room.status, turnId: turn.id, seatId: turn.seatId, phase: turn.phase };
    }
    if (ownTurn && turn.status === 'pending') {
      return { action: 'claim', required: true, turnId: turn.id, phase: turn.phase };
    }
    if (ownTurn && turn.status === 'claimed') {
      return { action: 'submit', required: true, turnId: turn.id, attemptId: turn.attemptId, fence: turn.fence, deadline: turn.deadline, phase: turn.phase };
    }
    if (ownTurn) {
      return { action: 'wait', required: true, reason: room.stopReason ?? turn.status, turnId: turn.id, seatId: turn.seatId, phase: turn.phase };
    }
    return { action: 'wait', required: false, reason: 'another_seat_turn', turnId: turn.id, seatId: turn.seatId, phase: turn.phase };
  }
  if (room.status === 'draft') return { action: 'wait', required: false, reason: 'room_not_started' };
  return { action: 'wait', required: false, reason: room.stopReason ?? room.status };
}

export const DISCOVERY_INSTRUCTIONS = Object.freeze([
  'Join your invited seat with an optional public selfProfile describing your responsibility and capabilities.',
  'Use capabilityQuery in discover_roundtable to find invited peers with matching declared capabilities.',
  'Use message_roundtable for an addressed question or handoff; peer messages never claim or advance a turn.',
  'When nextAction.action is claim, claim your own turn, follow its scoped context, and submit one final response.'
]);
