/**
 * Wave W61-filter-persist · URL-state sync helper coverage.
 *
 * Pure functions: `readFilterFromSearch(search)` parses a URL search
 * string and validates the `?filter=X` param against the closed
 * filter vocabulary; `writeFilterToSearch(search, filter)` returns
 * the updated search string (param removed for the `"all"` default
 * so the URL stays clean).
 *
 * The page-component glue (lazy `useState` init + `replaceState`
 * sync `useEffect`) is verified indirectly via these pins: any
 * future drift in the param contract lands here first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FILTER_PARAM_NAME,
  readFilterFromSearch,
  writeFilterToSearch,
} from "./semanticModelFilterUrlSync.js";

test("W61-filter-persist · FILTER_PARAM_NAME: short 5-char name 'filter'", () => {
  // The param name is documented as deliberately terse — admins copy
  // URLs frequently and "?filter=user" reads cleaner than
  // "?source_filter=user".
  assert.equal(FILTER_PARAM_NAME, "filter");
});

test("W61-filter-persist · readFilterFromSearch: empty string → 'all'", () => {
  assert.equal(readFilterFromSearch(""), "all");
});

test("W61-filter-persist · readFilterFromSearch: '?' alone → 'all'", () => {
  assert.equal(readFilterFromSearch("?"), "all");
});

test("W61-filter-persist · readFilterFromSearch: no filter param → 'all'", () => {
  assert.equal(readFilterFromSearch("?other=x"), "all");
});

test("W61-filter-persist · readFilterFromSearch: '?filter=user' → 'user'", () => {
  assert.equal(readFilterFromSearch("?filter=user"), "user");
});

test("W61-filter-persist · readFilterFromSearch: '?filter=auto' → 'auto'", () => {
  assert.equal(readFilterFromSearch("?filter=auto"), "auto");
});

test("W61-filter-persist · readFilterFromSearch: '?filter=domain' → 'domain'", () => {
  assert.equal(readFilterFromSearch("?filter=domain"), "domain");
});

test("W61-filter-persist · readFilterFromSearch: '?filter=all' → 'all'", () => {
  assert.equal(readFilterFromSearch("?filter=all"), "all");
});

test("W61-filter-persist · readFilterFromSearch: leading '?' optional", () => {
  // Both `window.location.search` (which starts with '?') and a
  // raw param string should parse identically.
  assert.equal(readFilterFromSearch("filter=user"), "user");
  assert.equal(readFilterFromSearch("?filter=user"), "user");
});

test("W61-filter-persist · readFilterFromSearch: invalid value → 'all'", () => {
  // Admin pastes a malformed link or types in the wrong value
  // manually — fall back to the safe default rather than crashing.
  assert.equal(readFilterFromSearch("?filter=banana"), "all");
});

test("W61-filter-persist · readFilterFromSearch: empty value → 'all'", () => {
  assert.equal(readFilterFromSearch("?filter="), "all");
});

test("W61-filter-persist · readFilterFromSearch: case-sensitive (USER does NOT match 'user')", () => {
  // URL params are byte-stable; admins copy URLs from browsers
  // which preserve case. A mis-case match would silently flip
  // the filter to a value the user didn't intend.
  assert.equal(readFilterFromSearch("?filter=USER"), "all");
  assert.equal(readFilterFromSearch("?filter=User"), "all");
});

test("W61-filter-persist · readFilterFromSearch: extra params don't interfere", () => {
  assert.equal(
    readFilterFromSearch("?other=x&filter=user&another=y"),
    "user",
  );
});

test("W61-filter-persist · readFilterFromSearch: duplicate filter param picks first", () => {
  // URLSearchParams.get returns the first occurrence — defines
  // the contract clearly for the edge case of admin-crafted URLs.
  assert.equal(readFilterFromSearch("?filter=user&filter=auto"), "user");
});

test("W61-filter-persist · writeFilterToSearch: empty + 'all' → empty (clean URL)", () => {
  // The default state writes nothing — URL stays at "/admin/semantic-models/X"
  // not "/admin/semantic-models/X?filter=all" which would be noise.
  assert.equal(writeFilterToSearch("", "all"), "");
});

test("W61-filter-persist · writeFilterToSearch: empty + 'user' → 'filter=user'", () => {
  assert.equal(writeFilterToSearch("", "user"), "filter=user");
});

test("W61-filter-persist · writeFilterToSearch: empty + 'auto' → 'filter=auto'", () => {
  assert.equal(writeFilterToSearch("", "auto"), "filter=auto");
});

test("W61-filter-persist · writeFilterToSearch: empty + 'domain' → 'filter=domain'", () => {
  assert.equal(writeFilterToSearch("", "domain"), "filter=domain");
});

test("W61-filter-persist · writeFilterToSearch: 'all' removes pre-existing filter param", () => {
  assert.equal(writeFilterToSearch("?filter=user", "all"), "");
});

test("W61-filter-persist · writeFilterToSearch: replaces existing filter value", () => {
  assert.equal(writeFilterToSearch("?filter=user", "auto"), "filter=auto");
});

test("W61-filter-persist · writeFilterToSearch: preserves other params on set", () => {
  const out = writeFilterToSearch("?other=x&another=y", "user");
  // Param order from URLSearchParams.toString() preserves insertion
  // order with the new filter param appended last.
  assert.ok(out.includes("other=x"));
  assert.ok(out.includes("another=y"));
  assert.ok(out.includes("filter=user"));
});

test("W61-filter-persist · writeFilterToSearch: preserves other params on 'all' (filter removed, rest stay)", () => {
  const out = writeFilterToSearch("?other=x&filter=user&another=y", "all");
  assert.ok(out.includes("other=x"));
  assert.ok(out.includes("another=y"));
  assert.ok(!out.includes("filter="));
});

test("W61-filter-persist · writeFilterToSearch: leading '?' optional on input", () => {
  // Mirror of readFilterFromSearch's contract — both with and
  // without the leading '?' parse cleanly.
  assert.equal(writeFilterToSearch("filter=user", "auto"), "filter=auto");
  assert.equal(writeFilterToSearch("?filter=user", "auto"), "filter=auto");
});

test("W61-filter-persist · writeFilterToSearch: output never starts with '?' (caller prepends)", () => {
  // The caller's `history.replaceState` call wants to control the
  // leading-? semantics (empty string → no query, otherwise
  // "?" + result). Returning a leading '?' from this function would
  // make the empty-case ambiguous.
  const cases = [
    writeFilterToSearch("", "user"),
    writeFilterToSearch("?other=x", "auto"),
    writeFilterToSearch("?filter=user", "all"),
  ];
  for (const out of cases) {
    assert.ok(!out.startsWith("?"), `output should not start with '?': "${out}"`);
  }
});

test("W61-filter-persist · round-trip: write then read returns the original filter", () => {
  // The contract that admin-shared URLs work: serialise the filter
  // via writeFilterToSearch, deserialise via readFilterFromSearch,
  // get back the same filter.
  for (const filter of ["all", "user", "auto", "domain"] as const) {
    const search = writeFilterToSearch("", filter);
    const prefixed = search ? "?" + search : "";
    assert.equal(readFilterFromSearch(prefixed), filter);
  }
});

test("W61-filter-persist · round-trip preserves other params alongside the filter", () => {
  const initial = "?other=x&another=y";
  const written = writeFilterToSearch(initial, "user");
  const prefixed = "?" + written;
  assert.equal(readFilterFromSearch(prefixed), "user");
  // The non-filter params are still there.
  const parsed = new URLSearchParams(written);
  assert.equal(parsed.get("other"), "x");
  assert.equal(parsed.get("another"), "y");
});
