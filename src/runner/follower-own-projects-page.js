import { FOLLOWER_FORMAT_PATH, FOLLOWER_GRAPH_PATH } from './follower-maintenance-paths.js';

// The part of a follower's own page (follower-page.js) about the projects this
// computer owns (docs/runner-roles-design.md §11 3b/3c): 「放在这台电脑」 for a
// new project, the projects kept here, and, once there is one, this computer's
// own graph backups and data format updates. Words people use; no command to
// type and no internal code. The script below asks this computer's console for
// what changes (follower-console.js, follower-graph-backup.js).
export const MAKE_LOCAL_PATH = '/__fuli-follower/make-local';

// Whether the page shows this computer's own projects: its script then asks for their backups and lists.
export function showsOwnProjects(keep) {
  return Boolean(keep?.localProjects?.length);
}

// keep: { refusal: { code, message } | null, folders: [path], localProjects: [{ id, scope, folder }] }
// (make-project-local.js keepProjectChoices); hostName: the host's name.
export function ownProjectsSections(keep, hostName) {
  if (!keep) return '';
  return `${keepSection(keep, hostName)}${showsOwnProjects(keep) ? maintenanceSection() : ''}`;
}

function keepSection({ refusal, folders, localProjects }, hostName) {
  const host = escape(hostName);
  // Each project, and which computer it belongs to, is listed above (follower-page.js projectsSection).
  const list = localProjects.length ? `  <p class="note">这些项目由这台电脑回答，${host} 不在线时照常可用；写给全局的内容（习惯、FLA 名册）仍送到 ${host}。</p>
  <p class="note en">These are answered by this computer, also while ${host} is away; what they write to global (habits, the FLA roster) still goes to ${host}.</p>
  <p class="note" data-project-lists hidden></p>` : '';
  return `<h2 id="keep-here">放在这台电脑 <span class="en">Projects kept on this computer</span></h2>
${list}
${refusal ? refusalNote(refusal) : choices(folders, hostName)}`;
}

// Why no project can be kept here now, as make-project-local.js says it (English, then Chinese).
function refusalNote(refusal) {
  const [en, zh] = String(refusal.message).split('\n');
  return `<p class="note">${escape(zh ?? en)}</p>${zh ? `<p class="note en">${escape(en)}</p>` : ''}`;
}

function choices(folders, hostName) {
  const host = escape(hostName);
  const recent = folders.length ? `<p>最近在这台电脑上用过、${host} 上还没有项目的文件夹：</p>
  <p class="note en">Folders worked in here that ${host} has no project for:</p>
  <ul class="folders">${folders.map((folder) => `<li><code>${escape(folder)}</code>
    <button type="button" data-keep-folder="${escape(folder)}" aria-label="把 ${escape(folder)} 放在这台电脑 / Keep ${escape(folder)} on this computer">放在这台电脑 / Keep here</button></li>`).join('')}</ul>` : '';
  return `<p class="note">新项目放在这台电脑后，由这台电脑回答。只限 ${host} 上还没有的项目，两台电脑要连着。</p>
<p class="note en">A new project kept here is answered by this computer. Only for a project ${host} does not have, while both computers are connected.</p>
${recent}
<form data-keep-form class="keep-form">
  <label>文件夹的完整路径 <span class="en">The folder's full path</span>
    <input name="projectPath" autocomplete="off" required></label>
  <label>项目 ID（可不填，默认用文件夹名） <span class="en">Project id (optional; the folder's name)</span>
    <input name="projectId" autocomplete="off"></label>
  <button type="submit">放在这台电脑 / Keep on this computer</button>
</form>
<p data-keep-outcome class="note" role="status" aria-live="polite" hidden></p>`;
}

