import { failure, isTaskEntry, resultValue, withRunnerNote } from './offline-calls.js';

// How a follower says an answer of a project it owns was given here
// (docs/runner-roles-design.md §12): beside a task entry, which computer
// answered, where the habits and roster it read came from (this computer's
// copy of the host's global, and when it was synced), how many writes to
// global wait to go to the host, and a recruitment waiting for the host to
// make its FLA; beside a checkpoint, what was saved here and what became of
// its writes to global. In the same place, under the same name, as the note
// beside a host's answer (offline-calls.js hostAnsweredNote). Both languages.
//
// Two refusals of this computer's own FULI are said as what they mean on a
// follower: a tool this version does not have (the host is newer), and the
// first copy of global not arrived yet.
const OLD_COPY_MINUTES = 60;
const CHECKPOINT_TOOL = 'checkpoint_task_knowledge';

// The code of an error answer: FULI's own (error.code) or a runner's ({ code }), else null.
export function answerCode(answer) {
  if (!answer?.isError) return null;
  const value = resultValue(answer);
  const code = value?.error?.code ?? value?.code;
  if (typeof code === 'string') return code;
  return /^([a-z][a-z0-9_]{1,79}):/.exec(answer.content?.find((item) => item.type === 'text')?.text ?? '')?.[1] ?? null;
}

// tool: the tool the call ran; facts: { hostName, syncedAt, queuedForHost, held ('host_too_old' |
// 'host_keeps_failing' | null: why writes wait here, global-writes-outbox.js heldBecause),
// recruitment: { queued, refused: [code] } | null, hostOnline, now }. The codes stay in the
// structured fields; the message says them in words.
export function localAnswer(tool, answer, facts) {
  const code = answerCode(answer);
  // This computer's FULI does not know the tool the host listed (the host runs a newer FULI).
  if (code === 'not_found' && /Unknown Fuli tool/.test(JSON.stringify(answer.content ?? ''))) {
    return failure('tool_unknown_here', `FULI on this computer is older than on ${facts.hostName}: ${tool} is not in it yet, `
      + 'and this project is answered here. Update FULI on this computer (`fuli update`).\n'
      + `这台电脑的 FULI 比 ${facts.hostName} 旧，这个工具在这里还没有；这个项目在这台电脑上回答。更新这台电脑（\`fuli update\`）。`);
  }
  if (code === 'global_not_synced') {
    return failure('global_not_synced', `This computer is waiting for its first copy of global (your habits and the FLA `
      + `roster) from ${facts.hostName}; it arrives by itself once the two computers are connected. Nothing is wrong and `
      + 'nothing was written.\n'
      + `这台电脑在等 ${facts.hostName} 的第一份全局副本（你的习惯和 FLA 名册），两台电脑连上后会自动到；没出错，什么都没写。`);
  }
  if (isTaskEntry(tool)) return withRunnerNote(answer, entryNote(facts));
  if (tool === CHECKPOINT_TOOL) {
    const value = resultValue(answer);
    if (value?.for_host) return withRunnerNote(answer, checkpointNote(value, facts));
  }
  return answer;
}

function entryNote({ hostName, syncedAt, queuedForHost, held = null, recruitment, hostOnline, now = Date.now }) {
  const ageMinutes = syncedAt ? Math.max(0, Math.round((now() - Date.parse(syncedAt)) / 60_000)) : null;
  const when = syncedAt ? whenSaid(syncedAt, now()) : null;
  const parts = [{ en: 'This project is on this computer, which answered this entry.', zh: '这个项目在这台电脑上，由这台电脑回答。' },
    when
      ? { en: `Your habits and the FLA roster come from this computer's copy of ${hostName}'s, synced ${when.en} (${ageMinutes} minutes ago).`,
        zh: `全局习惯和 FLA 名册来自 ${hostName} 的副本，同步于${when.zh}（${ageMinutes} 分钟前）。` }
      : { en: `This computer has no copy of ${hostName}'s habits and FLA roster yet.`, zh: `这台电脑还没有 ${hostName} 的全局副本。` }];
  if (ageMinutes !== null && ageMinutes > OLD_COPY_MINUTES) {
    parts.push({ en: `The copy is older; it is brought up to date once ${hostName} answers.`, zh: `副本较旧，${hostName} 连上后会自动更新。` });
  }
  if (queuedForHost) parts.push(queuedLine(queuedForHost, { hostName, held }));
  if (recruitment) parts.push(recruitmentLine(recruitment, { hostName, hostOnline }));
  return { answeredBy: 'this_computer',
    global: { from: 'host_copy', host: hostName, syncedAt: syncedAt ?? null, ageMinutes },
    queuedForHost, ...(held ? { held } : {}), ...(recruitment ? { recruitment } : {}), message: joined(parts) };
}

