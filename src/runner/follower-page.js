import { BAND_HEIGHT, BAND_STYLE, STATUS_PATH } from './follower-band.js';
import { localRuntimeLine, localSpaceLine } from './follower-local-runtime.js';
import { followerLine, keptLine, SAME_NETWORK_LIMIT } from './follower-status.js';
import { globalCopyLine, IMPORT_UNFINISHED } from './global-copy-state.js';

// A follower's own console page (docs/runner-roles-design.md §5): the page
// `127.0.0.1:<console port>` opens on a computer that follows another one. It
// is this computer's page, not the host's — who it follows, whether that
// computer answers, when it was last reached, what each capability runs on,
// and every record still waiting to be delivered, one by one, with 「现在重试」.
// The host's own console is one link away, over the paired channel.
//
// Plain HTML with one small script: this computer has no console build of its
// own, and this page must open while the host is away.
export const SYNC_PATH = '/__fuli-follower/sync';
export const ADDRESS_PATH = '/__fuli-follower/host-address';
export const PREPARE_PATH = '/__fuli-follower/prepare-local';
// Whose data a capability reads: the computer that owns the scope, this
// computer's own, or this computer's read-only copy of another's
// (docs/runner-roles-design.md §3; nothing is a copy until step 3c).
const WHERE = { host: { zh: '主机', en: 'the host' }, local: { zh: '本机', en: 'this computer' },
  replica: { zh: '本机只读副本', en: 'a read-only copy here' } };
const OFFLINE = {
  cached: { zh: '用这里缓存的上一次答复', en: 'the last answer kept here' },
  queued: { zh: '排队，主机回来后补交', en: 'queued, delivered when the host answers' },
  works: { zh: '照常可用', en: 'works as usual' },
  unavailable: { zh: '暂不可用', en: 'not available' }
};
const STATE = {
  queued: { zh: '等待送出', en: 'waiting' },
  failed: { zh: '主机拒绝', en: 'refused by the host' }
};

// requested: the host page this computer was asked for and cannot show now, so
// a receipt link opened while the host is away says what it was, instead of a
// blank page or an error stack.
export function followerConsolePage({ status, hostPath, requested = null }) {
  const line = followerLine(status);
  const host = status.host;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FULI · ${escape(host?.name ?? '本机')}</title>
<style>${BAND_STYLE}${PAGE_STYLE}</style></head>
<body${requested ? ' data-requested="1"' : ''}>
<div id="fuli-follower-band" role="status">
  <span class="dot ${host?.reachable ? 'on' : host ? 'off' : ''}"></span>
  <span data-line>${escape(line.zh)}</span><span class="gap"></span>
  <span class="mark" title="${escape(line.en)}">本页：本机</span>
</div>
<main>
  <h1>这台电脑 <span class="beta" title="测试中的功能 · In testing">Beta</span></h1>
  ${requested ? requestedPage(host, requested) : ''}
  ${host ? hostSection(host, hostPath) : notPaired()}
  ${host && status.localRuntime ? runtimeSection(status.localRuntime, status.globalCopy) : ''}
  ${host && Array.isArray(status.projects) ? projectsSection(status.projects) : ''}
  <h2>什么跑在哪里 <span class="en">Where each capability runs</span></h2>
  <table>
    <thead><tr><th>功能 <span class="en">Capability</span></th><th>在哪里 <span class="en">Runs on</span></th>
      <th>主机不在线时 <span class="en">While the host is away</span></th></tr></thead>
    <tbody>${status.capabilities.map(capabilityRow).join('')}</tbody>
  </table>
  <p class="note">${escape(SAME_NETWORK_LIMIT.zh)}<br><span class="en">${escape(SAME_NETWORK_LIMIT.en)}</span></p>
  ${status.cache ? `<p class="note">${escape(keptLine(status.cache).zh)}<br><span class="en">${escape(keptLine(status.cache).en)}</span></p>` : ''}
  <h2>还没送到主机的记录 <span class="en">Waiting for the host</span>
    <button type="button" data-retry>现在重试 / Retry now</button></h2>
  <p data-outcome class="note" hidden></p>
  <div data-outbox>${outbox(status.outbox)}</div>
</main>
<script type="module">${PAGE_SCRIPT}</script>
</body></html>`;
}

function requestedPage(host, requested) {
  const name = host?.name ?? '主机';
  return `<p class="asked"><b>${escape(name)}</b> 现在不在线，<code>${escape(requested)}</code> 是它的页面，打不开。
它回来后同一个链接就能打开；下面是这台电脑自己的状态。</p>
<p class="note en"><b>${escape(name)}</b> is away, so its page <code>${escape(requested)}</code> cannot be shown.
The same link opens once it answers. Below is this computer's own state.</p>`;
}

