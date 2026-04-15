import test from "node:test";
import assert from "node:assert/strict";
import { splitAssistantFollowUpPrompts } from "./splitAssistantFollowUpPrompts.ts";

test("no section returns full content", () => {
  const s = "Hello\n\n**Key insight:** x";
  const r = splitAssistantFollowUpPrompts(s);
  assert.equal(r.hadYouMightTrySection, false);
  assert.deepEqual(r.extractedPrompts, []);
  assert.equal(r.mainMarkdown, s);
});

test("trailing You might try with bullets", () => {
  const s =
    "Body here.\n\n**Key insight:** Regions differ.\n\n**You might try:**\n- First question?\n- Second one\n- Third";
  const r = splitAssistantFollowUpPrompts(s);
  assert.equal(r.hadYouMightTrySection, true);
  assert.deepEqual(r.extractedPrompts, ["First question?", "Second one", "Third"]);
  assert.equal(r.mainMarkdown, "Body here.\n\n**Key insight:** Regions differ.");
});

test("header casing You Might Try", () => {
  const s = "A\n\n**You Might Try:**\n- Q1";
  const r = splitAssistantFollowUpPrompts(s);
  assert.equal(r.hadYouMightTrySection, true);
  assert.deepEqual(r.extractedPrompts, ["Q1"]);
  assert.equal(r.mainMarkdown, "A");
});

test("blank lines between bullets", () => {
  const s = "Intro\n\n**You might try:**\n\n- A\n\n- B";
  const r = splitAssistantFollowUpPrompts(s);
  assert.deepEqual(r.extractedPrompts, ["A", "B"]);
});

test("uses last You might try header when multiple", () => {
  const s =
    "Note **You might try:** inline is not a header line\n\n**You might try:**\n- Real";
  const r = splitAssistantFollowUpPrompts(s);
  assert.deepEqual(r.extractedPrompts, ["Real"]);
  assert.ok(r.mainMarkdown.includes("inline"));
});
