import { BAND_HEIGHT, BAND_STYLE } from './follower-band.js';
import { CAPABILITIES, followerLine, SAME_NETWORK_LIMIT } from './follower-status.js';

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
// Whose data a capability reads: the computer that owns the scope, this
// computer's own, or this computer's read-only copy of another's
// (docs/runner-roles-design.md §3; nothing is a copy until step 3).
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
<body>
<div id="fuli-follower-band" role="status">
  <span class="dot ${host?.reachable ? 'on' : host ? 'off' : ''}"></span>
  <span data-line>${escape(line.zh)}</span><span class="gap"></span>
  <span class="mark" title="${escape(line.en)}">本页：本机</span>
</div>
<main>
  <h1>这台电脑 <span class="beta" title="测试中的功能 · In testing">Beta</span></h1>
  ${requested ? requestedPage(host, requested) : ''}
  ${host ? hostSection(host, hostPath) : notPaired()}
  <h2>什么跑在哪里 <span class="en">Where each capability runs</span></h2>
  <table>
    <thead><tr><th>功能 <span class="en">Capability</span></th><th>在哪里 <span class="en">Runs on</span></th>
      <th>主机不在线时 <span class="en">While the host is away</span></th></tr></thead>
    <tbody>${status.capabilities.map(capabilityRow).join('')}</tbody>
  </table>
  <p class="note">${escape(SAME_NETWORK_LIMIT.zh)}<br><span class="en">${escape(SAME_NETWORK_LIMIT.en)}</span></p>
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
  return `<p class="lead">本机跟随 <b>${escape(host.name)}</b>，${host.reachable ? '现在在线' : '现在不在线'}；上次连上 ${escape(host.lastSeenAt ?? host.answeredAt ?? '还没有')}。</p>
<p class="note en">This computer follows <b>${escape(host.name)}</b>, ${host.reachable ? 'which answers now' : 'which does not answer now'}.</p>
<p><a class="open" href="${escape(hostPath)}">打开 ${escape(host.name)} 的控制台 · Open its console →</a></p>
${host.reachable === false ? addAddress(host) : ''}`;
}

// The one next step when the host does not answer: tell this computer where it
// is. The two computers reach each other directly (one LAN, or an address a VPN
// or mesh tool gives them), and on a network where mDNS does not cross subnets
// the address is the only thing missing. One button, then one field.
function addAddress(host) {
  return `<div class="away-step">
  <p>连不上 ${escape(host.name)}？在那台电脑上运行 <code>fuli runner list</code>，把它显示的地址填到这里。</p>
  <p class="note en">If ${escape(host.name)} does not answer, run <code>fuli runner list</code> there and put the address it shows here.</p>
  <button type="button" data-address-open>添加主机地址 / Add the host's address</button>
  <form data-address-form hidden>
    <input name="address" inputmode="numeric" autocomplete="off" placeholder="10.0.0.20"
      aria-label="主机的局域网地址 / the host's private address">
    <button type="submit">保存并重试 / Save and try again</button>
  </form>
  <p data-address-outcome class="note" hidden></p>
</div>`;
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
.away-step form[hidden]{display:none}
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
  'retry.addEventListener("click", async () => {',
  '  retry.disabled = true;',
  '  outcome.hidden = false;',
  '  outcome.textContent = "正在送出… / Delivering…";',
  '  try {',
  `    const answer = await fetch(${JSON.stringify(SYNC_PATH)}, { method: "POST", headers: { "content-type": "application/json" } });`,
  '    const body = await answer.json();',
  '    if (!answer.ok) throw new Error(body.error ?? answer.status);',
  '    outcome.textContent = "送出 " + body.delivered + "，被拒 " + body.refused + "，还剩 " + body.queued',
  '      + "。 / delivered " + body.delivered + ", refused " + body.refused + ", " + body.queued + " left.";',
  '    document.querySelector("[data-outbox]").innerHTML = body.html;',
  '    document.querySelector("[data-line]").textContent = body.line.zh;',
  '  } catch (error) {',
  '    outcome.textContent = "没送成：" + error.message + "。 / Not delivered: " + error.message + ".";',
  '  }',
  '  retry.disabled = false;',
  '});',
  '',
  '// The one next step when the host does not answer: where it is.',
  'const open = document.querySelector("[data-address-open]");',
  'const form = document.querySelector("[data-address-form]");',
  'if (open && form) {',
  '  const said = document.querySelector("[data-address-outcome]");',
  '  open.addEventListener("click", () => { form.hidden = false; open.hidden = true; form.address.focus(); });',
  '  form.addEventListener("submit", async (event) => {',
  '    event.preventDefault();',
  '    said.hidden = false;',
  '    said.textContent = "正在找主机… / Looking for the host…";',
  '    try {',
  `      const answer = await fetch(${JSON.stringify(ADDRESS_PATH)}, { method: "POST",`,
  '        headers: { "content-type": "application/json" }, body: JSON.stringify({ address: form.address.value }) });',
  '      const body = await answer.json();',
  '      if (!answer.ok) throw new Error(body.message ?? body.error ?? answer.status);',
  '      said.textContent = body.reachable ? "找到了，正在刷新。 / Found it; reloading." : "还是连不上这个地址。 / Still no answer there.";',
  '      if (body.reachable) location.reload();',
  '    } catch (error) {',
  '      said.textContent = "没能保存：" + error.message + " / Not saved: " + error.message;',
  '    }',
  '  });',
  '}',
  ''
].join('\n');
