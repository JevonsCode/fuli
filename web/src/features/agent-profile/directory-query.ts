import type { LocationQuery, LocationQueryRaw } from "vue-router";

export const DIRECTORY_STATUSES = ["all", "active", "inactive", "archived"] as const;
export type DirectoryStatus = (typeof DIRECTORY_STATUSES)[number];

export interface DirectoryFilters {
  search: string;
  projects: string[];
  status: DirectoryStatus;
}

const FILTER_KEYS = ["q", "project", "status"] as const;

function strings(value: LocationQuery[string]) {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === "string" && item !== "");
}

/** Read directory filters from the URL; unknown values fall back to defaults. */
export function readDirectoryFilters(query: LocationQuery): DirectoryFilters {
  const status = strings(query.status)[0];
  return {
    search: strings(query.q)[0] ?? "",
    projects: [...new Set(strings(query.project))],
    status: (DIRECTORY_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as DirectoryStatus)
      : "all",
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
  return next;
}

export function sameDirectoryFilters(a: DirectoryFilters, b: DirectoryFilters) {
  return (
    a.search.trim() === b.search.trim() &&
    a.status === b.status &&
    a.projects.length === b.projects.length &&
    a.projects.every((id, index) => id === b.projects[index])
  );
}
