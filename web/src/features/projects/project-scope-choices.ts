import type { SelectOption } from '@/components/ui/select'
import { currentLocale, t } from '@/i18n'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import { shortUniqueIds } from '@/lib/short-ids'
import type { PersonalProject } from '@/types'
import { clientName } from '@/features/capture/capture-change'
import { byLastUse, hasTemporaryOrigin, projectDisplayName } from './project-origin'
import { NUMBER_LENGTH, givenProjectTitle, temporaryIdOrigin, temporaryNumberSource } from './temporary-project-name'
import { temporaryProjectSource } from './temporary-project-sources'

export interface ProjectScopeChoice<T extends PersonalProject = PersonalProject> {
  key: string
  project: T
  /** Formal: the person's name. Temporary: a short number bound to the project's ID. */
  label: string
  /** Temporary only, as far as recorded: the client that made it, last-use date and a title someone gave it. */
  detail: string
}

export interface ProjectScopeGroups<T extends PersonalProject = PersonalProject> {
  formal: ProjectScopeChoice<T>[]
  temporary: ProjectScopeChoice<T>[]
}

export const projectScopeKey = (project: Pick<PersonalProject, 'personal_space_id' | 'project_id'>) =>
  `${project.personal_space_id}/${project.project_id}`

/**
 * The projects a picker's caller offers, by where they came from (project-origin),
 * never by name. Each caller keeps its own rule for which projects it offers;
 * this only sorts them: projects people made in the given order, then temporary
 * ones most recent first. Nothing is dropped: an archived project the caller
 * offers stays in the group it came from, so an archived named project keeps its
 * name and is never filed as temporary. Short numbers are taken over every offered temporary project, so a
 * search, a refresh or another language keeps them.
 */
export function projectScopeGroups<T extends PersonalProject>(projects: readonly T[]): ProjectScopeGroups<T> {
  const temporary = projects.filter(hasTemporaryOrigin).sort(byLastUse)
  const formal = projects.filter(project => !hasTemporaryOrigin(project))
  const numbers = temporaryNumbers(temporary)
  return {
    formal: formal.map(project => ({ key: projectScopeKey(project), project, label: projectDisplayName(project), detail: '' })),
    temporary: temporary.map(project => ({
      key: projectScopeKey(project), project, label: `#${numbers.get(projectScopeKey(project))}`, detail: temporaryDetail(project),
    })),
  }
}

/**
 * The same groups as options of a single or multiple OptionCombobox, valued by
 * project ID: temporary projects under one heading that the combobox folds
 * (`foldGroup`). `formalExtras` keeps a caller's second line and search words
 * for named projects.
 */
export function projectScopeOptions(projects: readonly PersonalProject[], formalExtras?: (project: PersonalProject) => Pick<SelectOption, 'meta' | 'search'>): SelectOption[] {
  const { formal, temporary } = projectScopeGroups(projects)
  const group = temporaryGroupLabel()
  return [
    ...formal.map(choice => ({ value: choice.project.project_id, label: choice.label, ...formalExtras?.(choice.project) })),
    ...temporary.map(choice => ({ value: choice.project.project_id, label: choice.label, ...optionalMeta(choice.detail), group, search: choice.project.project_id })),
  ]
}

/** The heading temporary projects fold under, in the console's language. */
export function temporaryGroupLabel() {
  return t('projects.scopePicker.temporary')
}

/** A choice matches when its number, date, title or full ID contains the query. */
export function matchesProjectQuery(choice: ProjectScopeChoice, query: string) {
  const text = query.trim().toLowerCase()
  if (!text) return true
  return [choice.label, choice.detail, choice.project.project_id].some(value => value.toLowerCase().includes(text))
}

/** How many of a group are chosen, and its checkbox: all, none or part. */
export function groupSelection(choices: readonly ProjectScopeChoice[], selected: ReadonlySet<string>) {
  const count = choices.filter(choice => selected.has(choice.key)).length
  const state: boolean | 'indeterminate' = count === 0 ? false : count === choices.length ? true : 'indeterminate'
  return { count, total: choices.length, state }
}

const optionalMeta = (meta: string | undefined) => (meta ? { meta } : {})

/**
 * Each temporary project's short number, by its key: the shortest unique prefix of
 * the generated part of its ID. Two projects with the same generated part still get
 * different numbers: `-t` / `-c` when one is `temporary-` and the other
 * `conversation-`, and `@` with the space's short ID when the same ID is in two
 * personal spaces. Everything comes from the IDs, so order and language never change it.
 */
function temporaryNumbers(projects: readonly PersonalProject[]) {
  const digest = (project: PersonalProject) => temporaryNumberSource(project.project_id)
  const origin = (project: PersonalProject) => temporaryIdOrigin(project.project_id)
  const prefixes = shortestUnique([...new Set(projects.map(digest))])
  const spaces = shortUniqueIds([...new Set(projects.map(project => project.personal_space_id))])
  const numbers = new Map<string, string>()
  for (const project of projects) {
    const same = projects.filter(other => digest(other) === digest(project))
    const byOrigin = new Set(same.map(origin)).size > 1 ? `-${origin(project)}` : ''
    const bySpace = new Set(same.map(other => other.personal_space_id)).size > 1 ? `@${spaces.get(project.personal_space_id)}` : ''
    numbers.set(projectScopeKey(project), `${prefixes.get(digest(project))}${byOrigin}${bySpace}`)
  }
  return numbers
}

// Each value's shortest prefix of at least NUMBER_LENGTH characters that no other value starts with.
function shortestUnique(values: readonly string[]) {
  return new Map(values.map((value) => {
    let length = Math.min(NUMBER_LENGTH, value.length)
    while (length < value.length && values.some(other => other !== value && other.startsWith(value.slice(0, length)))) length += 1
    return [value, value.slice(0, length)]
  }))
}

function temporaryDetail(project: PersonalProject) {
  const source = temporaryProjectSource(project.personal_space_id, project.project_id)
  const date = formatDateTime(project.updated_at ?? project.created_at, currentLocale(), DATE_ONLY, { missing: '', invalid: '' })
  return [source ? clientName(source.client) : '', date, givenProjectTitle(project)].filter(Boolean).join(' · ')
}
