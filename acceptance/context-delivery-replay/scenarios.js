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
// Host notifications as Claude Code receives them (rec#76): a CI event whose
// text names its own tag in prose, and a finished background task.
const ciEvent = n => `<ci-monitor-event>Synthetic PR ${n}: check "unit" failed on the latest push. `
  + 'The app sends each change as a <ci-monitor-event> message.</ci-monitor-event>';
const taskDone = n => `<task-notification><task-id>synthetic-${n}</task-id><status>completed</status></task-notification>`;
// The turn that adds a preference while the frame before is on its way: it
// spells out none (design T3), so a bounded one may miss it that one turn.
export const ADDED_IN_FLIGHT = 'added while the frame before is on its way';
const NOTIFICATIONS = Array.from({ length: 10 }, (_, i) => (i % 3 === 2 ? taskDone(i) : ciEvent(i)));

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
// A full frame (a new generation) sent exactly the window one full frame holds
// under the host's inline limit: the uncached entry through the same bounded
// hook. Where the limit leaves the oldest out, the next turn pays them
// (sentRest).
const sentWholeWindow = turn => sentExactly(turn, turn.frameWindowMessages);
// The turn after a full frame sent exactly the window messages that frame left
// out, and nothing when it left none.
function sentRest(turn, full) {
  const rest = turn.windowMessages.filter(text => !full.sentMessages.includes(text));
  return rest.length ? sentExactly(turn, rest) : turn.sentMessages.length === 0;
}

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
    await talk(c, world, 'xxx');
    await c.turn(WORK, { note: 'C turn 2, own xxx' });
    await talk(c, world, 'yyy');
    const s1 = await c.turn(WORK, { note: 'S1 C turn 3, own xxx/yyy' });
    world.check('S1: C is sent neither xxx nor yyy', s1.messages_sent === 0);
    const h = await world.open('claude_code', 'H');
    const pointer = await h.turn(WORK, { note: 'S2 H turn 1, pointer only' });
    world.check('S2: the new session gets a pointer and no messages', pointer.pointer_bytes !== null && pointer.messages_sent === 0);
    await h.resume(world.provider.boundTo('codex', c.sessionId).id);
    const resumed = await h.turn(WORK, { note: 'S2 H turn 2, after resume' });
    world.check('S2: after the visible resume H holds the window without a resend', resumed.messages_sent === 0 && resumed.correctness.ok);
    const zzz = await talk(h, world, 'zzz');
    await h.turn(WORK, { note: 'S2 H turn 3, own zzz' });
    const back = await c.turn(WORK, { note: 'S3 C turn 4, back in C' });
    world.check('S3: back in C only zzz is sent', sentExactly(back, zzz));
    await c.turn(WORK, { note: 'S3 C turn 5, settled' });
  },

  async explicit_resume(world) {
    const c = await world.open('codex', 'C');
    await c.turn(WORK, { note: 'source entry' });
    await talk(c, world, 'xxx');
    const id = world.provider.boundTo('codex', c.sessionId).id;
    for (const client of ['claude_code', 'codex']) {
      for (const mode of ['complete', 'lost', 'preview']) {
        const h = await world.open(client, `${client}-${mode}`);
        await h.turn(WORK, { note: `${mode} pointer entry` });
        await h.resume(id, { record: mode !== 'lost', preview: mode === 'preview' });
        const after = await h.turn(WORK, { note: `${mode} after explicit resume` });
        world.check(`${client} ${mode}: correct model view`, after.correctness.ok);
        world.check(`${client} ${mode}: omit only a complete visible result`, mode === 'complete'
          ? after.messages_sent === 0 : sentWholeWindow(after));
        await h.compact();
        const reset = await h.turn(WORK, { note: `${mode} after compaction` });
        world.check(`${client} ${mode}: compaction restores the window`, sentWholeWindow(reset));
        const settled = await h.turn(WORK, { note: `${mode} settled` });
        world.check(`${client} ${mode}: the settled generation resends no messages`, settled.messages_sent === 0);
      }
    }
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
    const settled = await c.turn(WORK, { note: 'C after compaction, settled' });
    world.check('compact: the next turn sends exactly what that frame left out', sentRest(settled, after));
    await c.sessionStart('resume');
    const codexResumed = await c.turn(WORK, { note: 'C after SessionStart resume' });
    world.check('Codex resume: the new generation receives the window again', sentWholeWindow(codexResumed));
    await h.turn(WORK, { note: 'H before resume' });
    // Claude Code replays the same transcript on resume (rec#11 D-69).
    await h.sessionStart('resume');
    const resumed = await h.turn(WORK, { note: 'H after SessionStart resume' });
    world.check('Claude Code resume: the replayed generation keeps its base and resends nothing seen',
      resumed.preference_delivery === 'delta' && resumed.messages_sent === 0 && resumed.resent_seen_items === 0);
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
    world.check('failure: H receives the lost messages, with a whole window when tiny omission metadata costs more',
      sentExactly(again, fromC) || sentWholeWindow(again));
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

  // Design T3: a preference the person adds while the frame before is still
  // on its way. That turn spells out no more (its base may be lost); the new
  // one is owed and arrives on the next turn, and stays.
  async added_in_flight(world) {
    const { boundary, general, spacing, palette, radius } = world.fixture;
    const before = [...boundary, ...general, ...spacing, ...palette];
    for (const [client, label] of [['claude_code', 'H'], ['codex', 'C']]) {
      const session = await world.open(client, label);
      world.items = before;
      await session.turn(FRONTEND, { note: 'first' });
      await session.turn(FRONTEND, { record: false, note: 'on its way' });
      // Sixth of the scene's own: past the preferences' floor, which every
      // turn spells out, and within what one complete frame of `many` holds.
      world.items = [...boundary, ...general, ...spacing.slice(0, 5), ...radius, ...spacing.slice(5), ...palette];
      await session.turn(FRONTEND, { note: ADDED_IN_FLIGHT });
      await session.say('assistant', 'SYNTHETIC reply.');
      for (const note of ['next', 'settled']) {
        const turn = await session.turn(FRONTEND, { note });
        world.check(`${label} ${note}: the added body is in the model view`,
          radius.every(item => turn.modelPreferences.get(item.preference_key) === item.instruction));
      }
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

  // rec#76, design T1: ten host notifications after one task entry. The
  // next human entry must still resolve its original base.
  async notifications(world) {
    world.recall = true;
    const { general, spacing } = world.fixture;
    world.items = [...general, ...spacing];
    const h = await world.open('claude_code', 'H');
    await talk(h, world, 'xxx');
    const entry = await h.turn(WORK, { note: 'new task' });
    world.check('the task entry carries the whole skeleton', entry.skeleton_delivery === 'full');
    const turns = [];
    for (const [index, prompt] of NOTIFICATIONS.entries()) turns.push(await h.turn(prompt, { note: `notification ${index + 1}` }));
    world.check('notifications deliver nothing and read nothing', turns.every(turn => turn.preference_delivery === 'silent'
      && turn.skeleton_delivery === 'none' && turn.produced_bytes === 0 && turn.retrieval_calls === 0));
    const next = await h.turn(WORK, { note: 'next human entry' });
    world.check('the next human entry keeps its preference base', next.preference_delivery === 'delta' && next.correctness.ok);
  },

  // rec#76: the same prompt ten times (a scheduled prompt). Each is a new task
  // with the same skeleton as the one it repeats.
  async repeated_prompt(world) {
    world.recall = true;
    const { general, spacing } = world.fixture;
    world.items = [...general, ...spacing];
    const h = await world.open('claude_code', 'H');
    const entry = await h.turn(WORK, { note: 'first' });
    const turns = [];
    for (let index = 1; index <= 10; index++) turns.push(await h.turn(WORK, { note: `repeat ${index}` }));
    world.check('the first prompt carries the whole skeleton', entry.skeleton_delivery === 'full');
    world.check('every repeat names the skeleton it already showed', turns.every(turn => turn.skeleton_delivery === 'unchanged'));
  },

  // rec#76: what must still get the whole skeleton in one session:
  // another project, another FLA and the first turn after compaction.
  async skeleton_boundaries(world) {
    world.recall = true;
    const { general } = world.fixture;
    world.items = general;
    const h = await world.open('claude_code', 'H');
    await h.turn(WORK, { note: 'first' });
    const full = turn => turn.skeleton_delivery === 'full' && turn.skeleton_revision_field_bytes > 0;
    // rec#88: a new prompt of the same owner names what the session already shows.
    world.check('a new task of the same owner names the skeleton', (await h.turn(FRONTEND, { note: 'new task' })).skeleton_delivery === 'unchanged');
    world.check('a notification of that task stays silent', (await h.turn(ciEvent(1), { note: 'notification' })).skeleton_delivery === 'none');
    world.check('another project gets the whole skeleton', full(await h.turn(FRONTEND, { note: 'project switch', project: 'other' })));
    world.check('another FLA gets the whole skeleton', full(await h.turn(`#FLA reviewer ${FRONTEND}`, { note: 'FLA switch' })));
    await h.compact();
    world.check('a notification after compaction cannot establish a new base',
      (await h.turn(ciEvent(2), { note: 'notification after compaction' })).produced_bytes === 0);
    world.check('the first human prompt after compaction gets the whole skeleton', full(await h.turn(WORK, { note: 'after compaction' })));
    world.check('the next notification is silent', (await h.turn(ciEvent(3), { note: 'notification' }))
      .skeleton_delivery === 'none');
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
// `many` has more preferences than a host's inline limit can hold, so its
// entries deliberately leave some out: the oracle above, which asks the model
// to hold every one of them, cannot hold there. It is a cost measurement, and
// the pass/fail gate skips it (run.js); what it must still show is that no
// frame is unlocatable and nothing withdrawn is present.
export const BOUNDED_VARIANTS = Object.freeze(['many']);

export const runScenario = (name, variant = 'tiny') =>
  replayWorld(SCENARIOS[name], { items: FIXTURES[variant].defaults, fixture: FIXTURES[variant] });
