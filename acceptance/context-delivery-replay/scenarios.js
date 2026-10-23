// The replayed scenarios (rec#15 design 6361089970 S1–S11, D-27, dot contract
// 6361260298 item 7). All prompts, messages and preferences are synthetic.
import { replayWorld } from './harness.js';
import { syntheticPreference as rule } from '../../test-support/synthetic-context-session.js';

const GENERAL = rule('tradeoffs', 'SYNTHETIC_GENERAL: state the tradeoff in one line.', {}, 'personality');
// An old-format confirmed judgment rule: no scene key, no constraint marker.
const BOUNDARY = rule('no-unapproved-push', 'SYNTHETIC_BOUNDARY 未经批准不要强推共享分支', {}, 'judgment_preference');
const SPACING = rule('spacing', 'SYNTHETIC_FRONTEND: use the 8px spacing grid.', { tasteDomain: 'frontend' });
const PALETTE = rule('palette', 'SYNTHETIC_DESIGN: prefer muted palettes.', { tasteDomain: 'design' });
const RADIUS = rule('radius', 'SYNTHETIC_FRONTEND: 4px radius.', { tasteDomain: 'frontend' });
const EDITED_SPACING = { ...SPACING, instruction: 'SYNTHETIC_FRONTEND: use the 4px spacing grid.' };

// An oracle independent of the projection: the replayed model view holds
// exactly these items with these bodies.
const keys = items => `[${items.map(item => item.preference_key).sort().join(', ')}]`;
function holds(turn, items) {
  const view = turn.modelPreferences;
  return view.size === items.length && items.every(item => view.get(item.preference_key) === item.instruction);
}

const WORK = '继续实现导出接口';
const FRONTEND = '修复设置页面的按钮';
const CHAT = '你好！';

// C (Codex) opens the conversation; H (Claude Code) joins it by the pointer
// and an explicit resume.
async function joined(world) {
  const c = await world.open('codex', 'C');
  await c.turn(WORK, { note: 'C new session' });
  const h = await world.open('claude_code', 'H');
  return { c, h };
}

