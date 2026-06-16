// CICD-7 · DOM smoke test — proves the jsdom environment and
// @testing-library/react render path are wired up so the vitest suite is
// non-empty and a real DOM is available to future component tests.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

describe("DOM smoke", () => {
  it("renders a trivial element into the document", () => {
    render(<div data-testid="smoke">hello</div>);
    const el = screen.getByTestId("smoke");
    expect(el).toBeTruthy();
    expect(el.textContent).toBe("hello");
    expect(document.body.contains(el)).toBe(true);
  });
});
