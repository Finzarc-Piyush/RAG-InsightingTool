import test from "node:test";
import assert from "node:assert/strict";
import { parseFilenameFromContentDisposition } from "./parseContentDispositionFilename.ts";

test("quoted filename stops at closing quote before other params", () => {
  const h = 'attachment; filename="a.xlsx"; size=123';
  assert.equal(parseFilenameFromContentDisposition(h), "a.xlsx");
});

test("unquoted filename token", () => {
  assert.equal(
    parseFilenameFromContentDisposition("attachment; filename=report.csv"),
    "report.csv"
  );
});

test("null and empty", () => {
  assert.equal(parseFilenameFromContentDisposition(null), null);
  assert.equal(parseFilenameFromContentDisposition(""), null);
});
