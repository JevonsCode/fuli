// One stroke icon set (24px grid, 1.8 stroke) so every surface speaks the same
// visual language. Each entry is the inner SVG markup of one icon.
export const ICONS = {
  constellation: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/><circle cx="19" cy="7" r="1.6"/><circle cx="5" cy="16" r="1.2"/>',
  agents: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.4.2 4 1.7 4.5 4.3"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/>',
  // 圆桌 from above: the table and six seats around it (Jevons 11-02). Each seat
  // carries its turn (--seat) so the dock can pulse them in sequence while live.
  roundtable: '<circle cx="12" cy="12" r="4.2"/><g class="roundtable-seats"><circle style="--seat:0" cx="12" cy="3.6" r="1.5"/><circle style="--seat:1" cx="19.3" cy="7.8" r="1.5"/><circle style="--seat:2" cx="19.3" cy="16.2" r="1.5"/><circle style="--seat:3" cx="12" cy="20.4" r="1.5"/><circle style="--seat:4" cx="4.7" cy="16.2" r="1.5"/><circle style="--seat:5" cx="4.7" cy="7.8" r="1.5"/></g>',
  // 即时对话 wakes the Agent now; 留言板 waits on a pinned note until it next works.
  // The model entry (Jevons 11-06): a dashed core with a bolt while nothing is
  // connected; a whole core with a filled bolt once a model powers FULI.
  modelCore: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="2.6 2.4"/><path d="M12.9 6.6 8.8 12.9h3.1l-.7 4.5 4.1-6.3h-3.1z"/>',
  modelCoreOn: '<circle cx="12" cy="12" r="8.5"/><path class="core-bolt" d="M12.9 6.6 8.8 12.9h3.1l-.7 4.5 4.1-6.3h-3.1z"/>',
  instant: '<path d="M13 3 5 13.5h6.5L11 21l8-10.5h-6.5z"/>',
  board: '<path d="M6 4.5h12A1.5 1.5 0 0 1 19.5 6v8.5L14 20H6a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 6 4.5z"/><path d="M19.5 14.5H15.5A1.5 1.5 0 0 0 14 16v4"/><path d="M8.5 9h7M8.5 12.5h4"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  project: '<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="10" ry="3.6" transform="rotate(-20 12 12)"/>',
  memory: '<path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  // Lucide's `settings` gear (ISC License, credited with `check` below); the old rayed circle
  // read as a light/dark switch (Jevons, 11-01).
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5"/><path d="M17 20V4M13.5 7.5 17 4l3.5 3.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  // The check is Lucide's `check` (https://lucide.dev, ISC License; "Copyright (c) for portions
  // of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c)
  // for Lucide are held by Lucide Contributors 2022."). Every done or check mark draws this icon,
  // never a text check character (Jevons, 11-01; ui/check-mark.spec.ts).
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/>',
  // The AI mark: a spark with a smaller one beside it. Drawn only by UiAiButton, the entry to a prompt for an AI.
  ai: '<path d="M10 5.5c.8 5.1 2.9 7.2 8 8-5.1.8-7.2 2.9-8 8-.8-5.1-2.9-7.2-8-8 5.1-.8 7.2-2.9 8-8z"/><path d="M18.5 2.5c.4 1.9 1.1 2.6 3 3-1.9.4-2.6 1.1-3 3-.4-1.9-1.1-2.6-3-3 1.9-.4 2.6-1.1 3-3z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.4v.4M12 16.6v.2"/>',
  warning: '<path d="M10.3 4.3 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 16.8v.2"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.3v.2"/>',
  'chevron-up': '<path d="m6 15 6-6 6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-left': '<path d="m15 6-6 6 6 6"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  tray: '<path d="M4 13.5 6.5 5h11L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/><path d="M4 13.5h4.5l1.2 2.2h4.6l1.2-2.2H20"/>',
  // The same tray with two sheets standing in it, like a full trash can (Jevons 11-01: 待决策 shows
  // whether something waits). The back rim breaks where the sheets stand in front of it.
  trayFull: '<g class="tray-rice"><path class="tray-rice-mound" d="M3.2 14.2c-.9-2.2.4-4.3 2.5-4.4-.1-2.5 2.1-4.4 4.6-3.8.9-2.1 3.6-2.9 5.5-1.6 2.2-.4 4 1.4 3.8 3.5 2 .6 2.9 2.7 2 4.6.6.5.7 1.2.4 1.7z"/><ellipse class="tray-rice-spill" cx="2.4" cy="16.6" rx="1" ry=".75"/><ellipse class="tray-rice-spill" cx="21.7" cy="17.5" rx="1" ry=".75"/><circle class="tray-grain tray-grain--1" cx="7" cy="11.4" r=".95"/><circle class="tray-grain tray-grain--2" cx="9.6" cy="8.4" r=".95"/><circle class="tray-grain tray-grain--3" cx="12.2" cy="11.2" r=".95"/><circle class="tray-grain tray-grain--4" cx="13.6" cy="7" r=".95"/><circle class="tray-grain tray-grain--5" cx="16.4" cy="9.6" r=".95"/><circle class="tray-grain tray-grain--2" cx="18.3" cy="12.4" r=".95"/><circle class="tray-grain tray-grain--4" cx="9.5" cy="12.9" r=".8"/><circle class="tray-grain tray-grain--1" cx="15" cy="12.8" r=".8"/></g><path class="tray-front" d="M3.6 14.4h16.8l-1.1 5.2a1.5 1.5 0 0 1-1.5 1.2H6.2a1.5 1.5 0 0 1-1.5-1.2z"/><path class="tray-slot" d="M7.4 16.8h2.7l.7 1.3h2.4l.7-1.3h2.7"/>',
  refresh: '<path d="M19.5 9A7.8 7.8 0 1 0 20 14"/><path d="M20 4v5h-5"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  // 在客户端打开: the client's window, with the page going into it.
  openInApp: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 8.5h17"/><path d="M9 16.5 14 11.5"/><path d="M10 11.5h4v4"/>',
} as const

export type IconName = keyof typeof ICONS
