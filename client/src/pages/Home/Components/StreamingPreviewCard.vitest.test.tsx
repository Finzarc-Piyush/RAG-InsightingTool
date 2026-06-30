import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { StreamingPreviewCard } from "./StreamingPreviewCard";

afterEach(cleanup);

describe("StreamingPreviewCard · live-answer redesign", () => {
  it("renders the live stream with an intentional 'Answering live…' label", () => {
    const { getByText, getByLabelText, queryByText } = render(
      <StreamingPreviewCard previewText="Retailer margin is highest in GT…" isPending />,
    );
    expect(getByText("Answering live…")).toBeTruthy();
    expect(getByText("Retailer margin is highest in GT…")).toBeTruthy();
    expect(getByLabelText("Answering live")).toBeTruthy();
    // The old half-baked label must be gone.
    expect(queryByText(/Drafting answer/i)).toBeNull();
  });

  it("renders nothing when not pending", () => {
    const { container } = render(
      <StreamingPreviewCard previewText="something" isPending={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there is no preview text yet", () => {
    const { container } = render(
      <StreamingPreviewCard previewText="   " isPending />,
    );
    expect(container.firstChild).toBeNull();
  });
});