export const SCENARIOS = {
  // The three acceptance scenarios (6340910996): C xxx/yyy; H via pointer +
  // resume; back in C only zzz.
  async acceptance(world) {
    const c = await world.open('codex', 'C');
    await c.turn(WORK, { note: 'C turn 1, new session' });
    await c.say('user', 'xxx');
    await c.say('assistant', 'Noted xxx.');
    await c.turn(WORK, { note: 'C turn 2, own xxx' });
    await c.say('user', 'yyy');
    await c.say('assistant', 'Noted yyy.');
    const s1 = await c.turn(WORK, { note: 'S1 C turn 3, own xxx/yyy' });
    world.check('S1: C is sent neither xxx nor yyy', s1.messages_sent === 0);
    const h = await world.open('claude_code', 'H');
    const pointer = await h.turn(WORK, { note: 'S2 H turn 1, pointer only' });
    world.check('S2: the new session gets a pointer and no messages', pointer.pointer_bytes !== null && pointer.messages_sent === 0);
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    const resumed = await h.turn(WORK, { note: 'S2 H turn 2, after resume' });
    world.check('S2: after resume H recovers xxx and yyy', resumed.messages_sent === 4);
    await h.say('user', 'zzz');
    await h.say('assistant', 'Noted zzz.');
    await h.turn(WORK, { note: 'S2 H turn 3, own zzz' });
    const back = await c.turn(WORK, { note: 'S3 C turn 4, back in C' });
    world.check('S3: back in C only zzz is sent', back.messages_sent === 2);
    await c.turn(WORK, { note: 'S3 C turn 5, settled' });
  },

  async compact_resume(world) {
    const { c, h } = await joined(world);
    await h.turn(WORK, { note: 'H pointer entry' });
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    await c.say('user', 'before compaction');
    await h.say('user', 'from H');
    await c.turn(WORK, { note: 'C before compaction' });
    await c.turn(WORK, { note: 'C settled' });
    await c.compact();
    const after = await c.turn(WORK, { note: 'C after compaction' });
    world.check('compact: the new generation receives the window again', after.messages_sent === 2);
    await c.turn(WORK, { note: 'C after compaction, settled' });
    await h.turn(WORK, { note: 'H before resume' });
    await h.sessionStart('resume');
    const resumed = await h.turn(WORK, { note: 'H after SessionStart resume' });
    world.check('resume: the new generation receives the window again', resumed.messages_sent === 2);
    await h.turn(WORK, { note: 'H after resume, settled' });
  },

  async delivery_failure(world) {
    const { c, h } = await joined(world);
    await h.turn(WORK, { note: 'H pointer entry' });
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    await h.say('user', 'from H');
    await c.turn(WORK, { record: false, note: 'C output lost' });
    await c.turn(WORK, { record: false, note: 'C output lost again' });
    await c.turn(WORK, { preview: true, note: 'C recorded as preview only' });
    const resent = await c.turn(WORK, { note: 'C resend, recorded' });
    world.check('failure: the lost message is resent', resent.messages_sent === 1);
    await c.turn(WORK, { note: 'C settled' });
    await c.say('user', 'from C');
    await h.turn(WORK, { record: false, note: 'H output lost' });
    const again = await h.turn(WORK, { note: 'H resend, recorded' });
    world.check('failure: H resends the lost message', again.messages_sent === 1);
    await h.turn(WORK, { note: 'H settled' });
  },

  // frontend -> chat -> frontend; the old-format boundary stays in every view.
  // The expected sets are written out here, independent of the projection.
  async scene_switch(world) {
    world.items = [BOUNDARY, GENERAL, SPACING, PALETTE];
    const frontend = [BOUNDARY, GENERAL, SPACING, PALETTE];
    for (const [client, label] of [['claude_code', 'H'], ['codex', 'C']]) {
      const session = await world.open(client, label);
      for (const [prompt, note, expected] of [[FRONTEND, 'frontend', frontend], [CHAT, 'chat', [BOUNDARY]],
        [FRONTEND, 'frontend again', frontend], [FRONTEND, 'frontend, same scene', frontend]]) {
        const turn = await session.turn(prompt, { note });
        world.check(`${label} ${note}: the model view is exactly ${keys(expected)}`, holds(turn, expected));
        world.check(`${label} ${note}: the boundary key and body are in the model view`,
          turn.modelPreferences.get(BOUNDARY.preference_key) === BOUNDARY.instruction);
      }
    }
  },

  // Design S6: a 4th preference in the same scene. Claude's hook frame is
  // confirmed by its attachment ID, so it is one update; a Codex hook frame
  // has no ID, so Codex conservatively sends the full set again.
  async add_fourth(world) {
    const three = [GENERAL, SPACING, PALETTE];
    world.items = three;
    for (const [client, label] of [['claude_code', 'H'], ['codex', 'C']]) {
      const session = await world.open(client, label);
      world.items = three;
      world.check(`${label} 3 items: the model view is exactly ${keys(three)}`, holds(await session.turn(FRONTEND, { note: '3 items' }), three));
      world.items = [...three, RADIUS];
      const fourth = await session.turn(FRONTEND, { note: '4th item added' });
      world.check(`${label} 4th item: the model view is exactly ${keys(world.items)}`, holds(fourth, world.items));
      world.check(client === 'claude_code' ? 'H 4th item: the Claude hook sends one update (delta)'
        : 'C 4th item: Codex resends the full set of 4 (no frame ID to confirm)',
      client === 'claude_code' ? fourth.preference_delivery === 'delta' && fourth.preferences_sent === 1
        : fourth.preference_delivery === 'full' && fourth.preferences_sent === 4);
    }
  },

  async edit_withdraw(world) {
    world.items = [GENERAL, SPACING, PALETTE];
    const { c, h } = await joined(world);
    await h.turn(FRONTEND, { note: 'H pointer entry' });
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    await h.say('user', 'original');
    await h.say('user', 'stays');
    await h.turn(FRONTEND, { note: 'H frontend' });
    await c.turn(FRONTEND, { note: 'C frontend' });
    world.items = [GENERAL, EDITED_SPACING, PALETTE];
    const edited = [GENERAL, EDITED_SPACING, PALETTE];
    for (const session of [h, c]) {
      const turn = await session.turn(FRONTEND, { note: `${session.label} after a preference edit` });
      world.check(`${session.label} edit: the model view holds the edited body`, holds(turn, edited));
    }
    world.items = world.items.filter(item => item.preference_key !== 'palette');
    world.withdrawn = { preferences: ['palette'], messages: ['original'] };
    world.provider.boundTo('codex', c.sessionId).window = { override: { 1: 'replacement' } };
    const kept = [GENERAL, EDITED_SPACING];
    const hWithdrawn = await h.turn(FRONTEND, { note: 'H after a preference withdraw and a message replacement' });
    const withdrawn = await c.turn(FRONTEND, { note: 'C after a preference withdraw and a message replacement' });
    world.check('withdraw: C is told the replaced message version is withdrawn', withdrawn.withdrawn_sequences.includes(1));
    for (const turn of [hWithdrawn, withdrawn, await h.turn(FRONTEND, { note: 'H settled' }),
      await c.turn(FRONTEND, { note: 'C settled' })]) {
      world.check(`${turn.session} ${turn.note}: the model view is exactly ${keys(kept)}`, holds(turn, kept));
    }
  },

  async no_match_chat(world) {
    world.items = [GENERAL, SPACING];
    for (const [client, label] of [['claude_code', 'H'], ['codex', 'C']]) {
      const session = await world.open(client, label);
      for (const note of ['chat', 'chat again']) {
        const turn = await session.turn('谢谢', { note });
        world.check(`${label} ${note}: no preference is injected`, turn.preferences_sent === 0);
        world.check(`${label} ${note}: the model view is the empty set`, holds(turn, []));
      }
    }
  }
};

// Scenarios that set no preferences carry one general synthetic rule.
export const runScenario = name => replayWorld(SCENARIOS[name], { items: [GENERAL] });
