// The state band a follower puts on top of every page it shows (rec#144:
// 「它是从机的时候，我不知道什么功能是用的主机的，什么功能是用从机的」). One
// line, always there: who this computer follows, whether that computer answers,
// when it was last reached, how many records still wait to be delivered — and,
// at the end of the line, where this page's data came from.
//
// Where the data came from is not guessed: the follower's console entry marks
// every answer it serves with SOURCE_HEADER, and this script reads that header
// off the page's own requests. A page that read nothing says nothing. The
// values, which are also the three answers to "whose data is this?" in
// docs/runner-roles-design.md §3:
//
//   host                  the computer that owns the scope answered
//   local                 this computer's own, which it owns and writes
//   replica; synced=<iso> this computer's read-only copy of a scope another
//                         computer owns, as it stood at that time
//   unavailable           the owner is away and nothing is kept for it
//
// Nothing serves `replica` yet: a follower owns no scope until step 3c. The band
// shows it already, because the band is shipped with the follower and the copy
// will be served by the computer that owns the scope.
//
// It is plain source served at BAND_PATH and added to the HTML pages the
// follower carries from its host, because those pages are the host's and are
// never rebuilt here. The follower's own console page (follower-page.js) draws
// the same line itself.
export const SOURCE_HEADER = 'x-fuli-source';
export const BAND_PATH = '/__fuli-follower/band.js';
export const STATUS_PATH = '/__fuli-runner/status';
export const BAND_HEIGHT = 26;

// Added before </head> of every HTML page the follower serves from its host.
// The height is taken off `.app-frame`, which is the console's own full-height
// shell, so the band adds a line instead of pushing the dock out of the window.
export function bandTag() {
  return '<style>'
    + `:root{--fuli-follower-band:${BAND_HEIGHT}px}`
    + 'body{padding-top:var(--fuli-follower-band)}'
    + '.app-frame{height:calc(100dvh - var(--fuli-follower-band))}'
    + '</style>'
    + `<script type="module" src="${BAND_PATH}"></script>`;
}

export const BAND_STYLE = `#fuli-follower-band{position:fixed;inset:0 0 auto 0;z-index:2147483647;`
  + `height:${BAND_HEIGHT}px;display:flex;align-items:center;gap:8px;padding:0 12px;box-sizing:border-box;`
  + 'font:12px/1 -apple-system,system-ui,"Helvetica Neue",sans-serif;color:#4b5563;background:#f3f4f6;'
  + 'border-bottom:1px solid #e5e7eb;white-space:nowrap;overflow:hidden}'
  + '#fuli-follower-band a{color:inherit;text-decoration:none;border-bottom:1px solid transparent}'
  + '#fuli-follower-band a:hover{border-bottom-color:currentColor}'
  + '#fuli-follower-band .dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:#9ca3af}'
  + '#fuli-follower-band .dot.on{background:#16a34a}#fuli-follower-band .dot.off{background:#d97706}'
  + '#fuli-follower-band .gap{flex:1 1 auto}#fuli-follower-band .mark{color:#6b7280}'
  + '@media (prefers-color-scheme:dark){#fuli-follower-band{color:#9ca3af;background:#15171a;'
  + 'border-bottom-color:#26292e}#fuli-follower-band .mark{color:#8b9099}}';

// The module served at BAND_PATH.
export const BAND_SOURCE = [
  '// Served from src/runner/follower-band.js; it runs on the host pages a follower carries.',
  `const STATUS = ${JSON.stringify(STATUS_PATH)};`,
  `const SOURCE_HEADER = ${JSON.stringify(SOURCE_HEADER)};`,
  'const EVERY_MS = 20000;',
  'const seen = new Set();',
  'let path = location.pathname;',
  'let state = null;',
  '',
  'const style = document.createElement("style");',
  `style.textContent = ${JSON.stringify(BAND_STYLE)};`,
  'const bar = document.createElement("div");',
  'bar.id = "fuli-follower-band";',
  'bar.setAttribute("role", "status");',
  '',
  '// Where this page\'s data came from, read off the headers of its own requests.',
  'const plainFetch = window.fetch.bind(window);',
  'window.fetch = async (input, init) => {',
  '  const answer = await plainFetch(input, init);',
  '  const source = answer.headers.get(SOURCE_HEADER);',
  '  if (source && !seen.has(source)) { seen.add(source); render(); }',
  '  return answer;',
  '};',
  'for (const name of ["pushState", "replaceState"]) {',
  '  const original = history[name].bind(history);',
  '  history[name] = (...args) => { const out = original(...args); routed(); return out; };',
  '}',
  'addEventListener("popstate", routed);',
  'function routed() {',
  '  if (location.pathname === path) return;',
  '  path = location.pathname;',
  '  seen.clear();',
  '  render();',
  '}',
  '',
  'function sourceMark() {',
  '  if (seen.has("unavailable")) return { zh: "本页：主机不在线", en: "this page: the host is away" };',
  '  const replica = [...seen].find((source) => source.startsWith("replica"));',
  '  const synced = replica?.match(/synced=([^;\\s]+)/)?.[1];',
  '  const parts = [];',
  '  if (seen.has("host")) parts.push({ zh: "主机", en: "the host" });',
  '  if (replica) parts.push({ zh: synced ? "本机只读副本（同步于 " + synced + "）" : "本机只读副本",',
  '    en: synced ? "this computer\'s read-only copy, synced " + synced : "this computer\'s read-only copy" });',
  '  if (seen.has("local")) parts.push({ zh: "本机", en: "this computer" });',
  '  if (!parts.length) return null;',
  '  return { zh: "本页：" + parts.map((part) => part.zh).join(" + "),',
  '    en: "this page: " + parts.map((part) => part.en).join(" and ") };',
  '}',
  '',
  'function render() {',
  '  bar.textContent = "";',
  '  const dot = document.createElement("span");',
  '  dot.className = "dot" + (state?.host?.reachable === true ? " on" : state?.host ? " off" : "");',
  '  bar.append(dot);',
  '  const line = document.createElement("a");',
  '  line.href = "/local";',
  '  line.textContent = state?.line?.zh ?? "正在读取本机状态…";',
  '  line.title = (state?.line?.en ?? "Reading this computer\'s state…") + " — 打开本机控制台 / open this computer\'s console";',
  '  const gap = document.createElement("span");',
  '  gap.className = "gap";',
  '  bar.append(line, gap);',
  '  const mark = sourceMark();',
  '  if (!mark) return;',
  '  const tag = document.createElement("span");',
  '  tag.className = "mark";',
  '  tag.textContent = mark.zh;',
  '  tag.title = mark.en;',
  '  bar.append(tag);',
  '}',
  '',
  'async function read() {',
  '  try {',
  '    const answer = await plainFetch(STATUS, { headers: { accept: "application/json" } });',
  '    state = answer.ok ? await answer.json() : null;',
  '  } catch { state = null; }',
  '  render();',
  '}',
  '',
  'document.head.append(style);',
  'document.body.prepend(bar);',
  'render();',
  'void read();',
  'setInterval(read, EVERY_MS);',
  ''
].join('\n');