function checkpointNote(value, { hostName, held = null }) {
  const { delivered, queued, refused } = value.for_host;
  const parts = [{ en: `Saved here: ${value.saved_here ?? 0}.`, zh: `本机记下 ${value.saved_here ?? 0} 条。` }];
  if (delivered) parts.push({ en: `${delivered} writes to global went to ${hostName}, which applied them.`, zh: `${delivered} 条属于全局，已交给 ${hostName}。` });
  if (queued) parts.push(queuedLine(queued, { hostName, held }));
  if (refused.length) {
    const what = refused.map(({ kind, code }) => {
      const reason = reasonWords(code);
      return { en: `${KIND_WORDS[kind]?.en ?? 'a write'} (${reason.en})`, zh: `${KIND_WORDS[kind]?.zh ?? '一条写入'}（${reason.zh}）` };
    });
    parts.push({ en: `${hostName} did not take ${refused.length}: ${what.map(({ en }) => en).join(', ')}; they are listed on the `
      + '「本机」 (this computer) page of this computer\'s console.',
    zh: `${hostName} 没收 ${refused.length} 条：${what.map(({ zh }) => zh).join('、')}；在这台电脑控制台的「本机」页列着。` });
  }
  return { answeredBy: 'this_computer', savedHere: value.saved_here ?? 0, forHost: value.for_host, message: joined(parts) };
}

function queuedLine(count, { hostName, held }) {
  if (held === 'host_too_old') {
    return { en: `${count} writes to global wait here: FULI on ${hostName} is too old to take them, so they are kept and sent `
      + `by themselves once ${hostName} is updated and connects again.`,
    zh: `${count} 条全局写入暂存在这台电脑：${hostName} 的 FULI 版本旧，收不了；${hostName} 更新后再连上时自动送。` };
  }
  if (held === 'host_keeps_failing') {
    return { en: `${count} writes to global wait here: ${hostName} kept failing on its side when they were sent, so they are `
      + 'kept and tried again the next time the two computers connect.',
    zh: `${count} 条全局写入暂存在这台电脑：${hostName} 那边一直出错，下次连上会再试。` };
  }
  return { en: `${count} writes to global wait to go to ${hostName}; they are sent by themselves once it answers.`,
    zh: `${count} 条全局写入在排队，${hostName} 连上后自动送。` };
}

function recruitmentLine({ queued, refused }, { hostName, hostOnline }) {
  if (refused.length) {
    const reasons = refused.map(reasonWords);
    return { en: `${hostName} did not make the FLA this project asked for (${reasons.map(({ en }) => en).join(', ')}); cancel that `
      + 'recruitment on the project page and recruit again.',
    zh: `${hostName} 没建成这个项目要的 FLA（${reasons.map(({ zh }) => zh).join('、')}）；在项目页取消这次招聘再招一次。` };
  }
  if (!queued) return { en: 'A recruitment of this project is under way.', zh: '这个项目有一次招聘在进行。' };
  return hostOnline
    ? { en: `This project has no lead yet; ${hostName} was asked to make one (recruited from this computer's project), usually `
      + 'within a minute or two. No FLA is assigned this round.',
    zh: `这个项目还没有负责人，已请 ${hostName} 建一位（招聘来自这台电脑的项目），通常一两分钟内到岗；这一轮先不分配 FLA。` }
    : { en: `This project has no lead yet; ${hostName} is away, so the recruitment waits and finishes by itself once it answers.`,
      zh: `这个项目还没有负责人；${hostName} 不在线，招聘排着队，连上后自动完成。` };
}

// What each kind of write to global is, as people say it.
const KIND_WORDS = Object.freeze({
  capture: { en: 'a habit or note', zh: '一条习惯或知识' },
  agent_memory: { en: 'an FLA\'s memory', zh: '一段 FLA 记忆' },
  knowledge_usage: { en: 'which kept items were used', zh: '用过哪些条目的记录' },
  recruit: { en: 'a hire', zh: '一次招人' }
});

// Why the host did not take a write, in words; the code itself stays in the structured answer.
const REASON_WORDS = Object.freeze({
  capture_disabled: { en: 'keeping such things is turned off there', zh: '那边关了这类记录' },
  entry_too_large: { en: 'too large to send', zh: '太大，送不过去' },
  payload_too_large: { en: 'too large to send', zh: '太大，送不过去' },
  agent_name_taken: { en: 'that name is taken there', zh: '那边已有同名的 FLA' },
  agent_id_taken: { en: 'another FLA there has that id', zh: '那边另一位 FLA 用了这个 ID' },
  invalid_input: { en: 'it could not read it', zh: '那边读不了这条内容' }
});

function reasonWords(code) {
  return REASON_WORDS[code] ?? { en: 'the host said why', zh: '原因见列表' };
}

// When something happened, in this computer's local time: today 14:05, yesterday 22:10, Nov 20 14:05.
function whenSaid(iso, nowMs = Date.now()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { en: String(iso), zh: String(iso) };
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((day(new Date(nowMs)) - day(at)) / 86_400_000);
  if (daysAgo === 0) return { en: `today ${time}`, zh: `今天 ${time}` };
  if (daysAgo === 1) return { en: `yesterday ${time}`, zh: `昨天 ${time}` };
  const month = at.toLocaleString('en-US', { month: 'short' });
  return { en: `${month} ${at.getDate()} ${time}`, zh: `${at.getMonth() + 1}月${at.getDate()}日 ${time}` };
}

function joined(parts) {
  return `${parts.map(({ en }) => en).join(' ')}\n${parts.map(({ zh }) => zh).join('')}`;
}
