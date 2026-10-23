// The task scene: which kind of work a request is, and which personalized
// preferences that scene selects (rec#15 D-27). preference-task-scope.js
// combines it with the other task dimensions; the Provider applies the same
// table and rules in graph-provider/fuli_graph/task_scene.py, and
// test-support/task-scene-cases.json holds the cases both must agree on.
//
// - tasteDomain is a scene key: TASTE_DOMAIN_SCENES maps it to the work kinds
//   it applies to. A domain outside the table matches no scene; it never
//   becomes general.
// - The scene-replaceable personalized set (D-27.8) is every item with a scene
//   key (a workKind qualifier or a tasteDomain), plus taste and personality
//   items without one. Those without one are general: they apply in every
//   scene except one positively classified as chat; an unclassified (null)
//   task keeps them.
// - A judgment_preference without a scene key is a boundary: it applies in
//   every scene and a scene switch never revokes it. Nothing is guessed from
//   its text; only a person's explicit scene key or constraint: "soft" makes
//   it replaceable. constraint: "hard" keeps any item without a scene key out
//   of the replaceable set.

export const TASK_SCENE_VERSION = 'task-scene-2';
export const EVERY_SCENE = '*';
export const PREFERENCE_CONSTRAINTS = Object.freeze(['hard', 'soft']);
const CHAT = 'chat';
const GENERAL_ASPECTS = new Set(['taste', 'personality']);
const PROMPT_LIMIT = 8192;

// Conservative hints, not semantic understanding: the first matching row wins
// and an unmatched request has no scene (null). An explicit workKind wins.
const WORK_KIND_HINTS = Object.freeze([
  ['code_review', /代码审查|代码评审|code review|review code/iu],
  ['architecture', /架构|\barchitecture\b/iu],
  ['design', /视觉设计|交互设计|设计稿|原型图|配色|排版|\b(?:visual design|ui design|ux|mockup|wireframe|typography)\b/iu],
  ['frontend', /前端|页面|组件|样式|\b(?:frontend|front-end|css|vue|react|component|stylesheet)\b/iu],
  ['implementation', /修复|实现|开发|编写代码|优化|改为|接入|\b(?:implement|fix|bug|coding)\b/iu],
  ['test_validation', /测试|验证|\b(?:test|verify|validation)\b/iu],
  ['project_management', /看板|排期|规划|\bplanning\b/iu],
  // Only a message that is entirely small talk is chat.
  [CHAT, /^(?:[\s!！。.,，~～?？]*(?:你好|您好|嗨|哈喽|早上好|早安|晚上好|晚安|谢谢|多谢|辛苦了|在吗|闲聊|聊聊天?|随便聊聊|hi|hello|hey|thanks|thank you|good (?:morning|evening|night)))+[\s!！。.,，~～?？]*$/iu]
]);

export const WORK_KINDS = Object.freeze(WORK_KIND_HINTS.map(([kind]) => kind));

// Versioned with TASK_SCENE_VERSION: a changed row changes which preferences a
// scene selects, so it needs the next version (and the Provider's copy).
const TASTE_DOMAIN_SCENES = Object.freeze({
  frontend: ['frontend'],
  ui: ['design', 'frontend'],
  ux: ['design', 'frontend'],
  design: ['design', 'frontend'],
  visual: ['design', 'frontend'],
  architecture: ['architecture'],
  code: ['implementation', 'code_review', 'frontend', 'test_validation'],
  testing: ['test_validation'],
  chat: [CHAT],
  // Every reply is writing, chat included.
  writing: EVERY_SCENE
});

export const TASTE_DOMAINS = Object.freeze(Object.keys(TASTE_DOMAIN_SCENES));

export function taskWorkKind(prompt) {
  const text = typeof prompt === 'string' ? prompt.slice(0, PROMPT_LIMIT) : '';
  return WORK_KIND_HINTS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

// begin_task_context arguments from a hook: an unclassified prompt sends none.
export function taskSceneInput(prompt) {
  const workKind = taskWorkKind(prompt);
  return workKind ? { workKind } : {};
}

// The work kinds an item's tasteDomain names: undefined when it states none,
// EVERY_SCENE, or a list ([] when no listed domain is in the table).
export function tasteDomainScenes(qualifiers) {
  const value = qualifiers.tasteDomain ?? qualifiers.taste_domain;
  if (value === undefined || value === null || value === '') return undefined;
  const domains = typeof value === 'string' ? [value]
    : Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
  const scenes = domains.map(domain => domain.trim().toLowerCase())
    .map(domain => Object.hasOwn(TASTE_DOMAIN_SCENES, domain) ? TASTE_DOMAIN_SCENES[domain] : []);
  return scenes.includes(EVERY_SCENE) ? EVERY_SCENE : [...new Set(scenes.flat())];
}

// Whether an item without a scene key is in the replaceable set above.
export function generalItemReplaceable(qualifiers, aspect) {
  if (qualifiers.constraint === 'hard') return false;
  return qualifiers.constraint === 'soft' || GENERAL_ASPECTS.has(aspect);
}

export function chatScene(workKind) {
  return workKind === CHAT;
}
