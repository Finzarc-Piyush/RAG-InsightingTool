import { describe, expect, test } from "vitest";
import { clickHitsInteractiveDescendant } from "./chartBodyExpand";

/**
 * Regression for the click-to-expand bug: the chart-body container carries
 * `role="button"` for a11y, and `Element.closest` matches the element itself,
 * so a naive guard suppressed expand on EVERY click. The predicate must return
 * false for a plain click inside the container (so expand fires) while still
 * returning true for genuine interactive descendants.
 */
describe("clickHitsInteractiveDescendant", () => {
  function makeContainer(): HTMLElement {
    const container = document.createElement("div");
    container.setAttribute("role", "button"); // the a11y attr that caused the bug
    document.body.appendChild(container);
    return container;
  }

  test("returns FALSE for a plain element inside the role=button container (expand should fire)", () => {
    const container = makeContainer();
    const svgPath = document.createElement("span"); // stand-in for a chart svg node
    container.appendChild(svgPath);
    expect(clickHitsInteractiveDescendant(svgPath, container)).toBe(false);
  });

  test("returns FALSE when the target IS the container itself", () => {
    const container = makeContainer();
    expect(clickHitsInteractiveDescendant(container, container)).toBe(false);
  });

  test("returns TRUE for a real button descendant", () => {
    const container = makeContainer();
    const btn = document.createElement("button");
    container.appendChild(btn);
    expect(clickHitsInteractiveDescendant(btn, container)).toBe(true);
  });

  test("returns TRUE for a filter-control descendant (and its children)", () => {
    const container = makeContainer();
    const filter = document.createElement("div");
    filter.setAttribute("data-chart-filter-control", "true");
    const inner = document.createElement("span");
    filter.appendChild(inner);
    container.appendChild(filter);
    expect(clickHitsInteractiveDescendant(filter, container)).toBe(true);
    expect(clickHitsInteractiveDescendant(inner, container)).toBe(true);
  });

  test("returns TRUE for a link / input descendant", () => {
    const container = makeContainer();
    const link = document.createElement("a");
    const input = document.createElement("input");
    container.appendChild(link);
    container.appendChild(input);
    expect(clickHitsInteractiveDescendant(link, container)).toBe(true);
    expect(clickHitsInteractiveDescendant(input, container)).toBe(true);
  });
});
