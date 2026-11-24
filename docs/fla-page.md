# The FLA page

How one assistant's own page is designed, and why. The console's shared
language — colours, type, controls, motion — stays in
[console-design.md](console-design.md); this page's own layout is summarised
there under Layout and argued here.

Jevons, 2026-11-23, looking at a real FLA page: 「FLA 的界面 UX UI 还是要再设计一下，
我觉得现在不合理」「我们 FULI 给人看的东西，都要清晰明了，文字讲重点，有需要就画图……
有交互的要方便交互，能点击的不输入」.

## Who opens this page, and what they came for

One person opens one assistant. In order of how often they want it:

| | The question | Where it is answered |
| --- | --- | --- |
| 1 | What is it doing right now, how far along? | 现在, the line under the name — first screen |
| 2 | What did it just do, how did it turn out? | 手上的活 and 最近做完 — first screen |
| 3 | Let it carry on, or hand it something new. | 交给它一件事, the one primary button |
| 4 | What is it responsible for, what can it do? | 负责什么 — one scroll down |
| 5 | Where and when did it work, on which model, at what cost? | 在哪干的活 and 最近的活动 — one scroll down |
| 6 | Settings. | 设置, a quiet button; its own panel |

The old page answered 6, then part of 4, then 1 — exactly backwards. 起步包
(configuration a person touches once) held the main part of the first screen,
and the work was below the fold.

## What the repository can actually show

Nothing is drawn that FULI cannot report. Checked line by line against the code:

| Shown | Comes from | Missing data reads as |
| --- | --- | --- |
| Current state (正在做 / 等你拍板 / 被卡住了 / 现在没活) | `agentWorkbenchEntry()` over `agent.workStatus` or this FLA's own task page (`GET /api/project-agent-tasks?agentId=`) | 「没有上报状态」 or, when the read failed, 「这次没读到它在做什么」 with 再读一次 — never 「现在没活」 |
| Current task and its step | `GET /api/project-agents/{id}/workbenches` → `progress`, `steps`, `currentStepId` | the step line is left out |
| Progress 5/8 | the same `progress {completed, total}` | the status word instead of a bar — never a guessed percentage |
| Which clients the work runs in | `sessions` on the task list (`taskSessions()`, 3 clients at most) | no marks |
| Opening that conversation | `clientMarks()` + 设置 › 会话打开方式 | a muted mark that says why, with 去设置 beside it |
| When its last progress was | the FLA's last recorded change on the task (`entry.lastUpdateAt`, `lastProgressOf()` in `team-work/work-freshness.ts`), said as 「最近进展 3 天前」 | 「没有记下最近进展」, the dot still |
| How long it has been running | `currentTaskRunningSince` (roster only), on hover over the last-progress time | no hover text |
| Other tasks waiting on the person | the same task read: `awaiting_review` and `blocked` besides the one 现在 names | the line is left out |
| Starter kit picks still owed | `GET /api/project-agents/{id}/occupation-kit`: no `choice`, unanswered items, or `choice.outdated` | the line is left out |
| Experiences to keep or drop | the growth read: `proven` and not yet `confirmed` | the line is left out |
| Finished work and its result | the same task read, `resultSummary` / `failureReason` / `completedAt` | the task without a result line |
| Responsibility, occupation, projects | `profile.responsibility`, `occupation`, `assignments[].responsibility` | 「还没定职业」 |
| Handoff phrase | `mentionPhrasings()` | the FLA alone, no pair phrasing |
| Where it worked, on which model, how much | `GET /api/project-agent-work-locations` (widget `fla-work-locations`) | `-` with the reason, never 0 |
| Which days it finished, failed or cancelled tasks | `GET /api/project-agent-activity` over the past year (widget `fla-activity`), read only once the section comes into view | 「过去一年没有记下做完、没做成或取消的任务」 — no empty squares; a failed read says so with 再读一次 |
| Which workstream it leads or owns | `GET /api/workstreams?agentId=` (widget `workstream-ledger`) | the section is left out |
| What it learned | `GET /api/project-agents/{id}/growth` (widget `fla-growth`) | the section is left out |

