/**
 * Click-to-expand guard for the dashboard chart-tile body.
 *
 * A click anywhere on a chart tile's body opens the fullscreen modal — EXCEPT
 * when it lands on a genuinely interactive descendant (a filter control, a real
 * button/link, a form control) that should handle the click itself.
 *
 * The subtle bug this exists to prevent: the chart-body container carries
 * `role="button"` for a11y, and `Element.closest` matches the element itself
 * AND its ancestors. So a naive `target.closest('…, [role="button"]')` matches
 * the CONTAINER on every single click, suppressing expand entirely. The fix is
 * to ignore a match that IS the container — only a match BELOW it counts as an
 * interactive descendant.
 */
const INTERACTIVE_SELECTOR =
  '[data-chart-filter-control="true"], a, button, input, select, textarea, [role="button"]';

/**
 * True when the click target is (or is inside) an interactive descendant of
 * `container`. A match that is the container itself returns false — the
 * container's own `role="button"` must not block expand.
 */
export function clickHitsInteractiveDescendant(
  target: Element,
  container: Element,
): boolean {
  const interactive = target.closest(INTERACTIVE_SELECTOR);
  return interactive !== null && interactive !== container;
}
