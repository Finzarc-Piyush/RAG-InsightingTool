/**
 * featureFlags — the typed feature-flag registry + accessor. Asserts the
 * registry is non-empty and that `isFlagOn` honours both the env value
 * (case-insensitively) and each flag's registered default polarity.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_FLAGS,
  isFlagOn,
  listFlags,
  flagDefault,
} from "../lib/featureFlags.js";
import type { FlagName } from "../lib/featureFlags.js";

/** Run `fn` with `process.env[name]` set to `value`, restoring afterwards. */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prior = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

describe("featureFlags · registry shape", () => {
  it("is non-empty and well-formed", () => {
    const names = Object.keys(FEATURE_FLAGS) as FlagName[];
    assert.ok(names.length > 0, "registry must enumerate flags");
    assert.ok(names.length >= 20, `expected ~28 flags, got ${names.length}`);
    for (const name of names) {
      const spec = FEATURE_FLAGS[name];
      assert.equal(typeof spec.default, "boolean", `${name}.default`);
      assert.equal(typeof spec.purpose, "string", `${name}.purpose`);
      assert.ok(spec.purpose.length > 0, `${name}.purpose non-empty`);
      assert.ok(
        ["stable", "experimental", "deprecated"].includes(spec.lifecycle),
        `${name}.lifecycle`
      );
    }
  });

  it("listFlags() returns one sorted row per flag", () => {
    const rows = listFlags();
    assert.equal(rows.length, Object.keys(FEATURE_FLAGS).length);
    const names = rows.map((r) => r.name);
    assert.deepEqual(names, [...names].sort(), "rows sorted by name");
    for (const r of rows) {
      assert.equal(r.default, FEATURE_FLAGS[r.name].default);
      assert.equal(r.purpose, FEATURE_FLAGS[r.name].purpose);
    }
  });
});

describe("featureFlags · isFlagOn honours default + env", () => {
  it("returns the registered default when the env var is unset", () => {
    for (const name of Object.keys(FEATURE_FLAGS) as FlagName[]) {
      withEnv(name, undefined, () => {
        assert.equal(isFlagOn(name), flagDefault(name), `${name} unset → default`);
      });
    }
  });

  it("a default-OFF flag turns on for 1/true/yes/on (case-insensitive)", () => {
    const offFlag = (Object.keys(FEATURE_FLAGS) as FlagName[]).find(
      (n) => FEATURE_FLAGS[n].default === false
    )!;
    assert.ok(offFlag, "registry has a default-OFF flag");
    for (const v of ["1", "true", "TRUE", "Yes", " on "]) {
      withEnv(offFlag, v, () =>
        assert.equal(isFlagOn(offFlag), true, `${offFlag}=${v} → on`)
      );
    }
    for (const v of ["", "0", "false", "False", "no", "off"]) {
      withEnv(offFlag, v, () =>
        assert.equal(isFlagOn(offFlag), false, `${offFlag}=${v} → off`)
      );
    }
  });

  it("a default-ON flag turns off only for 0/false/no/off (case-insensitive)", () => {
    const onFlag = (Object.keys(FEATURE_FLAGS) as FlagName[]).find(
      (n) => FEATURE_FLAGS[n].default === true
    )!;
    assert.ok(onFlag, "registry has a default-ON flag");
    for (const v of ["0", "false", "FALSE", "no", "off"]) {
      withEnv(onFlag, v, () =>
        assert.equal(isFlagOn(onFlag), false, `${onFlag}=${v} → off`)
      );
    }
    for (const v of ["true", "anything", "1"]) {
      withEnv(onFlag, v, () =>
        assert.equal(isFlagOn(onFlag), true, `${onFlag}=${v} → on`)
      );
    }
  });

  it("specific known flags carry their expected polarity", () => {
    assert.equal(FEATURE_FLAGS.AGENTIC_LOOP_ENABLED.default, false);
    assert.equal(FEATURE_FLAGS.BUSINESS_ACTIONS_ENABLED.default, true);
    assert.equal(FEATURE_FLAGS.QUICK_LOOKUP_ENABLED.default, true);
    // W-WEB · flipped to default-ON (free providers, no key, graceful fallback).
    assert.equal(FEATURE_FLAGS.WEB_SEARCH_ENABLED.default, true);
  });
});
