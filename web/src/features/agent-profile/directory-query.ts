import type { LocationQuery, LocationQueryRaw } from "vue-router";

export const DIRECTORY_STATUSES = ["all", "active", "inactive", "archived"] as const;
export type DirectoryStatus = (typeof DIRECTORY_STATUSES)[number];
export const DIRECTORY_VIEWS = ["agents", "projects"] as const;
export type DirectoryView = (typeof DIRECTORY_VIEWS)[number];
export const DIRECTORY_SORTS = ["recent", "name"] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export interface DirectoryFilters {
  search: string;
  projects: string[];
  status: DirectoryStatus;
  view: DirectoryView;
  sort: DirectorySort;
}

const FILTER_KEYS = ["q", "project", "status", "view", "sort"] as const;

function strings(value: LocationQuery[string]) {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === "string" && item !== "");
}

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
}

/** Read directory filters from the URL; unknown values fall back to defaults. */
export function readDirectoryFilters(query: LocationQuery): DirectoryFilters {
  return {
    search: strings(query.q)[0] ?? "",
    projects: [...new Set(strings(query.project))],
    status: oneOf(DIRECTORY_STATUSES, strings(query.status)[0], "all"),
    view: oneOf(DIRECTORY_VIEWS, strings(query.view)[0], "agents"),
    sort: oneOf(DIRECTORY_SORTS, strings(query.sort)[0], "recent"),
  };
}

/** Write filters into the URL, keeping every unrelated query key. */
export function directoryFilterQuery(
  query: LocationQuery,
  filters: DirectoryFilters,
): LocationQueryRaw {
  const next: LocationQueryRaw = Object.fromEntries(
    Object.entries(query).filter(([key]) => !(FILTER_KEYS as readonly string[]).includes(key)),
  );
  const search = filters.search.trim();
  if (search) next.q = search;
  if (filters.projects.length) next.project = [...filters.projects];
  if (filters.status !== "all") next.status = filters.status;
  if (filters.view !== "agents") next.view = filters.view;
  if (filters.sort !== "recent") next.sort = filters.sort;
  return next;
}

export function sameDirectoryFilters(a: DirectoryFilters, b: DirectoryFilters) {
  return (
    a.search.trim() === b.search.trim() &&
    a.status === b.status &&
    a.view === b.view &&
    a.sort === b.sort &&
    a.projects.length === b.projects.length &&
    a.projects.every((id, index) => id === b.projects[index])
  );
}
