// What the project layer of the capture settings means (rec#5 C2): which
// registered projects are recorded, what happens to work outside every
// registered project, and since when a project has not been recorded. Pure
// rules over the stored settings: capture-policy.js stores them and
// capture-decision.js applies them to each write.

import { deepFreeze, uniqueTextArray } from '../validation/values.js';

const PROJECT_MODES = Object.freeze(['all', 'all_except', 'selected']);
const UNREGISTERED_DIRECTORY_CHOICES = Object.freeze(['capture', 'skip']);
export const PROJECT_SETTING_KEYS = Object.freeze(['projectMode', 'excludedProjectIds', 'selectedProjectIds',
  'unregisteredDirectories']);

const MAX_LISTED_PROJECTS = 1000;
const MAX_PROJECT_ID_LENGTH = 256;

// Every project and every folder is recorded, as before project modes existed.
export const DEFAULT_PROJECT_SETTINGS = deepFreeze({ projectMode: 'all', excludedProjectIds: [],
  selectedProjectIds: [], unregisteredDirectories: 'capture', projectsOffSince: {}, unlistedProjectsOffSince: null });

// Recording only chosen projects leaves stray folders out unless the user says otherwise.
function defaultUnregisteredDirectories(projectMode) {
  return projectMode === 'selected' ? 'skip' : 'capture';
}

// The next project settings for a partial update. A mode switch that does not
// choose for unregistered directories takes that mode's default. Both lists are
// kept across mode switches, so switching back restores them; IDs are not
// checked against the registry, so an archived or deleted project may stay
// listed and applies again if the same project is registered again.
export function updatedProjectSettings(current, input, now) {
  const projectMode = input.projectMode === undefined ? current.projectMode
    : choice(input.projectMode, PROJECT_MODES, 'projectMode', TypeError);
  const next = {
    projectMode,
    excludedProjectIds: input.excludedProjectIds === undefined ? current.excludedProjectIds
      : projectIds(input.excludedProjectIds, 'excludedProjectIds', TypeError),
    selectedProjectIds: input.selectedProjectIds === undefined ? current.selectedProjectIds
      : projectIds(input.selectedProjectIds, 'selectedProjectIds', TypeError),
    unregisteredDirectories: input.unregisteredDirectories !== undefined
      ? choice(input.unregisteredDirectories, UNREGISTERED_DIRECTORY_CHOICES, 'unregisteredDirectories', TypeError)
      : projectMode === current.projectMode ? current.unregisteredDirectories : defaultUnregisteredDirectories(projectMode)
  };
  return { ...next, ...offSince(current, next, now) };
}

// Settings saved before project modes have none of these fields and record
// every project, as they did then.
export function storedProjectSettings(value, ErrorType) {
  const projectMode = choice(value.projectMode ?? DEFAULT_PROJECT_SETTINGS.projectMode, PROJECT_MODES,
    'projectMode', ErrorType);
  const projectsOffSince = value.projectsOffSince ?? {};
  if (!projectsOffSince || typeof projectsOffSince !== 'object' || Array.isArray(projectsOffSince)
    || Object.values(projectsOffSince).some(time => typeof time !== 'string')
    || (value.unlistedProjectsOffSince != null && typeof value.unlistedProjectsOffSince !== 'string')) {
    throw new ErrorType('Capture policy project switch-off times are invalid');
  }
  return {
    projectMode,
    excludedProjectIds: projectIds(value.excludedProjectIds ?? [], 'excludedProjectIds', ErrorType),
    selectedProjectIds: projectIds(value.selectedProjectIds ?? [], 'selectedProjectIds', ErrorType),
    unregisteredDirectories: choice(value.unregisteredDirectories ?? defaultUnregisteredDirectories(projectMode),
      UNREGISTERED_DIRECTORY_CHOICES, 'unregisteredDirectories', ErrorType),
    projectsOffSince: { ...projectsOffSince },
    unlistedProjectsOffSince: value.unlistedProjectsOffSince ?? null
  };
}

// Whether the project layer can stop a write, so a decision must know its
// project. Older FULI versions read only the global and client switches:
// settings that use project modes are saved in a format they refuse, so a
// downgrade records nothing instead of recording every project.
export function usesProjectModes(settings) {
  return settings.projectMode !== DEFAULT_PROJECT_SETTINGS.projectMode
    || settings.unregisteredDirectories !== DEFAULT_PROJECT_SETTINGS.unregisteredDirectories;
}

// project: { personalProjectId } for a registered project, { personalProjectId: null }
// for work outside every registered project, or null when it is not known.
export function projectCaptureReason(settings, project) {
  if (!usesProjectModes(settings)) return null;
  // A write FULI cannot place is never recorded by default (rec#5 C1-4).
  if (!project) return 'project_unregistered';
  if (!project.personalProjectId) return settings.unregisteredDirectories === 'skip' ? 'project_unregistered' : null;
  return projectOff(settings, project.personalProjectId) ? 'project_off' : null;
}

// When a project that is not recorded now stopped being recorded.
export function projectOffSince(settings, personalProjectId) {
  if (!projectOff(settings, personalProjectId)) return null;
  return settings.projectsOffSince[personalProjectId] ?? settings.unlistedProjectsOffSince;
}

function projectOff(settings, personalProjectId) {
  if (settings.projectMode === 'all_except') return settings.excludedProjectIds.includes(personalProjectId);
  if (settings.projectMode === 'selected') return !settings.selectedProjectIds.includes(personalProjectId);
  return false;
}

// A project that stays off keeps the time it first went off; one that goes
// off now gets now; one that is recorded again has none. Projects no setting
// names are off only in selected mode, from the moment that mode began.
function offSince(current, next, now) {
  const named = new Set([...current.excludedProjectIds, ...current.selectedProjectIds,
    ...Object.keys(current.projectsOffSince), ...next.excludedProjectIds, ...next.selectedProjectIds]);
  const projectsOffSince = {};
  for (const id of [...named].sort()) {
    if (projectOff(next, id)) projectsOffSince[id] = projectOffSince(current, id) ?? now;
  }
  const unlistedOff = next.projectMode === 'selected';
  return { projectsOffSince, unlistedProjectsOffSince: !unlistedOff ? null
    : current.projectMode === 'selected' ? current.unlistedProjectsOffSince ?? now : now };
}

function choice(value, choices, label, ErrorType) {
  if (!choices.includes(value)) throw new ErrorType(`Capture policy ${label} must be one of ${choices.join(', ')}`);
  return value;
}

// A project ID is one path segment, as the registry and directory matching use it.
function projectIds(value, label, ErrorType) {
  let ids;
  try {
    ids = uniqueTextArray(value, `Capture policy ${label}`, MAX_LISTED_PROJECTS);
  } catch (error) {
    throw new ErrorType(error.message);
  }
  if (ids.some(id => id.length > MAX_PROJECT_ID_LENGTH || /[\\/]/.test(id) || id === '.' || id === '..')) {
    throw new ErrorType(`Capture policy ${label} must list project IDs, not paths`);
  }
  return ids.sort();
}
