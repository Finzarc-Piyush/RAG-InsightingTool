/**
 * Wave W41 · streaming JSON field extractor
 *
 * The W38 streaming narrator emits raw JSON tokens to the client via
 * `answer_chunk` SSE events: `{"body":"Saffola lost...`. The client
 * accumulates these into `streamingNarratorPreview`, which renders as
 * unreadable JSON garbage.
 *
 * This helper consumes the same chunks via `process(delta)` and returns
 * ONLY the new text from a single named string field's value, with JSON
 * escapes (`\"`, `\n`, `\t`, `\\`, etc.) decoded back to their plain-text
 * equivalents. Suitable for narrator's `body` field — the user-facing
 * prose — so the live "Drafting answer…" preview shows actual text.
 *
 * State machine:
 *   - `pre`  → buffering until we see `"<fieldName>":` followed by `"`
 *   - `in`   → emitting text, watching for unescaped close `"`
 *   - `done` → close quote seen; subsequent calls return ""
 *
 * Robustness contract: this helper NEVER throws. Every malformed-input
 * case results in either no emission (silently stuck in `pre`) or an
 * early transition to `done`. The full-message Zod validation in
 * `completeJsonStreaming` is the authoritative correctness gate;
 * extraction is best-effort UX, never a correctness path.
 *
 * Pure-logic. No I/O. Importable from anywhere.
 */

type State = "pre" | "in" | "done";

const ESCAPE_MAP: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Decode a JSON-escaped fragment to plain text. Unicode escapes
 * (`\uXXXX`) are NOT decoded — they pass through as the raw 6 chars.
 * Acceptable for narrator output where unicode is rare; can be lifted
 * in a follow-up wave.
 */
function decodeJsonStringFragment(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    // Backslash; need at least one more char to know what to do.
    if (i + 1 >= s.length) {
      // Trailing backslash — caller buffered too few chars; safe to drop.
      break;
    }
    const next = s[i + 1];
    if (next === "u") {
      // Pass `\uXXXX` through as-is. Future wave can decode.
      if (i + 6 <= s.length) {
        out += s.slice(i, i + 6);
        i += 6;
        continue;
      }
      // Truncated unicode escape; drop it.
      break;
    }
    const decoded = ESCAPE_MAP[next];
    if (decoded !== undefined) {
      out += decoded;
      i += 2;
      continue;
    }
    // Unknown escape — emit verbatim and advance one byte.
    out += c;
    i++;
  }
  return out;
}

/**
 * Find the first index in `buf` (starting at `from`) of an UNESCAPED `"`.
 * Returns the index of the `"` itself, or -1 if not found within `buf`.
 *
 * "Unescaped" means: count consecutive backslashes immediately preceding
 * the `"`. Even count → unescaped → terminator. Odd count → escaped →
 * keep scanning.
 */
