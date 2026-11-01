// What the 常用操作 page teaches: the moves a new person says to their AI, and
// real cases of FULI at work. Kept here, outside vue-i18n, so a phrase keeps
// its literal `@` and `#` and the text stays in one place to edit.
//
// Every phrase is real task-entry syntax, never an invented command:
// `#FLA <name>` at the start and `@FLG …` only at the start are parsed by
// src/graphiti/fla-mention.js and documented in skills/operating-fuli/SKILL.md;
// `#FLA Bole 招一个前端` is the recruiting example in
// docs/agent-conversations-and-collaboration.md. A phrase without a keyword is
// an ordinary request the connected Agent carries out with FULI's tools
// (message_agent, coordinate_project_agent_task, upsert_personal_project).
// test/howto-phrasings.test.js pastes each one into the real parser.
// A ‹placeholder› is copied as is, so the person sees what to fill in.
// This module imports nothing at run time so that Node test can load it.
import type { AppLocale } from '@/i18n'

export type HowtoMoveId = 'anyClient' | 'continue' | 'discuss' | 'relay' | 'delegate' | 'recruit' | 'project' | 'review'
// `term`: the glossary term (features/glossary/terms.ts) the move's note explains.
export interface HowtoMove { id: HowtoMoveId; title: string; when: string; phrases: readonly string[]; note: string; term?: string }
export interface HowtoCaseStep { actor: string; client?: string; did: string; fuli?: string }
export interface HowtoCase { id: string; title: string; summary: string; steps: readonly HowtoCaseStep[] }
export interface HowtoContent { moves: readonly HowtoMove[]; cases: readonly HowtoCase[] }