// Filled in by the script: what this computer's console answers for its own graph.
function maintenanceSection() {
  return `<h2>这台电脑的图谱备份 <span class="en">Backups of this computer's graph</span>
  <button type="button" data-backup>备份 / Back up now</button></h2>
<p class="note">备份只含这台电脑的图谱，只能恢复到这台电脑。恢复前会先自动再备份一次现在的图谱。</p>
<p class="note en">A backup holds this computer's graph only, and is restored only to this computer. The graph as it is is backed up again before a restore.</p>
<div data-backups role="status" aria-live="polite"><p class="note">正在读取… / Reading…</p></div>
<div data-format hidden>
  <h2>数据格式更新 <span class="en">Data format update</span></h2>
  <div data-format-body></div>
  <p data-format-outcome class="note" role="status" aria-live="polite" hidden></p>
</div>`;
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export const OWN_PROJECTS_STYLE = `
.folders{margin:4px 0;padding:0;list-style:none}
.folders li{display:flex;align-items:center;gap:10px;padding:4px 0}
.folders button{margin-left:auto}
.keep-form{display:grid;gap:6px;margin-top:8px;max-width:30rem}
.keep-form label{display:grid;gap:2px;font-size:13px}
.keep-form input{padding:5px 9px;border:1px solid #d6d9de;border-radius:7px;font:inherit;font-size:13px}
.keep-form button{justify-self:start;margin:0}
.backup-row button{margin-left:8px}
@media (prefers-color-scheme:dark){.keep-form input{border-color:#33363c;background:#1a1d20;color:inherit}}`;

// The answers of this computer's console, said in words; a failure says what it said.
export const OWN_PROJECTS_SCRIPT = [
  `const MAKE_LOCAL = ${JSON.stringify(MAKE_LOCAL_PATH)};`,
  `const GRAPH = ${JSON.stringify(FOLLOWER_GRAPH_PATH)};`,
  `const FORMAT = ${JSON.stringify(FOLLOWER_FORMAT_PATH)};`,
  'const JSON_HEADERS = { "content-type": "application/json" };',
  '// Asked only on a page that shows this computer\'s own projects (follower-page.js).',
  'const OWN = document.body.dataset.ownProjects === "1";',
  'function say(where, text) { where.hidden = false; where.textContent = text; }',
  'function esc(value) { return String(value).replace(/[&<>"\']/g, (c) => "&#" + c.charCodeAt(0) + ";"); }',
  'function failed(body) {',
  '  return body?.message ?? "没有成功，请再试一次。 / It did not work; try again.";',
  '}',
  'function size(bytes) {',
  '  if (!Number.isFinite(bytes)) return "—";',
  '  const units = ["B", "KB", "MB", "GB"];',
  '  let value = bytes, unit = 0;',
  '  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }',
  '  return (unit ? value.toFixed(1) : String(value)) + " " + units[unit];',
  '}',
  'function when(iso) {',
  '  const date = new Date(iso);',
  '  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();',
  '}',
  '',
  '// 「放在这台电脑」: answered once the project is made, which can take a minute or two.',
  'const keepOutcome = document.querySelector("[data-keep-outcome]");',
  'async function keep(input, control) {',
  '  control.disabled = true;',
  '  say(keepOutcome, "正在问主机，并为这个项目启动这台电脑的图谱，最多两分钟… / Asking the host and starting this computer\'s graph for the project, up to two minutes…");',
  '  try {',
  '    const answer = await fetch(MAKE_LOCAL, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) });',
  '    const body = await answer.json();',
  '    if (!answer.ok) { say(keepOutcome, failed(body)); control.disabled = false; return; }',
  '    say(keepOutcome, "已放在这台电脑，正在刷新。 / Kept on this computer; reloading.");',
  '    location.reload();',
  '  } catch {',
  '    say(keepOutcome, "这台电脑的控制台没有回答，请刷新页面再试。 / This computer\'s console did not answer; reload and try again.");',
  '    control.disabled = false;',
  '  }',
  '}',
  'for (const button of document.querySelectorAll("[data-keep-folder]")) {',
  '  button.addEventListener("click", () => keep({ projectPath: button.dataset.keepFolder }, button));',
  '}',
  'const keepForm = document.querySelector("[data-keep-form]");',
  'if (keepForm) keepForm.addEventListener("submit", (event) => {',
  '  event.preventDefault();',
  '  keep({ projectPath: keepForm.projectPath.value, projectId: keepForm.projectId.value || undefined },',
  '    keepForm.querySelector("button"));',
  '});',
  '',
  '// Which projects the merged list could not show now, and why (follower-local-api.js).',
  'const lists = document.querySelector("[data-project-lists]");',
  'if (OWN && lists) fetch("/api/personal-projects").then((answer) => {',
  '  const missing = [];',
  '  if (answer.headers.get("x-fuli-host-projects") === "unavailable") missing.push("主机的项目暂时看不到：主机现在没有回答。 / The host\'s projects cannot be shown now: the host does not answer.");',
  '  if (answer.headers.get("x-fuli-local-projects") === "unavailable") missing.push("这台电脑的项目暂时看不到：它的图谱正在启动或没有起来。 / This computer\'s projects cannot be shown now: its graph is starting or did not start.");',
  '  if (missing.length) say(lists, missing.join(" "));',
  '}).catch(() => {});',
  '',
  '// This computer\'s graph backups, each with its size, and a restore asked for once more.',
  'const backups = document.querySelector("[data-backups]");',
  'async function showBackups() {',
  '  try {',
  '    const answer = await fetch(GRAPH);',
  '    const body = await answer.json();',
  '    if (!answer.ok) { backups.textContent = failed(body); return; }',
  '    const job = body.job && body.job.status === "running"',
  '      ? (body.job.action === "restore" ? "正在恢复… / Restoring…" : "正在备份… / Backing up…") : "";',
  '    const rows = body.backups.map((item) => "<li class=\\"backup-row\\">" + esc(when(item.createdAt)) + " · " + size(item.bytes)',
  '      + "<button type=\\"button\\" data-restore=\\"" + esc(item.name) + "\\" data-at=\\"" + esc(when(item.createdAt)) + "\\">恢复这份 / Restore this</button></li>").join("");',
  '    const missing = body.missingProjects === null',
  '      ? "<p class=\\"note\\">暂时无法核实这台电脑的项目是否都在图谱里。 / Whether every project of this computer is in its graph cannot be checked now.</p>"',
  '      : body.missingProjects.length ? "<p class=\\"note\\">图谱里缺这些本机项目： / Missing from the graph: " + esc(body.missingProjects.join(", ")) + "</p>" : "";',
  '    backups.innerHTML = (job ? "<p class=\\"note\\">" + job + "</p>" : "")',
  '      + (rows ? "<ul class=\\"folders\\">" + rows + "</ul><p class=\\"note\\">共 / In all: " + size(body.totalBytes) + "</p>"',
  '        : "<p class=\\"note\\">还没有备份。 / No backup yet.</p>") + missing;',
  '    for (const button of backups.querySelectorAll("[data-restore]")) button.addEventListener("click", () => restore(button));',
  '  } catch {',
  '    backups.textContent = "这台电脑的控制台没有回答，请刷新页面。 / This computer\'s console did not answer; reload the page.";',
  '  }',
  '}',
  'async function maintain(input, button) {',
  '  button.disabled = true;',
  '  try {',
  '    const answer = await fetch(GRAPH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) });',
  '    if (!answer.ok) { backups.textContent = failed(await answer.json()); return; }',
  '    await showBackups();',
  '  } catch {',
  '    backups.textContent = "这台电脑的控制台没有回答，请刷新页面。 / This computer\'s console did not answer; reload the page.";',
  '  } finally { button.disabled = false; }',
  '}',
  'function restore(button) {',
  '  const asked = "用 " + button.dataset.at + " 的备份替换这台电脑现在的图谱？之后写入的内容会没有；恢复前会先自动再备份一次。\\n"',
  '    + "Replace this computer\'s graph with the backup of " + button.dataset.at + "? What was written since is gone; the graph as it is is backed up first.";',
  '  if (confirm(asked)) void maintain({ action: "restore", name: button.dataset.restore }, button);',
  '}',
  'const backupNow = document.querySelector("[data-backup]");',
  'if (OWN && backups && backupNow) {',
  '  backupNow.addEventListener("click", () => maintain({ action: "backup" }, backupNow));',
  '  void showBackups();',
  '}',
  '',
  '// A data format update of this computer\'s stores waiting for the person: what it changes, and one button.',
  'const format = document.querySelector("[data-format]");',
  'if (OWN && format) fetch(FORMAT).then((answer) => answer.ok ? answer.json() : null).then((plan) => {',
  '  if (!plan || (!plan.digest && !plan.blocked?.length)) return;',
  '  format.hidden = false;',
  '  const body = format.querySelector("[data-format-body]");',
  '  const stores = (plan.stores ?? []).map((store) => "<li>" + esc(store.label) + "</li>").join("");',
  '  const blocked = (plan.blocked ?? []).map((store) => "<li>" + esc(store.label) + "：现在不能更新 / cannot be updated now</li>").join("");',
  '  body.innerHTML = (stores ? "<p>这台电脑的这些数据要更新格式，更新前会自动备份： / These stores of this computer need a format update, backed up first:</p><ul>" + stores + "</ul>"',
  '    + "<button type=\\"button\\" data-format-apply>确认更新 / Update now</button>" : "") + (blocked ? "<ul>" + blocked + "</ul>" : "");',
  '  const apply = body.querySelector("[data-format-apply]");',
  '  const outcome = format.querySelector("[data-format-outcome]");',
  '  if (apply) apply.addEventListener("click", async () => {',
  '    apply.disabled = true;',
  '    try {',
  '      const answer = await fetch(FORMAT, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ digest: plan.digest }) });',
  '      if (!answer.ok) { say(outcome, failed(await answer.json())); apply.disabled = false; return; }',
  '      say(outcome, "已更新。 / Updated.");',
  '    } catch {',
  '      say(outcome, "这台电脑的控制台没有回答，请刷新页面。 / This computer\'s console did not answer; reload the page.");',
  '      apply.disabled = false;',
  '    }',
  '  });',
  '}).catch(() => {});',
  ''
].join('\n');