function hostSection(host, hostPath) {
  if (host.revokedAt) {
    return `<p class="lead">${escape(host.name)} 已撤销这台电脑（${escape(host.revokedAt)}）。这里保留的答复已删除，待送的记录还在。</p>
<p class="note en">${escape(host.name)} revoked this computer. What it had read is deleted; the records waiting here are kept.
Pair again with <code>fuli runner invite</code> there and <code>fuli runner join</code> here.</p>`;
  }
  const now = REACH[String(host.reachable)];
  return `<p class="lead">本机跟随 <b>${escape(host.name)}</b>，<span data-reach>${now.zh}</span>；上次连上 <span data-reached>${escape(host.lastSeenAt ?? host.answeredAt ?? '还没有')}</span>。</p>
<p class="note en">This computer follows <b>${escape(host.name)}</b>, <span data-reach-en>${now.en}</span>.</p>
<p><a class="open" href="${escape(hostPath)}">打开 ${escape(host.name)} 的控制台 · Open its console →</a></p>
${addAddress(host, { hidden: host.reachable !== false })}`;
}

// The one next step when the host does not answer: tell this computer where it
// is. The two computers reach each other directly (one LAN, or an address a VPN
// or mesh tool gives them), and on a network where mDNS does not cross subnets
// the address is the only thing missing. One button, then one field.
// Whether the host answers, as this page says it; null: not known yet, being looked for.
// How the page's own look for the host is retried before it says it was not found.
export const LOOK_EVERY_MS = 3000;
export const LOOK_TRIES = 10;

// silent: this computer's own console did not answer the page, so nothing is known of the host.
const REACH = {
  true: { zh: '现在在线', en: 'which answers now' },
  false: { zh: '现在不在线', en: 'which does not answer now' },
  null: { zh: '正在找主机…', en: 'looking for it now…' },
  silent: { zh: '不知道在不在线：本机控制台没有回答，请刷新页面', en: 'not known: this computer\'s console did not answer; reload the page' }
};

function addAddress(host, { hidden = false } = {}) {
  return `<div class="away-step" data-away-step${hidden ? ' hidden' : ''}>
  <p>连不上 ${escape(host.name)}？在那台电脑上运行 <code>fuli runner list</code>，把它显示的地址填到这里。</p>
  <p class="note en">If ${escape(host.name)} does not answer, run <code>fuli runner list</code> there and put the address it shows here.</p>
  <button type="button" data-address-open>添加主机地址 / Add the host's address</button>
  <form data-address-form hidden>
    <input name="address" inputmode="numeric" autocomplete="off" placeholder="10.0.0.20 / 100.64.0.20"
      aria-label="主机的局域网地址 / the host's private address">
    <button type="submit">保存并重试 / Save and try again</button>
  </form>
  <p data-address-outcome class="note" hidden></p>
</div>`;
}

// This computer's own runtime (step 3a): prepared in the background, nothing
// routed to it yet. A preparation that did not succeed or never ran offers the
// one next step, 「重新准备」, as a button; the same is `fuli start` in a terminal.
function runtimeSection(state, globalCopy) {
  const line = localRuntimeLine(state);
  const space = localSpaceLine(state);
  const copy = globalCopyLine(globalCopy);
  // Also when the runtime was started for the copy of global and its import did not finish
  // (global-copy-state.js IMPORT_UNFINISHED): not started for it again unless pressed.
  const again = state.state === 'failed' || state.state === 'not_prepared'
    || (globalCopy?.last?.reason === IMPORT_UNFINISHED && !globalCopy.running && globalCopy.last.again !== true);
  return `<h2>本机运行时 <span class="en">This computer's own runtime</span>
  ${again ? '<button type="button" data-prepare>重新准备 / Prepare again</button>' : ''}</h2>
<p data-runtime>${escape(line.zh)}</p>
<p class="note en" data-runtime-en>${escape(line.en)}</p>
${space ? `<p data-space>${escape(space.zh)}</p>
<p class="note en">${escape(space.en)}</p>` : ''}
${copy ? `<p data-global-copy>${escape(copy.zh)}</p>
<p class="note en">${escape(copy.en)}</p>` : ''}
${state.state === 'failed' && state.code !== 'disk_low' && state.message
    ? `<p class="note">${escape(state.message)}</p>` : ''}
<p data-prepare-outcome class="note" hidden></p>`;
}