const ZH: HowtoContent = {
  moves: [
    {
      id: 'anyClient', term: 'concept.receipt', title: '在任何客户端里用 FULI',
      when: 'Claude Code、Codex、Cursor、OpenCode 等连上 FULI 之后，照常聊天就行。',
      phrases: ['以后提交说明都用中文写'],
      note: 'FULI 会记住你的偏好和项目知识，换个客户端也照样生效；每次回复末尾的回执链接能看到这一轮记了什么。',
    },
    {
      id: 'continue', term: 'concept.fla', title: '找一位 FLA 接着干',
      when: '想让某位 FLA 在当前会话里接着它原来的工作，在哪个文件夹都行。',
      phrases: ['#FLA ‹姓名› 在这里继续'],
      note: '只写 #FLA 会列出可选的 FLA，回复编号即可；写 @FLA 结束 换回原来的归属。',
    },
    {
      id: 'discuss', term: 'concept.flg', title: '几位 FLA 一起讨论',
      when: '一个问题想听几种角度，比如产品体验和技术风险。',
      phrases: ['@FLG 讨论 ‹问题›', '@FLG ‹姓名›、‹姓名›，一起讨论 ‹问题›'],
      note: '@FLG 只写在开头。可以点名，也可以让 FULI 按职业推荐 2–4 位；回复编号确认成员后开始。',
    },
    {
      id: 'relay', title: '让 FLA A 去问 FLA B',
      when: '手上的 FLA 需要另一位 FLA 的意见，又不想自己来回转述。',
      phrases: ['#FLA ‹姓名› 去问问 ‹另一位›：‹问题›'],
      note: '对方在只读的会话里回答，不会改文件；问答记在圆桌里。',
    },
    {
      id: 'delegate', title: '一位负责人安排多个下属',
      when: '活大、能拆成互不冲突的几块时，交给项目负责人分派。',
      phrases: ['#FLA ‹负责人› 把这个任务拆开，派给团队里合适的 FLA 分头做，做完你来验收'],
      note: '负责人按职业分派，下属可以在不同客户端里干活；回执表格只列真正干了活的人。',
    },
    {
      id: 'recruit', title: '让伯乐给项目招人',
      when: '项目缺一个角色，比如前端或测试。在项目文件夹里说。',
      phrases: ['#FLA Bole 给这个项目招一个前端'],
      note: 'Bole 先找能复用的同职业 FLA，没有才招新人。',
    },
    {
      id: 'project', title: '创建项目并归到上级项目下',
      when: '一个文件夹要长期做，希望 FULI 单独记它的知识。',
      phrases: ['把这个文件夹建成一个 FULI 项目，名字叫 ‹项目名›'],
      note: '归到上级项目下由你自己操作：在项目页调整层级。',
    },
    {
      id: 'review', term: 'concept.receipt', title: '看 FULI 记了什么、改正它',
      when: '想确认 FULI 记得对不对，或者它记错了。',
      phrases: ['刚才记错了，应该是：‹正确的说法›'],
      note: '点回复末尾的回执链接看这一轮记下的内容；在 沉淀 › 偏好 里点「确认这条偏好」，一键确认。',
    },
  ],
  cases: [
    {
      id: 'fuli', title: '用 FULI 开发 FULI 自己',
      summary: '一个人定方向，几位 FLA 分别在三个客户端里干活。',
      steps: [
        { actor: '你', did: '说清楚要什么，比如「设置页每个主题一张卡片」。' },
        { actor: 'Lyra North', client: 'Claude Code', did: '作为项目负责人拆成边界清楚的几块，写好验收条件。', fuli: '带上你确认过的偏好和项目知识。' },
        { actor: 'OpenCode FLA', client: 'OpenCode', did: '几位同时开工：页面背景、面包屑导航、设置卡片，各做一块。', fuli: '每位只拿到自己那块的上下文。' },
        { actor: 'Codex FLA', client: 'Codex', did: '在真机上逐个点一遍，把问题报回来。', fuli: '检查请求通过圆桌排队送达。' },
        { actor: 'Lyra North', client: 'Claude Code', did: '审查、合并，整理成一张检查表。' },
        { actor: '你', did: '只看那一张表，决定下一步。', fuli: '记下「不要二次确认」「用卡片不用折叠」，下次每位 FLA 都照做。' },
      ],
    },
    {
      id: 'dingdong', title: '开发 DingDong',
      summary: '同一个人的另一个项目，用的是同一套做法。',
      steps: [
        { actor: '你', did: '在 DingDong 的文件夹里照常聊天。' },
        { actor: '项目负责人 FLA', did: '拆分、派活、验收，和 FULI 项目一样。', fuli: '只读 DingDong 自己的项目知识，FULI 项目的不会混进来。' },
        { actor: '各位 FLA', did: '按项目里的约定写代码、跑测试。', fuli: '你的个人偏好在这里同样生效，比如分支命名规则。' },
        { actor: '你', did: '不用再交代一遍习惯，只管方向。' },
      ],
    },
  ],
}

