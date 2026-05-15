/**
 * Wave DR7b · pure helpers for search / scope / sort over the dashboard
 * list. Kept outside the component so they can be unit-tested without a
 * DOM.
 */

export type DashboardScope = "all" | "owned" | "shared";
export type DashboardSort = "updated" | "created" | "name";

export interface DashboardListItem {
  id: string;
  name: string;
  isShared?: boolean;
  hasCollaborators?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FilterArgs {
  query: string;
  scope: DashboardScope;
  sort: DashboardSort;
}

export function filterAndSortDashboards<T extends DashboardListItem>(
  list: T[],
  { query, scope, sort }: FilterArgs,
): T[] {
  const trimmed = query.trim().toLowerCase();
  const filtered = list.filter((d) => {
    if (scope === "owned" && d.isShared) return false;
    if (scope === "shared" && !d.isShared) return false;
    if (trimmed && !d.name.toLowerCase().includes(trimmed)) return false;
    return true;
  });
  return filtered.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "created") return b.createdAt.getTime() - a.createdAt.getTime();
    // default updated, desc
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}