// Which computer each project this computer knows of belongs to now.
function projectsSection(projects) {
  const body = projects.length ? `<table>
    <thead><tr><th>项目 <span class="en">Project</span></th><th>归哪台电脑 <span class="en">Belongs to</span></th></tr></thead>
    <tbody>${projects.map(projectRow).join('')}</tbody></table>`
    : '<p class="note">这台电脑还没进过任何项目的文件夹。 / No project folder has been worked in here yet.</p>';
  return `<h2>项目归哪台电脑 <span class="en">Which computer each project belongs to</span></h2>
${body}
<p class="note">新的项目文件夹按默认跟随主机。 / A new project folder follows the host, as new folders do.</p>`;
}

function projectRow(project) {
  const where = project.where === 'local' ? { zh: '本机', en: 'this computer', kind: 'local' }
    : project.where === 'host' ? { zh: `主机 ${project.ownerName}`, en: `the host ${project.ownerName}`, kind: 'host' }
      : { zh: '已不再配对的主机', en: 'a host no longer paired', kind: 'host' };
  return `<tr><td><code>${escape(project.id)}</code></td><td><span class="where ${where.kind}">${escape(where.zh)}</span>`
    + ` <span class="en">${escape(where.en)}${project.byDefault ? ' · 按默认 / as new folders go' : ''}</span></td></tr>`;
}

function notPaired() {
  return `<p class="lead">这台电脑还没有跟随任何主机，它就是自己的 FULI。</p>
<p class="note en">This computer follows no host. Pair it with <code>fuli runner join INVITATION</code>.</p>`;
}

function capabilityRow(capability) {
  const where = WHERE[capability.where] ?? WHERE.host;
  return `<tr><td>${escape(capability.zh)}<br><span class="en">${escape(capability.en)}</span></td>`
    + `<td><span class="where ${capability.where}">${where.zh}`
    + `${capability.syncedAt ? `（同步于 ${escape(capability.syncedAt)}）` : ''}</span></td>`
    + `<td>${escape(OFFLINE[capability.offline].zh)}<br><span class="en">${escape(OFFLINE[capability.offline].en)}</span></td></tr>`;
}

