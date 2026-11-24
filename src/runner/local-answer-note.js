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

// tool: the tool the call ran; facts: { hostName, syncedAt, queuedForHost, heldForOldHost,
// recruitment: { queued, refused: [code] } | null, hostOnline, now }.
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

function entryNote({ hostName, syncedAt, queuedForHost, heldForOldHost, recruitment, hostOnline, now = Date.now }) {
  const ageMinutes = syncedAt ? Math.max(0, Math.round((now() - Date.parse(syncedAt)) / 60_000)) : null;
  const parts = [{ en: 'This project is on this computer, which answered this entry.', zh: '这个项目在这台电脑上，由这台电脑回答。' },
    syncedAt
      ? { en: `Your habits and the FLA roster come from this computer's copy of ${hostName}'s, synced ${syncedAt} (${ageMinutes} minutes ago).`,
        zh: `全局习惯和 FLA 名册来自 ${hostName} 的副本，同步于 ${syncedAt}（${ageMinutes} 分钟前）。` }
      : { en: `This computer has no copy of ${hostName}'s habits and FLA roster yet.`, zh: `这台电脑还没有 ${hostName} 的全局副本。` }];
  if (ageMinutes !== null && ageMinutes > OLD_COPY_MINUTES) {
    parts.push({ en: `The copy is older; it is brought up to date once ${hostName} answers.`, zh: `副本较旧，${hostName} 连上后会自动更新。` });
  }
  if (queuedForHost) parts.push(queuedLine(queuedForHost, { hostName, heldForOldHost }));
  if (recruitment) parts.push(recruitmentLine(recruitment, { hostName, hostOnline }));
  return { answeredBy: 'this_computer',
    global: { from: 'host_copy', host: hostName, syncedAt: syncedAt ?? null, ageMinutes },
    queuedForHost, ...(recruitment ? { recruitment } : {}), message: joined(parts) };
}

function checkpointNote(value, { hostName, heldForOldHost }) {
  const { delivered, queued, refused } = value.for_host;
  const parts = [{ en: `Saved here: ${value.saved_here ?? 0}.`, zh: `本机记下 ${value.saved_here ?? 0} 条。` }];
  if (delivered) parts.push({ en: `${delivered} of global went to ${hostName}, which applied them.`, zh: `${delivered} 条属于全局，已交给 ${hostName}。` });
  if (queued) parts.push(queuedLine(queued, { hostName, heldForOldHost }));
  if (refused.length) {
    const codes = refused.map(({ kind, code }) => `${kind} ${code}`).join(', ');
    parts.push({ en: `${hostName} refused ${refused.length} (${codes}); they are listed on this computer's /local page.`,
      zh: `${hostName} 拒绝了 ${refused.length} 条（${codes}），在这台电脑的 /local 页列着。` });
  }
  return { answeredBy: 'this_computer', savedHere: value.saved_here ?? 0, forHost: value.for_host, message: joined(parts) };
}

function queuedLine(count, { hostName, heldForOldHost }) {
  return heldForOldHost
    ? { en: `${count} of global wait here: FULI on ${hostName} is too old to take them, so they are kept until it is updated.`,
      zh: `${count} 条全局写入暂存在这台电脑：${hostName} 的 FULI 版本旧，收不了，更新后自动送。` }
    : { en: `${count} of global wait to go to ${hostName}; they are sent by themselves once it answers.`,
      zh: `${count} 条全局写入在排队，${hostName} 连上后自动送。` };
}

function recruitmentLine({ queued, refused }, { hostName, hostOnline }) {
  if (refused.length) {
    return { en: `${hostName} did not make the FLA this project asked for (${refused.join(', ')}); cancel that recruitment on the `
      + 'project page and recruit again.', zh: `${hostName} 没建成这个项目要的 FLA（${refused.join('、')}）；在项目页取消这次招聘再招一次。` };
  }
  if (!queued) return { en: 'A recruitment of this project is under way.', zh: '这个项目有一次招聘在进行。' };
  return hostOnline
    ? { en: `This project has no lead yet; ${hostName} was asked to make one (recruited from this computer's project), usually `
      + 'within a minute or two. No FLA is assigned this round.',
    zh: `这个项目还没有负责人，已请 ${hostName} 建一位（招聘来自这台电脑的项目），通常一两分钟内到岗；这一轮先不分配 FLA。` }
    : { en: `This project has no lead yet; ${hostName} is away, so the recruitment waits and finishes by itself once it answers.`,
      zh: `这个项目还没有负责人；${hostName} 不在线，招聘排着队，连上后自动完成。` };
}

function joined(parts) {
  return `${parts.map(({ en }) => en).join(' ')}\n${parts.map(({ zh }) => zh).join('')}`;
}