const EN: HowtoContent = {
  moves: [
    {
      id: 'anyClient', term: 'concept.receipt', title: 'Use FULI in any client',
      when: 'Once Claude Code, Codex, Cursor, OpenCode or another client is connected, just chat as usual.',
      phrases: ['From now on, write commit messages in English'],
      note: 'FULI remembers your preferences and project knowledge in every client; the receipt link at the end of each reply shows what this turn recorded.',
    },
    {
      id: 'continue', term: 'concept.fla', title: 'Have an FLA pick up its work',
      when: 'You want one FLA to continue its own work in this chat, from any folder.',
      phrases: ['#FLA ‹name› continue here'],
      note: '#FLA alone lists the FLAs to choose from; reply with a number. @FLA end goes back to the usual owner.',
    },
    {
      id: 'discuss', term: 'concept.flg', title: 'Let several FLAs discuss',
      when: 'A question deserves more than one view, such as product experience and technical risk.',
      phrases: ['@FLG discuss ‹question›', '@FLG ‹name›, ‹name›: discuss ‹question›'],
      note: '@FLG only counts at the start. Name them, or let FULI suggest 2–4 by occupation; reply with numbers to confirm the members and begin.',
    },
    {
      id: 'relay', title: 'Have FLA A ask FLA B',
      when: 'Your FLA needs another FLA\'s view and you would rather not pass messages back and forth.',
      phrases: ['#FLA ‹name› go ask ‹other name›: ‹question›'],
      note: 'The other FLA answers in a read-only session and changes no files; the exchange is kept in the Roundtable.',
    },
    {
      id: 'delegate', title: 'One lead, several team members',
      when: 'The job is big and splits into parts that do not collide; let the project lead hand them out.',
      phrases: ['#FLA ‹lead› split this task, hand the parts to the right FLAs on the team, and review their work'],
      note: 'The lead assigns by occupation, and members may work in different clients; the receipt table lists only who actually worked.',
    },
    {
      id: 'recruit', title: 'Have Bole staff a project',
      when: 'A project lacks a role, such as frontend or testing. Ask from the project\'s folder.',
      phrases: ['#FLA Bole recruit a frontend developer for this project'],
      note: 'Bole first looks for an FLA of that occupation to reuse, and recruits only when there is none.',
    },
    {
      id: 'project', title: 'Create a project under a parent',
      when: 'A folder you will work on for a while, whose knowledge FULI should keep on its own.',
      phrases: ['Make this folder a FULI project named ‹project name›'],
      note: 'Placing it under a parent is yours to do: use Rearrange hierarchy on the projects page.',
    },
    {
      id: 'review', term: 'concept.receipt', title: 'See what FULI recorded, and fix it',
      when: 'You want to check that FULI got it right, or it got something wrong.',
      phrases: ['That was recorded wrong; it should be: ‹the correct version›'],
      note: 'Open the receipt link at the end of a reply to see what this turn recorded; under Memory › Preferences, Confirm this preference is one click.',
    },
  ],
  cases: [
    {
      id: 'fuli', title: 'Building FULI with FULI',
      summary: 'One person sets the direction; several FLAs work in three clients.',
      steps: [
        { actor: 'You', did: 'Say what you want, for example "each settings topic gets its own card".' },
        { actor: 'Lyra North', client: 'Claude Code', did: 'As project lead, splits it into clearly bounded pieces with acceptance checks.', fuli: 'Brings along your confirmed preferences and project knowledge.' },
        { actor: 'OpenCode FLAs', client: 'OpenCode', did: 'Several start at once: page backdrops, breadcrumbs, settings cards, one piece each.', fuli: 'Each gets only the context of its own piece.' },
        { actor: 'Codex FLA', client: 'Codex', did: 'Clicks through each change on a real device and reports problems.', fuli: 'The check requests queue through the Roundtable.' },
        { actor: 'Lyra North', client: 'Claude Code', did: 'Reviews, merges, and sums it up in one checklist.' },
        { actor: 'You', did: 'Read that one table and decide what comes next.', fuli: 'Keeps "no double confirmation" and "cards, not accordions", so every FLA follows them next time.' },
      ],
    },
    {
      id: 'dingdong', title: 'Building DingDong',
      summary: 'Another project of the same person, worked the same way.',
      steps: [
        { actor: 'You', did: 'Chat as usual in the DingDong folder.' },
        { actor: 'Project lead FLA', did: 'Splits, assigns and reviews, as in the FULI project.', fuli: 'Reads only DingDong\'s own project knowledge; nothing from the FULI project mixes in.' },
        { actor: 'The FLAs', did: 'Write code and run tests by the project\'s conventions.', fuli: 'Your personal preferences apply here too, such as how branches are named.' },
        { actor: 'You', did: 'No need to explain your habits again; you only steer.' },
      ],
    },
  ],
}

const CONTENT: Record<AppLocale, HowtoContent> = { 'zh-CN': ZH, 'en-US': EN }

export function howtoContent(locale: AppLocale): HowtoContent {
  return CONTENT[locale]
}

/** A phrase as text and ‹placeholder› parts, so the page can mark what to fill in. */
export function phraseParts(phrase: string): Array<{ text: string; placeholder: boolean }> {
  return phrase.split(/(‹[^›]*›)/u).filter(Boolean).map(text => ({ text, placeholder: text.startsWith('‹') }))
}
