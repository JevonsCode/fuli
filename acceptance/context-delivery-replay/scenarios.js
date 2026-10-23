// The replayed scenarios (rec#15 design 6361089970 S1–S11, D-27, dot contract
// 6361260298 item 7). All prompts, messages and preferences are synthetic and
// come from the variant's fixture (fixtures.js); prompts, windows and budgets
// are the same in every variant.
import { replayWorld } from './harness.js';
import { FIXTURES } from './fixtures.js';

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

// One group of native messages; returns their texts.
async function talk(session, world, group) {
  const messages = world.fixture.messages[group];
  for (const [role, text] of messages) await session.say(role, text);
  return messages.map(([, text]) => text);
}

// The turn sent exactly those of `texts` that the Provider's recovery window
// (the uncached entry) holds, at least one, and nothing else.
function sentExactly(turn, texts) {
  // A message the window cut to a prefix ends with … (pack_context).
  const of = shown => texts.some(text => text === shown || (shown.endsWith('…') && text.startsWith(shown.slice(0, -1))));
  const wanted = turn.windowMessages.filter(of);
  return wanted.length > 0 && turn.sentMessages.length === wanted.length && wanted.every(text => turn.sentMessages.includes(text));
}
const sentWholeWindow = turn => sentExactly(turn, turn.windowMessages);

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
    const xxx = await talk(c, world, 'xxx');
    await c.turn(WORK, { note: 'C turn 2, own xxx' });
    const yyy = await talk(c, world, 'yyy');
    const s1 = await c.turn(WORK, { note: 'S1 C turn 3, own xxx/yyy' });
    world.check('S1: C is sent neither xxx nor yyy', s1.messages_sent === 0);
    const h = await world.open('claude_code', 'H');
    const pointer = await h.turn(WORK, { note: 'S2 H turn 1, pointer only' });
    world.check('S2: the new session gets a pointer and no messages', pointer.pointer_bytes !== null && pointer.messages_sent === 0);
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    const resumed = await h.turn(WORK, { note: 'S2 H turn 2, after resume' });
    world.check('S2: after resume H recovers the xxx/yyy window', sentExactly(resumed, [...xxx, ...yyy]) && sentWholeWindow(resumed));
    const zzz = await talk(h, world, 'zzz');
    await h.turn(WORK, { note: 'S2 H turn 3, own zzz' });
    const back = await c.turn(WORK, { note: 'S3 C turn 4, back in C' });
    world.check('S3: back in C only zzz is sent', sentExactly(back, zzz));
    await c.turn(WORK, { note: 'S3 C turn 5, settled' });
  },

  async compact_resume(world) {
    const { c, h } = await joined(world);
    await h.turn(WORK, { note: 'H pointer entry' });
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    await talk(c, world, 'beforeCompaction');
    await talk(h, world, 'fromH');
    await c.turn(WORK, { note: 'C before compaction' });
    await c.turn(WORK, { note: 'C settled' });
    await c.compact();
    const after = await c.turn(WORK, { note: 'C after compaction' });
    world.check('compact: the new generation receives the window again', sentWholeWindow(after));
    await c.turn(WORK, { note: 'C after compaction, settled' });
    await h.turn(WORK, { note: 'H before resume' });
    await h.sessionStart('resume');
    const resumed = await h.turn(WORK, { note: 'H after SessionStart resume' });
    world.check('resume: the new generation receives the window again', sentWholeWindow(resumed));
    await h.turn(WORK, { note: 'H after resume, settled' });
  },

  async delivery_failure(world) {
    const { c, h } = await joined(world);
    await h.turn(WORK, { note: 'H pointer entry' });
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    const fromH = await talk(h, world, 'fromH');
    await c.turn(WORK, { record: false, note: 'C output lost' });
    await c.turn(WORK, { record: false, note: 'C output lost again' });
    await c.turn(WORK, { preview: true, note: 'C recorded as preview only' });
    const resent = await c.turn(WORK, { note: 'C resend, recorded' });
    world.check('failure: the lost messages are resent', sentExactly(resent, fromH));
    await c.turn(WORK, { note: 'C settled' });
    const fromC = await talk(c, world, 'fromC');
    await h.turn(WORK, { record: false, note: 'H output lost' });
    const again = await h.turn(WORK, { note: 'H resend, recorded' });
    world.check('failure: H resends the lost messages', sentExactly(again, fromC));
    await h.turn(WORK, { note: 'H settled' });
  },

  // frontend -> chat -> frontend; the old-format boundary stays in every view.
  // The expected sets are written out here, independent of the projection.
  async scene_switch(world) {
    const { boundary, general, spacing, palette } = world.fixture;
    const frontend = [...boundary, ...general, ...spacing, ...palette];
    world.items = frontend;
    for (const [client, label] of [['claude_code', 'H'], ['codex', 'C']]) {
      const session = await world.open(client, label);
      for (const [prompt, note, expected] of [[FRONTEND, 'frontend', frontend], [CHAT, 'chat', boundary],
        [FRONTEND, 'frontend again', frontend], [FRONTEND, 'frontend, same scene', frontend]]) {
        const turn = await session.turn(prompt, { note });
        world.check(`${label} ${note}: the model view is exactly ${keys(expected)}`, holds(turn, expected));
        world.check(`${label} ${note}: the boundary keys and bodies are in the model view`,
          boundary.every(item => turn.modelPreferences.get(item.preference_key) === item.instruction));
      }
    }
  },

  // Design S6: a 4th preference in the same scene. Claude's hook attachment
  // and Codex's command-hook context are both confirmed frames, so each
  // session receives the added item as one delta update (D-29.3).
  async add_fourth(world) {
    const { general, spacing, palette, radius } = world.fixture;
    const three = [...general, ...spacing, ...palette];
    for (const [client, label] of [['claude_code', 'H'], ['codex', 'C']]) {
      const session = await world.open(client, label);
      world.items = three;
      world.check(`${label} before: the model view is exactly ${keys(three)}`, holds(await session.turn(FRONTEND, { note: 'before' }), three));
      world.items = [...three, ...radius];
      const added = await session.turn(FRONTEND, { note: 'item added' });
      world.check(`${label} added: the model view is exactly ${keys(world.items)}`, holds(added, world.items));
      world.check(`${label} added: the hook sends only the added item (delta)`,
        added.preference_delivery === 'delta' && added.preferences_sent === radius.length);
    }
  },

  async edit_withdraw(world) {
    const { general, spacing, palette, editedSpacing, replacement } = world.fixture;
    world.items = [...general, ...spacing, ...palette];
    const { c, h } = await joined(world);
    await h.turn(FRONTEND, { note: 'H pointer entry' });
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    // The replaced message is the newest, so the Provider's window holds it.
    await talk(h, world, 'stays');
    const [original] = await talk(h, world, 'original');
    const journal = world.provider.boundTo('codex', c.sessionId).journal;
    const replaced = journal.events.find(event => event.content === original).sequence;
    await h.turn(FRONTEND, { note: 'H frontend' });
    await c.turn(FRONTEND, { note: 'C frontend' });
    const edited = [...general, ...editedSpacing, ...palette];
    world.items = edited;
    for (const session of [h, c]) {
      const turn = await session.turn(FRONTEND, { note: `${session.label} after a preference edit` });
      world.check(`${session.label} edit: the model view holds the edited body`, holds(turn, edited));
    }
    const kept = [...general, ...editedSpacing];
    world.items = kept;
    world.withdrawn = { preferences: palette.map(item => item.preference_key), messages: [original] };
    world.provider.boundTo('codex', c.sessionId).window = { override: { [replaced]: replacement } };
    const hWithdrawn = await h.turn(FRONTEND, { note: 'H after a preference withdraw and a message replacement' });
    const withdrawn = await c.turn(FRONTEND, { note: 'C after a preference withdraw and a message replacement' });
    world.check('withdraw: C is told the replaced message version is withdrawn', withdrawn.withdrawn_sequences.includes(replaced));
    for (const turn of [hWithdrawn, withdrawn, await h.turn(FRONTEND, { note: 'H settled' }),
      await c.turn(FRONTEND, { note: 'C settled' })]) {
      world.check(`${turn.session} ${turn.note}: the model view is exactly ${keys(kept)}`, holds(turn, kept));
    }
  },

  // Unchanged preferences for four turns: every later frame shows the same
  // revision as the complete one, and the delivery rules still name one set,
  // so the model never has to reread (dot rec#10 6365998098 item 2).
  async unchanged(world) {
    const { boundary, general, spacing, palette } = world.fixture;
    const items = [...boundary, ...general, ...spacing, ...palette];
    world.items = items;
    for (const [client, label] of [['claude_code', 'H'], ['codex', 'C']]) {
      const session = await world.open(client, label);
      const turns = [];
      for (const note of ['first', 'second', 'third', 'fourth']) turns.push(await session.turn(FRONTEND, { note }));
      world.check(`${label}: one complete frame, then deltas`, turns.map(turn => turn.preference_delivery).join() === 'full,delta,delta,delta');
      for (const turn of turns) {
        world.check(`${label} ${turn.note}: the model view is exactly ${keys(items)}, no reread`,
          holds(turn, items) && turn.rereads_required === 0);
      }
    }
  },

  async no_match_chat(world) {
    const { general, spacing } = world.fixture;
    world.items = [...general, ...spacing];
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

export const VARIANTS = Object.freeze(Object.keys(FIXTURES));

export const runScenario = (name, variant = 'tiny') =>
  replayWorld(SCENARIOS[name], { items: FIXTURES[variant].defaults, fixture: FIXTURES[variant] });
