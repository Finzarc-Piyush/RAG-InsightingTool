import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectPreviewRows,
  PREVIEW_ROWS,
  FULL_PREVIEW_CAP,
} from "../lib/activeFilter/selectPreviewRows.js";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

test("default mode caps at PREVIEW_ROWS (200)", () => {
  assert.equal(PREVIEW_ROWS, 200);
  const { preview, previewTruncated } = selectPreviewRows(rows(1000), false);
  assert.equal(preview.length, PREVIEW_ROWS);
  assert.equal(previewTruncated, true);
});

test("default mode returns everything when fewer rows than the cap", () => {
  const { preview, previewTruncated } = selectPreviewRows(rows(42), false);
  assert.equal(preview.length, 42);
  assert.equal(previewTruncated, false);
});

test("full mode returns up to FULL_PREVIEW_CAP and flags truncation", () => {
  const { preview, previewTruncated } = selectPreviewRows(
    rows(FULL_PREVIEW_CAP + 5),
    true
  );
  assert.equal(preview.length, FULL_PREVIEW_CAP);
  assert.equal(previewTruncated, true);
});

test("full mode returns all rows untruncated when under the cap", () => {
  const { preview, previewTruncated } = selectPreviewRows(rows(5000), true);
  assert.equal(preview.length, 5000);
  assert.equal(previewTruncated, false);
});

test("empty set is never truncated in either mode", () => {
  for (const full of [false, true]) {
    const { preview, previewTruncated } = selectPreviewRows([], full);
    assert.equal(preview.length, 0);
    assert.equal(previewTruncated, false);
  }
});

test("preview preserves row order and identity", () => {
  const src = rows(10);
  const { preview } = selectPreviewRows(src, false);
  assert.deepEqual(preview[0], { i: 0 });
  assert.equal(preview[9], src[9]);
});
