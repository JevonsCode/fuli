import { CONSOLE_LANGUAGES, DEFAULT_CONSOLE_LANGUAGE, consoleLanguage } from '../app/console-language.js';

// What to call a personal project wherever FULI writes it for a person or
// hands it to an Agent: a receipt line, a CLI line, a board row, an MCP
// resource title, the answer a tool returns.
//
// A project someone named keeps their name. A temporary project has no name
// stored (graph-provider/fuli_graph/temporary_project_scope.py), so the words
// are written here, in the language the person reads FULI in, and one project
// is told from another by a short number taken from its own ID: 「临时项目
// #a1b2c3d4」, the reference the Provider writes too (project_reference). The
// text never carries a date, so an Agent, a menu entry or a resource title
// stays the same however often the project is used; only the console adds
// the date. An Agent knows a project is temporary from `temporary: true`,
// never from these words.

const TEMPORARY_ID = /^(?:temporary|conversation)-([0-9a-f]{64})$/;
// The names FULI generated for a temporary project before graph/23 cleared
// them. A graph still waiting for that migration serves them, and they say
// nothing about which project it is, so they are never shown as a title.
const GENERATED_NAMES = new Set([
  '临时任务 / Temporary task', '临时会话 / Temporary session', '会话项目 / Conversation project'
]);
const NUMBER_LENGTH = 8;
const WORDS = Object.freeze({ 'zh-CN': '临时项目', 'en-US': 'Temporary project' });

/**
 * A project FULI opened by itself. Its scope_type says so first, as the
 * Provider stores it. A conversation project a person named is theirs.
 *
 * Compatibility: a generated ID with no name of its own counts too, for a
 * conversation fallback a graph waiting for graph/23 has not marked yet, and
 * for a caller holding only an ID. graph/23 marks every one of them
 * temporary; remove the ID check with GENERATED_NAMES once no supported FULI
 * opens a graph below 23, after checking no caller passes a bare ID (the same
 * fallback is in the Provider's is_temporary_project and the console's
 * project-origin.ts).
 */
export function isTemporaryProject(project) {
  if (!project) return false;
  if ((project.scope_type ?? project.scopeType) === 'temporary') return true;
  return TEMPORARY_ID.test(project.project_id ?? project.id ?? '') && !givenProjectTitle(project);
}

/**
 * What to call this project. `language` is the one the person reads FULI in
 * (console-language.js); without one, FULI's default. A project with no name
 * and no usable ID falls back to its ID, so a line is never blank.
 */
export function projectDisplayName(project, language = DEFAULT_CONSOLE_LANGUAGE) {
  const title = givenProjectTitle(project);
  if (title) return title;
  const id = project?.project_id ?? project?.id ?? '';
  if (!isTemporaryProject(project)) return id;
  const words = WORDS[CONSOLE_LANGUAGES.includes(language) ? language : DEFAULT_CONSOLE_LANGUAGE];
  const digest = TEMPORARY_ID.exec(id)?.[1];
  return digest ? `${words} #${digest.slice(0, NUMBER_LENGTH)}` : words;
}

/** The person's language for a caller that holds the application, not a setting. */
export function applicationLanguage(application) {
  try { return consoleLanguage(application?.flaMenuSettings?.()?.language ?? ''); }
  catch { return consoleLanguage(''); }
}

// The title a person or an Agent gave this project, or '' where only FULI named it.
function givenProjectTitle(project) {
  const name = String(project?.profile?.name ?? project?.name ?? '').trim();
  return GENERATED_NAMES.has(name) ? '' : name;
}