function findUnescapedClose(buf: string, from: number): number {
  let i = from;
  while (i < buf.length) {
    const c = buf[i];
    if (c === '"') {
      // Count preceding backslashes.
      let bs = 0;
      let j = i - 1;
      while (j >= from && buf[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Consume streaming JSON chunks; emit ONLY the named field's string
 * value as plain decoded text. Construct one extractor per logical
 * stream (one per narrator call).
 */
export class JsonFieldStreamExtractor {
  private fieldName: string;
  private buffer = "";
  private state: State = "pre";
  /** Index into `buffer` after which content has been emitted (in-state). */
  private emittedThrough = 0;
  /** Index where the in-string content begins (just past the opening quote). */
  private inStringStart = -1;

  constructor(fieldName: string) {
    this.fieldName = fieldName;
  }

  /**
   * Feed in the next chunk. Returns the decoded plain text for any
   * NEW characters that fall inside the target field's value. Returns
   * `""` when:
   *   - state is `pre` and the opener hasn't fully arrived,
   *   - state is `done` and there's nothing more to emit,
   *   - the buffered chunk ends mid-escape (we wait for completion).
   */
  process(delta: string): string {
    if (!delta) return "";
    this.buffer += delta;

    if (this.state === "pre") {
      this.tryEnterInState();
      // TS doesn't track the mutation inside `tryEnterInState`, so use
      // a fresh read of `this.state` (cast via accessor) to branch.
      const after = this.state as State;
      if (after !== "in") return "";
    }

    if ((this.state as State) === "in") {
      return this.emitInStateText();
    }

    return "";
  }

  /** True once we've seen the opening of the target field. */
  hasStarted(): boolean {
    return this.state !== "pre";
  }

  /** True once we've seen the closing quote of the target field. */
  isDone(): boolean {
    return this.state === "done";
  }

  // ── internals ──────────────────────────────────────────────────

  /**
   * Search the buffer for `"<fieldName>"` followed by `:` (with optional
   * whitespace) followed by `"`. When found, transition to `in` and
   * record where the string content starts.
   */
  private tryEnterInState(): void {
    const needle = `"${this.fieldName}"`;
    const fieldIdx = this.buffer.indexOf(needle);
    if (fieldIdx === -1) return;
    let i = fieldIdx + needle.length;
    // Skip whitespace.
    while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
    if (i >= this.buffer.length) return;
    if (this.buffer[i] !== ":") {
      // Spurious match (e.g. `"body"` appears as a value somewhere);
      // skip past it so we keep looking on the next call.
      // We can't safely advance `fieldIdx` past one occurrence here
      // without re-running the search; cheapest correct option is to
      // stay in `pre` and let the caller's next chunk re-trigger.
      return;
    }
    i++;
    while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
    if (i >= this.buffer.length) return;
    if (this.buffer[i] !== '"') {
      // Field exists but value isn't a string (e.g. it's `null` or a
      // number). Mark done — this extractor only handles string fields.
      this.state = "done";
      return;
    }
    // Found the opening quote; content begins at i + 1.
    this.state = "in";
    this.inStringStart = i + 1;
    this.emittedThrough = this.inStringStart;
  }

  /**
   * Walk forward from `emittedThrough` looking for the closing
   * unescaped `"`. Emit decoded text up to that point (or up to the
   * end of the buffer if we haven't found it yet).
   *
   * Carefully avoids emitting a fragment that ends mid-escape — if
   * the last char of the available text is `\`, we hold it back and
   * wait for the next chunk before deciding what to emit.
   */
  private emitInStateText(): string {
    const closeIdx = findUnescapedClose(this.buffer, this.emittedThrough);
    if (closeIdx >= 0) {
      const raw = this.buffer.slice(this.emittedThrough, closeIdx);
      this.emittedThrough = closeIdx + 1;
      this.state = "done";
      return decodeJsonStringFragment(raw);
    }
    // No close yet — emit everything we've got, but if the buffer ends
    // with an unfinished escape (a lone `\`, or `\u` short of 4 hex
    // chars), hold those trailing bytes back so we don't garble the
    // decode.
    let safeEnd = this.buffer.length;
    // Hold back a trailing lone backslash.
    if (safeEnd > this.emittedThrough && this.buffer[safeEnd - 1] === "\\") {
      // Make sure it's not the END of an even-length escape (e.g. `\\`).
      let bs = 0;
      let j = safeEnd - 1;
      while (j >= this.emittedThrough && this.buffer[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 1) safeEnd--;
    }
    // Hold back a partial `\uXXXX`.
    const tail = this.buffer.slice(Math.max(0, safeEnd - 6), safeEnd);
    const uMatch = tail.match(/\\u[0-9a-fA-F]{0,3}$/);
    if (uMatch) {
      safeEnd -= uMatch[0].length;
    }
    if (safeEnd <= this.emittedThrough) return "";
    const raw = this.buffer.slice(this.emittedThrough, safeEnd);
    this.emittedThrough = safeEnd;
    return decodeJsonStringFragment(raw);
  }
}
