import { describe, expect, it } from "vitest";
import {
  filterAndSortDashboards,
  type DashboardListItem,
} from "./dashboardListFilters";

const items: DashboardListItem[] = [
  {
    id: "1",
    name: "Alpha",
    isShared: false,
    createdAt: new Date(2025, 0, 1),
    updatedAt: new Date(2025, 5, 1),
  },
  {
    id: "2",
    name: "Beta shared",
    isShared: true,
    createdAt: new Date(2025, 1, 1),
    updatedAt: new Date(2025, 4, 1),
  },
  {
    id: "3",
    name: "Charlie",
    isShared: false,
    createdAt: new Date(2025, 2, 1),
    updatedAt: new Date(2025, 6, 1),
  },
];

describe("filterAndSortDashboards", () => {
  it("filters by scope=owned (excludes shared)", () => {
    const out = filterAndSortDashboards(items, {
      query: "",
      scope: "owned",
      sort: "name",
    });
    expect(out.map((d) => d.name)).toEqual(["Alpha", "Charlie"]);
  });

  it("filters by scope=shared (only shared)", () => {
    const out = filterAndSortDashboards(items, {
      query: "",
      scope: "shared",
      sort: "name",
    });
    expect(out.map((d) => d.name)).toEqual(["Beta shared"]);
  });

  it("scope=all returns every dashboard", () => {
    const out = filterAndSortDashboards(items, {
      query: "",
      scope: "all",
      sort: "name",
    });
    expect(out).toHaveLength(3);
  });

  it("search is case-insensitive substring match", () => {
    const out = filterAndSortDashboards(items, {
      query: "BETA",
      scope: "all",
      sort: "name",
    });
    expect(out.map((d) => d.name)).toEqual(["Beta shared"]);
  });

  it("sort=updated returns most-recent first", () => {
    const out = filterAndSortDashboards(items, {
      query: "",
      scope: "all",
      sort: "updated",
    });
    expect(out.map((d) => d.id)).toEqual(["3", "1", "2"]);
  });

  it("sort=created returns most-recent created first", () => {
    const out = filterAndSortDashboards(items, {
      query: "",
      scope: "all",
      sort: "created",
    });
    expect(out.map((d) => d.id)).toEqual(["3", "2", "1"]);
  });

  it("does not mutate the input list", () => {
    const before = items.map((d) => d.id);
    filterAndSortDashboards(items, {
      query: "",
      scope: "all",
      sort: "updated",
    });
    expect(items.map((d) => d.id)).toEqual(before);
  });

  it("returns [] when nothing matches", () => {
    const out = filterAndSortDashboards(items, {
      query: "no-such-name",
      scope: "all",
      sort: "name",
    });
    expect(out).toEqual([]);
  });
});
