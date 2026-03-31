import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preserveFinalPreview } from "../services/chat/previewRetention.js";

describe("preserveFinalPreview", () => {
  it("fills final preview from last intermediate when final preview is missing", () => {
    const transformedResponse: any = { answer: "ok", preview: undefined, summary: undefined };
    const pendingIntermediates = [
      { assistantTimestamp: 1, preview: [{ a: 1 }] },
      { assistantTimestamp: 2, preview: [{ b: 2 }] },
    ];

    preserveFinalPreview(transformedResponse, pendingIntermediates);

    assert.deepEqual(transformedResponse.preview, [{ b: 2 }]);
  });

  it("does not overwrite final preview when it already exists", () => {
    const transformedResponse: any = { answer: "ok", preview: [{ final: true }] };
    const pendingIntermediates = [
      { assistantTimestamp: 1, preview: [{ a: 1 }] },
      { assistantTimestamp: 2, preview: [{ b: 2 }] },
    ];

    preserveFinalPreview(transformedResponse, pendingIntermediates);

    assert.deepEqual(transformedResponse.preview, [{ final: true }]);
  });

  it("does nothing when pending intermediates have no preview rows", () => {
    const transformedResponse: any = { answer: "ok", preview: undefined };
    const pendingIntermediates = [{ assistantTimestamp: 1, preview: [] }];

    preserveFinalPreview(transformedResponse, pendingIntermediates);

    assert.equal(transformedResponse.preview, undefined);
  });
});

