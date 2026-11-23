import { CONSOLE_LANGUAGES, DEFAULT_CONSOLE_LANGUAGE, consoleLanguage } from '../app/console-language.js';

// What to call a personal project wherever FULI writes it for a person or
// hands it to an Agent: a receipt line, a CLI line, a board row, an MCP
// resource title, the answer a tool returns.
//
// A project someone named keeps their name. A temporary project has no name
// stored (graph-provider/fuli_graph/temporary_project_scope.py), so the words
// are written here, in the language the person reads FULI in, and one project
// is told from another by a short number taken from its own ID plus, where the
// caller has it, the date it was last used. An Agent reading a project knows
// it is temporary from `temporary: true`, never from these words.

const TEMPORARY_ID = /^(temporary|conversation)-([0-9a-f]{64})$/;
// The names FULI generated for a temporary project before graph/23 cleared
// them. A graph still waiting for that migration serves them, and they say
// nothing about which project it is, so they are never shown as a title.
const GENERATED_NAMES = new Set([
  '临时任务 / Temporary task', '临时会话 / Temporary session', '会话项目 / Conversation project'
]);
const NUMBER_LENGTH = 8;
const WORDS = Object.freeze({
  'zh-CN': { temporary: '临时项目', dated: (name, time) => `${name} · ${time}` },
  'en-US': { temporary: 'Temporary project', dated: (name, time) => `${name} · ${time}` }
});

/** A project FULI opened by itself, by where it came from and never by its name. */
export function isTemporaryProject(project) {
  if (!project) return false;
  return project.scope_type === 'temporary'
    || project.profile?.origin === 'conversation_fallback'
    || TEMPORARY_ID.test(project.project_id ?? project.id ?? '');
}

/** The title a person or an Agent gave this project, or '' where only FULI named it. */
export function givenProjectTitle(project) {
  const name = (project?.profile?.name ?? project?.name ?? '').trim();
  return GENERATED_NAMES.has(name) ? '' : name;
}

/**
 * A temporary project's short number: the first characters of the digest in its
 * generated ID, so the console shows the same number for the same project
 * (web/src/features/projects/temporary-project-name.ts).
 */
export function temporaryProjectNumber(projectId) {
  const digest = TEMPORARY_ID.exec(projectId ?? '')?.[2];
  return digest ? digest.slice(0, NUMBER_LENGTH) : null;
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
  const number = temporaryProjectNumber(id);
  const name = number ? `${words.temporary} #${number}` : words.temporary;
  const time = lastUseDate(project, language);
  return time ? words.dated(name, time) : name;
}

function lastUseDate(project, language) {
  const at = Date.parse(project?.updated_at ?? project?.created_at ?? '');
  if (!at) return '';
  try {
    return new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' }).format(at);
  } catch { return ''; }
}

/** The person's language for a caller that holds the application, not a setting. */
export function applicationLanguage(application) {
  try { return consoleLanguage(application?.flaMenuSettings?.()?.language ?? ''); }
  catch { return consoleLanguage(''); }
}