export function outbox({ entries = [], queued = 0, failedCount = 0 } = {}) {
  if (!entries.length) return '<p class="note">没有等待中的记录。 / Nothing is waiting.</p>';
  return `<p class="note">${queued} 条等待送出，${failedCount} 条被主机拒绝。 / ${queued} waiting, ${failedCount} refused.</p>`
    + '<table><thead><tr><th>类型 <span class="en">What</span></th><th>时间 <span class="en">Made</span></th>'
    + '<th>状态 <span class="en">State</span></th></tr></thead><tbody>'
    + entries.map((entry) => `<tr><td><code>${escape(entry.tool)}</code></td><td>${escape(entry.queuedAt)}</td>`
      + `<td><span class="state ${entry.state}">${STATE[entry.state]?.zh ?? escape(entry.state)}</span>`
      + `${entry.reason ? ` <span class="en">${escape(entry.reason)}</span>` : ''}</td></tr>`).join('')
    + '</tbody></table>';
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

const PAGE_STYLE = `
:root{--fuli-follower-band:${BAND_HEIGHT}px}
body{margin:0;padding:calc(var(--fuli-follower-band) + 28px) 20px 64px;color:#1f2328;background:#fff;
 font:14px/1.6 -apple-system,system-ui,"Helvetica Neue",sans-serif}
main{max-width:46rem;margin:0 auto}
h1{margin:0 0 4px;font-size:22px;font-weight:600}
h2{display:flex;align-items:baseline;gap:10px;margin:32px 0 8px;font-size:16px;font-weight:600}
.lead{margin:0 0 2px}
.asked{margin:12px 0 2px;padding:10px 12px;border-radius:8px;background:#fff7e6;color:#8a5a00}
.note{margin:2px 0;color:#6b7280;font-size:12px}
.en{color:#9ca3af;font-size:12px}
.beta{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font-size:11px;font-weight:600;
 line-height:18px;vertical-align:middle;color:#3b5bdb;background:#e8edff}
.open{display:inline-block;margin-top:10px;color:#2563eb;text-decoration:none}
.open:hover{text-decoration:underline}
table{width:100%;border-collapse:collapse;margin-top:6px}
th,td{padding:8px 10px 8px 0;text-align:left;vertical-align:top;border-bottom:1px solid #eceef1}
th{color:#6b7280;font-size:12px;font-weight:500}
.where{padding:1px 7px;border-radius:999px;font-size:12px;background:#eef2ff;color:#3b5bdb}
.where.local{background:#edf7ed;color:#2f7a35}
.where.replica{background:#f3f0ff;color:#5b4ba8}
.state{padding:1px 7px;border-radius:999px;font-size:12px;background:#f3f4f6;color:#4b5563}
.state.failed{background:#fdecec;color:#b42318}
button{margin-left:auto;padding:4px 10px;border:1px solid #d6d9de;border-radius:7px;background:#fff;
 color:inherit;font:inherit;font-size:12px;cursor:pointer}
button:hover{background:#f6f7f9}
code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.away-step{margin-top:14px;padding:12px 14px;border:1px solid #eceef1;border-radius:10px}
.away-step p{margin:0 0 6px}
.away-step button{margin:4px 0 0}
.away-step form{display:flex;gap:8px;align-items:center;margin-top:4px}
.away-step form[hidden],.away-step[hidden]{display:none}
.away-step input{flex:0 1 14rem;padding:5px 9px;border:1px solid #d6d9de;border-radius:7px;font:inherit;font-size:13px}
.away-step form button{margin:0}
@media (prefers-color-scheme:dark){body{color:#e6e8ea;background:#111315}.note{color:#8b9099}.en{color:#71767d}
 th,td{border-bottom-color:#26292e}th{color:#8b9099}button{border-color:#33363c;background:#1a1d20}
 button:hover{background:#22262a}.beta{color:#a5b8ff;background:#1f2a4d}.open{color:#7aa2ff}
 .where{background:#1f2a4d;color:#a5b8ff}.where.local{background:#1d2e20;color:#8fd49a}
 .where.replica{background:#272147;color:#c0b4f5}
 .state{background:#1f2225;color:#9ca3af}.state.failed{background:#3a1d1d;color:#f1a9a0}
 .asked{background:#2b2316;color:#e8c37a}
 .away-step{border-color:#26292e}.away-step input{border-color:#33363c;background:#1a1d20;color:inherit}}`;

// Asks for a delivery now and shows what came of it; the answer carries this
// computer's new state and the list of what still waits, rendered by the same
// code that rendered the page.
const PAGE_SCRIPT = [
  'const retry = document.querySelector("[data-retry]");',
  'const outcome = document.querySelector("[data-outcome]");',
  '',
  '// A failure in words, with the one thing to do: a command to copy when it has to run on another computer.',
  'function tell(where, body) {',
  '  where.hidden = false;',
  '  where.textContent = body.message ?? "没有成功。 / It did not work.";',
  '  if (!body.action?.command) return;',
  '  const hint = document.createElement("div");',
  '  hint.textContent = body.action.zh + " / " + body.action.en;',
  '  const copy = document.createElement("button");',
  '  copy.type = "button";',
  '  copy.textContent = "复制 " + body.action.command + " / Copy";',
  '  copy.addEventListener("click", () => navigator.clipboard?.writeText(body.action.command)',
  '    .then(() => { copy.textContent = "已复制 / Copied"; }).catch(() => {}));',
  '  where.append(hint, copy);',
  '}',
  'const NO_ANSWER = { message: "这台电脑的控制台没有回答，请刷新页面。 / This computer\'s console did not answer; reload the page." };',
  '',
  'retry.addEventListener("click", async () => {',
  '  retry.disabled = true;',
  '  outcome.hidden = false;',
  '  outcome.textContent = "正在送出… / Delivering…";',
  '  try {',
  `    const answer = await fetch(${JSON.stringify(SYNC_PATH)}, { method: "POST", headers: { "content-type": "application/json" } });`,
  '    const body = await answer.json();',
  '    if (!answer.ok) { tell(outcome, body); return; }',
  '    outcome.textContent = "送出 " + body.delivered + "，被拒 " + body.refused + "，还剩 " + body.queued',
  '      + "。 / delivered " + body.delivered + ", refused " + body.refused + ", " + body.queued + " left.";',
  '    document.querySelector("[data-outbox]").innerHTML = body.html;',
  '    document.querySelector("[data-line]").textContent = body.line.zh;',
  '  } catch {',
  '    tell(outcome, NO_ANSWER);',
  '  } finally {',
  '    retry.disabled = false;',
  '  }',
  '});',
  '',
  '// The one next step when the host does not answer: where it is.',
  'const open = document.querySelector("[data-address-open]");',
  'const form = document.querySelector("[data-address-form]");',
  'if (open && form) {',
  '  const result = document.querySelector("[data-address-outcome]");',
  '  open.addEventListener("click", () => { form.hidden = false; open.hidden = true; form.address.focus(); });',
  '  form.addEventListener("submit", async (event) => {',
  '    event.preventDefault();',
  '    result.hidden = false;',
  '    result.textContent = "正在找主机… / Looking for the host…";',
  '    try {',
  `      const answer = await fetch(${JSON.stringify(ADDRESS_PATH)}, { method: "POST",`,
  '        headers: { "content-type": "application/json" }, body: JSON.stringify({ address: form.address.value }) });',
  '      const body = await answer.json();',
  '      if (!answer.ok) { tell(result, body); return; }',
  '      if (body.reachable) { result.textContent = "找到了，正在刷新。 / Found it; reloading."; location.reload(); return; }',
  '      result.textContent = "这个地址还是没有回答：确认两台电脑在同一个局域网或同一个 VPN 里。"',
  '        + " / Still no answer there: check that both computers are on one LAN or VPN.";',
  '    } catch {',
  '      tell(result, NO_ANSWER);',
  '    }',
  '  });',
  '}',
  '',
  '// 「重新准备」: this computer\'s own runtime, prepared again in the background.',
  'const prepare = document.querySelector("[data-prepare]");',
  'if (prepare) {',
  '  const said = document.querySelector("[data-prepare-outcome]");',
  '  prepare.addEventListener("click", async () => {',
  '    prepare.disabled = true;',
  '    try {',
  `      const answer = await fetch(${JSON.stringify(PREPARE_PATH)}, { method: "POST", headers: { "content-type": "application/json" } });`,
  '      const body = await answer.json();',
  '      if (!answer.ok) { tell(said, body); prepare.disabled = false; return; }',
  '      document.querySelector("[data-runtime]").textContent = body.runtimeLine.zh;',
  '      document.querySelector("[data-runtime-en]").textContent = body.runtimeLine.en;',
  '      prepare.hidden = true;',
  '    } catch {',
  '      tell(said, NO_ANSWER);',
  '      prepare.disabled = false;',
  '    }',
  '  });',
  '}',
  '',
  '// Drawn before the host was looked for: ask now, and say what was found.',
  'const REACH = ' + JSON.stringify(REACH) + ';',
  '// Asked again every LOOK_EVERY_MS while nothing could be learned (this computer\'s console was busy or',
  '// restarting), at most LOOK_TRIES times; then the page says this computer\'s console did not answer.',
  '// Only an answer that says the host does not answer shows that, with the next step.',
  `const LOOK_EVERY_MS = ${LOOK_EVERY_MS};`,
  `const LOOK_TRIES = ${LOOK_TRIES};`,
  'function show(reachable, state) {',
  '  const now = REACH[reachable === "silent" ? "silent" : String(reachable)];',
  '  const values = [["[data-reach]", now.zh], ["[data-reach-en]", now.en]];',
  '  if (state?.line) values.push(["[data-line]", state.line.zh]);',
  '  const reached = state?.host?.lastSeenAt ?? state?.host?.answeredAt;',
  '  if (reached) values.push(["[data-reached]", reached]);',
  '  for (const [selector, value] of values) {',
  '    const element = document.querySelector(selector);',
  '    if (element) element.textContent = value;',
  '  }',
  '  const dot = document.querySelector("#fuli-follower-band .dot");',
  '  if (dot) dot.className = "dot " + (reachable === true ? "on" : reachable === false ? "off" : "");',
  '  const step = document.querySelector("[data-away-step]");',
  '  if (step) step.hidden = reachable !== false;',
  '}',
  'async function look(tries = 1) {',
  '  try {',
  `    const state = await (await fetch(${JSON.stringify(STATUS_PATH)})).json();`,
  '    if (!state.host) return;',
  '    if (typeof state.host.reachable === "boolean") { show(state.host.reachable, state); return; }',
  '  } catch { /* this computer\'s console is busy or restarting: asked again below */ }',
  '  // Nothing was learned of the host: said as that, never as the host being away.',
  '  if (tries >= LOOK_TRIES) { show("silent", null); return; }',
  '  setTimeout(() => void look(tries + 1), LOOK_EVERY_MS);',
  '}',
  'void look();',
  '',
  '// A host page shown while the host was away opens by itself once the host answers again.',
  'if (document.body.dataset.requested) {',
  '  setInterval(async () => {',
  `    try { if ((await (await fetch(${JSON.stringify(STATUS_PATH)})).json()).host?.reachable) location.reload(); }`,
  '    catch { /* this computer\'s console is restarting: the next look tries again */ }',
  '  }, 10000);',
  '}',
  ''
].join('\n');