The two rows this page first drew as reserved positions are recorded now, so
their real widgets sit there (see [Widgets in the column](#widgets-in-the-column)).

## Before and after

The wireframes first drawn for this page no longer matched it and were removed;
the screenshots in the pull request are the reference.

| The old page | What it cost | The new page |
| --- | --- | --- |
| Header with 「FLA 000289」「可用」「测试」 as three equal pills | Three unrelated facts shout equally; the eye has no entry point | One quiet line: `职业 · FLA 000289 · 测试`. Only the work state keeps a coloured mark, and only when it is not plain 可用 |
| Responsibility clamped to two lines with 「…」 | The one thing you cannot read is the one thing the header promised | The header shows no responsibility; 现在 takes that line. The full text appears once, in 负责什么 |
| 起步包 card held the middle of the first screen | Configuration pushed the work below the fold | 起步包 moves to the bottom of the column, folded once answered; while picks are owed it stays open and 等你处理 under 现在 says so |
| 任务单 repeated each FLA's whole responsibility per row | The same paragraph three times; no progress anywhere | A share's assignment is two lines at most, with the full text on hover; the recorded bar and step sit on the row |
| 「复制 #FLA」 and 「设置」 as two equal outline buttons | The main action was a string only an insider understands | One ink button, 交给它一件事, that opens a new conversation in the person's client in one click; 设置 is a quiet outline button beside it |
| Nothing said what the FLA was doing | The most common question had no answer | 现在 is the line under the name |

## Layout

### Fixed region — identity and 现在

One surface, two rows separated by a hairline. No card inside a card.

```
◯  名字 ✎   前端工程师 · FLA 000289 · 测试        [交给它一件事 ▾] [设置]
──────────────────────────────────────────────────────────────────────
●  正在做「任务标题」 · 现在：核对 locale 分支   ▓▓▓▓▓░░░ 5/8   CC Cx   最近进展 5 分钟前
•  另有 1 件等你拍板     •  起步包还有 3 项等你选     •  1 条经验等你定留不留
```

- The portrait is 44px, not 72: it identifies, it is not the subject.
- The name is the page's one H1 (`usePageTitle(..., { inPage: true })`), renamed
  where it stands. The breadcrumb keeps naming the page, Jevons's 11-04 call.
- `FLA 000289` is plain muted text, not a pill, and copies the number on click.
- 现在 has four shapes, and every one of them carries somewhere to go:
  - **正在做** — task title (opens the task), 现在：<step>, the recorded bar, the client marks, and when its last progress was: 「最近进展 5 分钟前」, 「刚刚有进展」 or 「没有记下最近进展」. A task the records call running says 正在做 however long ago that change was; FULI states the time and does not decide for the person that the work stopped (Jevons 11-25: 「这个不能写太死吧」). How long it has run (「已经做了 3 天」) is on hover over that time, so two times never sit side by side. The dot breathes only while the last change is under 30 minutes old (`PULSE_WITHIN_MS`, a visual hint that changes no words); otherwise it is the quiet grey, never a warning colour. A task last moved three days ago therefore reads 「最近进展 3 天前」 beside a still grey dot — not as work moving right now.
  - **等你拍板 / 被阻塞 / 暂停** — the reason in the FLA's own words, then 去处理, which opens that task.
  - **现在没活** — says so, then the last finished task (title, when), which opens it. The primary button is already in the row above.
  - **没有上报状态** — says so, and offers 去看它的会话 (scrolls to 在哪干的活). A read that failed says 「这次没读到它在做什么」 and offers 再读一次. A limitation never ends the sentence.
- **等你处理** — under 现在, one short line for each thing that waits on the
  person and would otherwise sit further down: 另有 N 件等你拍板 (or 被卡住;
  the Provider ranks running work first, so a review would hide behind it),
  起步包还有 N 项等你选 (or 起步包更新了), N 条经验等你定留不留. Each goes where it
  is answered (the task, or the section, opened). Nothing waiting, no group.
- A task opens on this same page: a link that names one (`?task=`, from 现在, 手上的活, 最近做完 or the action panel) shows that task's full card at the top of the column.

### Scrolling region

One column, `PageStack` width (960px, centred), in this order:

1. **被阻塞的任务** — only when there are any; each row keeps its 解除阻塞 action.
2. **手上的活 n** — the unfinished task sheets, the FLA's own share first, every card folded on `现在：<step> · 最近进展 …` (the same fact and the same dot as 现在) and its count (现在 above already names the FLA, so the card does not repeat 「<名字> 正在做」). Open, a card lists each share's current step with one either side and offers 全部 N 步; the share is indented under a hairline, not a grey card in the card. A card a link names (`?task=`) opens with every step. Finished sheets are 最近做完's.
3. Its workflows waiting on the person, only when there are any.
4. **最近做完 n** — finished and failed tasks, newest first: title, one line of the recorded result (a failed one says 没做成 in words), project and when; five, then 查看全部.
5. **在哪干的活** — clients, models, segments (`fla-work-locations`).
6. **最近的活动** — a year of days, each shaded by how many of its tasks finished, failed or were cancelled that day; a day opens those tasks (`fla-activity`). Read only once the section comes into view. A year with none says so in words; a column too narrow for the year scrolls the calendar inside its own box, opened on the latest weeks.
7. **工作线账本** — the lines it leads or owns, only when there are any (`workstream-ledger`).
8. **负责什么** — the full responsibility, once; the projects it is on with each project's own responsibility; earlier projects and how it was recruited, folded; why it left, if it did. The occupation is in the header line and not repeated here.
9. **学会了** — the experiences it kept, 保留 / 不要 in one click.
10. **起步包** — the occupation kit: source, licence, counts, Skill and MCP toggles. Folded once answered, because it is configuration; while nothing was chosen, or the kit changed since the choice, it stays open and its summary says 还没选用哪些 in the warning tone.

The activity calendar came back below 在哪干的活 after a round without it
(Jevons 11-25: 「活动日历去掉，为什么要去掉？」). It is not on the first screen,
and it costs nothing until someone scrolls to it.

The team island above the dock leaves this FLA's own tasks out on this page
(the shell passes `excludeAgentId`); other teams' tasks still float there.

At 1100px and up the page itself does not scroll: the fixed region stays and
only this column scrolls, so 现在 is always on screen. Below 1100px the whole
page scrolls, as it already did.

## The one action

`交给它一件事` / `Give it something to do` is the only ink button on the page.
Nothing in it is typed, and nothing in it is a dead end.

1. **在新对话里接着做** — one row per client that can open a new conversation
   with the opening message already in it, through the console's one way of
   doing that (`client-links/new-session.ts`, shared with 「让 Tonborg 给你解释」
   and 项目的「整理」; the rows come from `new-session-clients.ts`): 「在 Codex
   里新开」 follows the client's documented link, 「在 Claude Code 里新开 · 新窗口」
   asks FULI's session launcher to open its CLI here. Then 复制给其他 AI. The
   message is the recorded hand-over of its last conversation when FULI has one
   (`continuation`), else the FLA called by name to carry on. It keeps the
   `#FLA` / `#FLG` protocol the client AI parses; the rows say in words what
   happens. Only when no client here can open one does the group become one
   row, 复制开场话, saying why and offering 去设置客户端接入. Which clients can open
   is asked only when the menu opens: finding a terminal way starts shells on
   this computer.
2. **叫几位一起讨论** — for an FLA, the group phrasings that end where the person
   goes on typing; copied, never sent, shown without the `#FLG` prefix.
3. **打开它正在用的会话** — one row per client session an open task reports that
   opens. The ones that cannot are one note at the end of the group, per reason:
   「还没有配会话打开方式」 with 去设置会话打开方式 (the one row a keyboard reaches),
   「这个客户端只能打开自己，打不开某一次会话」, or 「没记下是哪一次会话」.

The old 继续 FULI 里的一项工作 group is gone: it only opened a task card on this
page, which 手上的活 already shows. A group with nothing in it is left out; an
FLA with nothing to hand over has no button.

## Widgets in the column

The column has three widget places, in reading order, with the page's own
sections between them (`web/src/widgets/layout.ts`):

| Place | Widgets | Then the page's own |
| --- | --- | --- |
| `fla.overview` | `fla-blocked`, `fla-sheets` | workflows, 最近做完 |
| `fla.history` | `fla-work-locations`, `fla-activity`, `workstream-ledger` | 负责什么 |
| `fla.profile` | `fla-growth`, `fla-kit` | — |

Every widget takes the slot's four context keys (`spaceId`, `agentId`,
`agentName`, `projectName`). The work-locations, task-sheet, starter-kit and growth reads
are each made once per FLA and shared (`web/src/lib/shared-read.ts`): 现在 and
手上的活 read the same sheets, the count and the action panel the same work
locations, 等你处理 and its sections the same kit and growth. The top bar's 刷新
reads all of them again, and the task list, so 现在 and 最近做完 come from the
same moment.

## Widths

The breakpoints are the code's (`AgentProfilePage.vue`, `FlaNow.vue`):

- **1100px and up** — the page itself does not scroll; the fixed region stays
  and only the column scrolls, leaving the dock's clearance under its last line.
  The client's default 1280×860 is this shape: one centred column, the page's
  own gutter on both sides.
- **Wide (up to the 1888px canvas, and beyond)** — the same single column; the
  extra room is page margin, as on every other console page (Jevons 11-13:
  cards are never dealt into two columns that scroll together).
- **860px and up** — 现在 is one line: words on the left, bar, client marks and
  time on the right.
- **Below 860px** — the identity row stacks (portrait and name, the meta line,
  then the actions full width) and 现在 wraps to two lines. Below 1100px the
  whole page scrolls and every page keeps `--dock-clearance` under its last line,
  so the dock and the team island never cover the end of it. The order never
  changes.

## Type, colour, spacing

Inspectable choices, all from the existing tokens — no new visual system.

- **Type** — name `--text-title` 22/600; section labels `--text-control` 13/600
  in `--color-ink-soft` (the same label the task-sheet widget already uses, so
  every section of the column reads as one list); row names
  `--text-card-title` 15/600; body 14; meta and times `--text-meta` 12.
  Numbers use `.ui-num` so 5/8 lines up between rows.
- **Colour** — the page is the plain neutral grey; each block is one white
  surface split by hairlines. Gold (`--color-gold`) only ever means progress:
  the bar, and the dot that breathes while a change was recorded in the last 30 minutes. Ink is the primary
  button and the current destination. Danger is only a blocked or failed task;
  warning only 等你拍板. At most one saturated element per block, and a
  problem is never green.
- **Spacing** — the 4px scale. The identity row is 16/20, 现在 is 12/20,
  sections are 16 apart, rows inside a section 8. Section labels align with the
  rows under them, not with the card's padding, so the column has one left edge.
- **Shape** — `--radius-card` 14 on the surfaces, `--radius-control` 8 on
  controls, `--radius-pill` on the client marks. Hairlines only; a shadow
  appears solely on the open task card and on the action panel.
- **Motion** — only the shared `--motion-enter / --motion-exit / --motion-move`,
  `TransitionGroup name="ui-list"` for the lists, and the existing breathing
  dot on a reported running step. Motion is there to say *this is live*;
  with 减少动态效果 on, the dot holds still and nothing else changes.

## Accessibility

- Every section is a landmark with its own heading; the column is one reading
  order that matches the visual one at all widths.
- The primary panel is the shared dropdown menu: Esc closes it, focus returns to the
  button, and arrow keys reach every row. No row is a disabled dead end: what
  cannot open is said in one note, and its fix is a row of its own.
- The progress bar carries `role="progressbar"` with the real numbers; the
  client marks carry the client's name and what clicking does; the breathing dot
  is decorative and hidden from the reader.
- Nothing is conveyed by colour alone: every tone also has a word.

## The list page and the fixed roles

The same language has to hold for the FLAs list and for Jefa, Bole, Tonborg and
Assistant. This round only keeps them from clashing:

- The list page's row already shows portrait · name · occupation · FLA number ·
  current work · time, which is the same order and the same words as the new
  header. Nothing there changes.
- A fixed role opens on its Workbench, which needs the room; the identity row
  and 现在 sit above it unchanged, and the scrolling column is the Workbench's.
  A fixed role has no occupation kit and no handoff pair phrasing, so those rows
  are absent rather than empty. Its page does not read the task list: 现在
  reads only the task its roster names (for its title and last change), says
  「没有上报状态」 when the roster reports none — never 现在没活 from a list it
  never read — and offers no 去看它的会话, since the page has no such section.
  最近做完 and 最近的活动 have no source there and do not appear.

What still needs doing on those pages is listed in the pull request, not fixed
here.
