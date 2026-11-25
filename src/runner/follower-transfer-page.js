// This page remains usable while the paired host is asleep.
export const transferForm = `<details data-transfer><summary>跟随与搬移项目 / Follow and move projects</summary>
<form data-follow><label>跟随范围 / Scope <input name="scope" required placeholder="project:id / global" maxlength="136"></label>
<button>请求跟随 / Request access</button></form>
<form data-move><label>项目 / Project <input name="project" required maxlength="128"></label>
<label>目标 / Destination <select name="target"><option value="here">这台电脑 / This computer</option><option value="host">主机 / Host</option></select></label>
<label>搬移说明 / Reason <input name="reason" maxlength="2000"></label>
<button value="start">开始搬移 / Start transfer</button>
<label>搬移编号 / Transfer ID <input name="moveId" maxlength="128"></label>
<button value="status">查进度 / Check progress</button><button value="cancel">撤回 / Cancel</button></form>
<p data-transfer-result role="status"></p></details>`;

export const transferScript = `
const transfer = document.querySelector('[data-transfer]');
if (transfer) {
  const output = transfer.querySelector('[data-transfer-result]');
  const states = {
    requested:'已提交 / Requested', preparing:'正在检查 / Checking', inspected:'两端已核对 / Both checked',
    target_frozen:'目标写入已暂停 / Target frozen', frozen:'两端写入已暂停 / Both frozen',
    graph:'正在传输图记录 / Transferring graph', board:'正在传输看板 / Transferring board', received:'已接收 / Received',
    verified:'内容已核对 / Verified', committed:'已确认新所有者 / Ownership committed', activated:'新所有者已启用 / New owner active',
    forwarded:'旧端已转发 / Old owner forwarding', done:'已完成 / Complete', aborted:'已撤回 / Cancelled',
    allowed:'已允许 / Allowed', pending:'等待主机批准 / Awaiting host approval', revoked:'已撤销 / Revoked',
    owner_offline:'主机离线 / Host offline', owner_result_unknown:'送达结果待核实 / Delivery unconfirmed',
    move_not_permitted:'请在拥有项目的电脑确认搬移 / Request the transfer on the owning computer',
    move_already_committed:'所有者已变更，可在完成后反向搬移 / Ownership has changed; wait for completion to move it back',
    move_changed:'同一搬移编号已有其他请求 / This transfer ID already belongs to another request',
    move_unavailable:'搬移暂不可用 / Transfer unavailable'
  };
  let pending = false;
  transfer.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const form = event.target;
    const action = form.hasAttribute('data-follow') ? 'follow' : event.submitter?.value || 'start';
    const input = Object.fromEntries(new FormData(form));
    if (action === 'start') {
      if (!input.reason.trim()) { form.elements.reason.focus(); return; }
      input.moveId ||= crypto.randomUUID();
      form.elements.moveId.value = input.moveId;
    } else if (action !== 'follow' && !input.moveId) { form.elements.moveId.focus(); return; }
    pending = true;
    output.textContent = '正在联系主机 / Contacting host…';
    try {
      const answer = await fetch('/__fuli-follower/project-transfer', { method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({ ...input, action }) });
      const row = await answer.json();
      const code = row.code || row.error || row.step || row.state || (answer.ok ? 'pending' : 'move_unavailable');
      output.textContent = [states[code] || code, row.reason && (states[row.reason] || row.reason)].filter(Boolean).join(' · ');
    } catch { output.textContent = states.owner_result_unknown; }
    finally { pending = false; }
  });
}`;
