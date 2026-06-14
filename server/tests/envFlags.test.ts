/**
 * envFlags — shared env-flag parsing. Pins the case-insensitive truthiness that
 * fixes the BUSINESS_ACTIONS_ENABLED live-vs-replay fork, and the int parser
 * that replaced the cloned `num()` helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  envInt,
  envFlagOn,
  envFlagEnabledByDefault,
  isBusinessActionsEnabled,
} from "../lib/envFlags.js";

describe("envFlags · envInt", () => {
  it("parses integers and falls back on unset / non-numeric", () => {
    assert.equal(envInt("30", 5), 30);
    assert.equal(envInt(undefined, 5), 5);
    assert.equal(envInt("", 5), 5);
    assert.equal(envInt("not-a-number", 5), 5);
    assert.equal(envInt("12abc", 5), 12); // parseInt semantics, as the old num()
  });
});

describe("envFlags · envFlagOn (default OFF)", () => {
  it("on only for 1/true/yes/on, case-insensitive", () => {
    for (const v of ["1", "true", "TRUE", "Yes", "on", " on "]) {
      assert.equal(envFlagOn(v), true, `on: ${v}`);
    }
    for (const v of [undefined, "", "0", "false", "False", "no", "off"]) {
      assert.equal(envFlagOn(v), false, `off: ${v}`);
    }
  });
});

describe("envFlags · envFlagEnabledByDefault (default ON)", () => {
  it("off only for 0/false/no/off (case-insensitive), on otherwise", () => {
    assert.equal(envFlagEnabledByDefault(undefined), true);
    assert.equal(envFlagEnabledByDefault("true"), true);
    assert.equal(envFlagEnabledByDefault("anything"), true);
    for (const v of ["0", "false", "False", "FALSE", "no", "off"]) {
      assert.equal(envFlagEnabledByDefault(v), false, `off: ${v}`);
    }
  });
});

describe("envFlags · isBusinessActionsEnabled", () => {
  it("is case-insensitive — `False` disables consistently (the fork it fixes)", () => {
    const prior = process.env.BUSINESS_ACTIONS_ENABLED;
    try {
      delete process.env.BUSINESS_ACTIONS_ENABLED;
      assert.equal(isBusinessActionsEnabled(), true, "default ON");
      process.env.BUSINESS_ACTIONS_ENABLED = "False";
      assert.equal(isBusinessActionsEnabled(), false, "`False` disables");
      process.env.BUSINESS_ACTIONS_ENABLED = "false";
      assert.equal(isBusinessActionsEnabled(), false, "`false` disables");
      process.env.BUSINESS_ACTIONS_ENABLED = "true";
      assert.equal(isBusinessActionsEnabled(), true);
    } finally {
      if (prior === undefined) delete process.env.BUSINESS_ACTIONS_ENABLED;
      else process.env.BUSINESS_ACTIONS_ENABLED = prior;
    }
  });
});
