/**
 * HERMETIC in-memory Cosmos `Container` double.
 *
 * Purpose: let integration tests that drive the chat-doc write path
 * (`mutateChatDocument` → `getChatBySessionIdEfficient` → `updateChatDocument`
 * IfMatch-`_etag` → 412 retry) run green in CI/dev WITHOUT a real Cosmos
 * account — which today makes those tests HANG on `waitForContainer()`'s retry
 * loop. A test injects the double via `__setContainerForTesting(...)` and every
 * chat.model / dataOps read+write routes through it.
 *
 * Faithfulness contract (verified against `@azure/cosmos` 4.7.0 SDK source):
 *  - `items.create(doc)`  → assigns `id` if absent, a fresh opaque `_etag` + `_ts`;
 *                           throws `{ code: 409 }` if (pk,id) already exists.
 *  - `items.upsert(doc)`  → create-or-replace; (re)assigns `_etag`+`_ts`. When
 *                           `requestOptions.accessCondition = {type:'IfMatch',condition}`
 *                           is supplied and the STORED `_etag` differs, throws
 *                           `{ code: 412 }` (matches `updateChatDocument`'s IfMatch).
 *  - `items.query(spec)`  → iterator with `.fetchAll()` and `.fetchNext()`;
 *                           parameterized specs `{query,parameters}` AND plain
 *                           string queries; cross-partition scan when no pk option.
 *  - `item(id,pk).read()` → returns `{ resource: undefined }` for not-found (the
 *                           real SDK SWALLOWS 404 on reads — confirmed in
 *                           Item.js#read); a WRONG pk also misses → undefined.
 *  - `item(id,pk).replace(doc, options?)` → throws `{ code: 404 }` if absent;
 *                           honours `accessCondition` IfMatch (412 on mismatch);
 *                           bumps `_etag`/`_ts`.
 *  - `item(id,pk).delete()` → throws `{ code: 404 }` if absent.
 *  - `item(id,pk).patch(ops)` → set/replace/add/remove/incr; throws `{code:404}`
 *                           if absent; bumps `_etag`.
 *
 * It is TEST infrastructure (lives under tests/, excluded from the runtime
 * build + the type-escape ratchet). A handful of `as` casts to the SDK
 * `Container` / response types are unavoidable because we implement a subset
 * of a very large structural interface — they are localised and documented.
 */
import type {
  Container,
  SqlQuerySpec,
  SqlParameter,
  PatchOperation,
} from "@azure/cosmos";

/** A stored document: arbitrary JSON object with Cosmos system fields. */
export type StoredDoc = Record<string, unknown> & {
  id?: string;
  _etag?: string;
  _ts?: number;
};

interface CosmosLikeError extends Error {
  code: number;
}

function cosmosError(code: number, message: string): CosmosLikeError {
  const err = new Error(message) as CosmosLikeError;
  err.code = code;
  return err;
}

// --- system-field stamping --------------------------------------------------

let etagSeq = 0;
/** Opaque, monotonically-changing etag — like Cosmos's GUID-ish `_etag`. */
function freshEtag(): string {
  etagSeq += 1;
  return `"im-etag-${etagSeq}-${Math.random().toString(36).slice(2, 8)}"`;
}

let idSeq = 0;
function freshId(): string {
  idSeq += 1;
  return `im-id-${idSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

let tsSeq = 0;
function nowTs(): number {
  // Cosmos `_ts` is epoch SECONDS. We add a strictly-increasing nudge so two
  // writes in the same wall-clock second still order deterministically under
  // ORDER BY c._ts (Cosmos itself only has second granularity, but tests want
  // a stable tiebreak).
  tsSeq += 1;
  return Math.floor(Date.now() / 1000) * 1000 + (tsSeq % 1000);
}

// =============================================================================
// SQL-subset query evaluator
// =============================================================================

type Comparator = "=" | "!=" | "<" | "<=" | ">" | ">=";

interface CmpCond {
  kind: "cmp";
  field: string; // e.g. "sessionId" (the part after "c.")
  op: Comparator;
  valueRef: ValueRef;
}
interface ArrayContainsFieldCond {
  // ARRAY_CONTAINS(c.arr, @p)  — field is an array, look for the param inside
  kind: "array_contains_field";
  field: string;
  valueRef: ValueRef;
}
interface ArrayContainsParamCond {
  // ARRAY_CONTAINS(@types, c.type) — param is an array, look for the field's value
  kind: "array_contains_param";
  paramName: string;
  field: string;
}
interface ContainsCond {
  // CONTAINS(c.fileName, @p) — substring match on a string field
  kind: "contains";
  field: string;
  valueRef: ValueRef;
}
interface TrueCond {
  kind: "true"; // `1=1`
}
type Leaf =
  | CmpCond
  | ArrayContainsFieldCond
  | ArrayContainsParamCond
  | ContainsCond
  | TrueCond;

interface AndOrNode {
  kind: "and" | "or";
  left: CondNode;
  right: CondNode;
}
type CondNode = Leaf | AndOrNode;

/** A literal value, or a `@param` reference resolved against the spec params. */
type ValueRef =
  | { ref: "param"; name: string }
  | { ref: "literal"; value: string | number | boolean };

interface ParsedQuery {
  projection:
    | { kind: "all" }
    | { kind: "fields"; fields: string[] }
    | { kind: "count" };
  where: CondNode | null;
  orderBy: { field: string; dir: "ASC" | "DESC" } | null;
  top: number | null;
  /** Raw OFFSET token: integer string or "@param", or null if no OFFSET clause. */
  offsetToken: string | null;
  /** Raw LIMIT token: integer string or "@param", or null if no LIMIT clause. */
  limitToken: string | null;
}

function unsupported(query: string, detail: string): never {
  throw new Error(
    `inMemoryCosmosContainer: unsupported query shape (${detail}). ` +
      `This double implements only the SQL subset the app uses — fail loud ` +
      `rather than silently wrong. Query was:\n${query}`,
  );
}

/** Strip a `c.` prefix off a field reference; error if not bound to the `c` alias. */
function fieldName(token: string, query: string): string {
  const m = token.match(/^c\.([A-Za-z0-9_]+)$/);
  if (!m) unsupported(query, `expected c.<field>, got '${token}'`);
  return m[1]!;
}

function parseValueRef(token: string, query: string): ValueRef {
  const t = token.trim();
  if (t.startsWith("@")) return { ref: "param", name: t };
  // string literal 'foo'
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return { ref: "literal", value: t.slice(1, -1) };
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return { ref: "literal", value: Number(t) };
  if (t === "true") return { ref: "literal", value: true };
  if (t === "false") return { ref: "literal", value: false };
  unsupported(query, `cannot parse value '${token}'`);
}

/**
 * Parse a flat AND/OR condition list. We support arbitrary AND/OR joins with
 * the documented leaf shapes; parentheses are tolerated around the whole
 * `(ARRAY_CONTAINS(...) OR c.x = @y)` group used by the chat queries.
 *
 * Strategy: tokenise on top-level AND / OR (respecting parens + function commas),
 * then fold left. AND/OR mixing folds left-to-right which is sufficient for the
 * app's queries (they are either all-AND or a single OR group ANDed with the
 * rest); we evaluate strictly per the parsed tree.
 */
function parseConditions(raw: string, query: string): CondNode {
  const text = raw.trim();
  // Split into tokens at top-level " AND " / " OR " (case-insensitive),
  // ignoring those inside parentheses.
  const parts: string[] = [];
  const ops: ("AND" | "OR")[] = [];
  let depth = 0;
  let buf = "";
  let i = 0;
  const upper = text.toUpperCase();
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0) {
      if (upper.startsWith(" AND ", i)) {
        parts.push(buf);
        ops.push("AND");
        buf = "";
        i += 5;
        continue;
      }
      if (upper.startsWith(" OR ", i)) {
        parts.push(buf);
        ops.push("OR");
        buf = "";
        i += 4;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  parts.push(buf);

  let node: CondNode = parseLeafOrGroup(parts[0]!, query);
  for (let k = 0; k < ops.length; k++) {
    const right = parseLeafOrGroup(parts[k + 1]!, query);
    node = { kind: ops[k] === "AND" ? "and" : "or", left: node, right };
  }
  return node;
}

function parseLeafOrGroup(rawToken: string, query: string): CondNode {
  let t = rawToken.trim();
  // Unwrap a fully-parenthesised group: "( ... )"
  if (t.startsWith("(") && t.endsWith(")")) {
    // Confirm the closing paren matches the opening one (not "(a) AND (b)").
    let depth = 0;
    let wraps = true;
    for (let j = 0; j < t.length; j++) {
      if (t[j] === "(") depth++;
      else if (t[j] === ")") {
        depth--;
        if (depth === 0 && j !== t.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (wraps) return parseConditions(t.slice(1, -1), query);
  }

  if (t === "1=1" || t === "1 = 1") return { kind: "true" };

  // ARRAY_CONTAINS( a , b )
  const acm = t.match(/^ARRAY_CONTAINS\s*\(([^)]*)\)$/i);
  if (acm) {
    const args = acm[1]!.split(",").map((s) => s.trim());
    if (args.length !== 2) unsupported(query, `ARRAY_CONTAINS needs 2 args: '${t}'`);
    const [a, b] = args;
    if (a!.startsWith("c.")) {
      // ARRAY_CONTAINS(c.arr, @p) — field is the array
      return {
        kind: "array_contains_field",
        field: fieldName(a!, query),
        valueRef: parseValueRef(b!, query),
      };
    }
    if (a!.startsWith("@") && b!.startsWith("c.")) {
      // ARRAY_CONTAINS(@types, c.type) — param is the array
      return { kind: "array_contains_param", paramName: a!.trim(), field: fieldName(b!, query) };
    }
    unsupported(query, `ARRAY_CONTAINS arg shape: '${t}'`);
  }

  // CONTAINS( c.field , @p )
  const cm = t.match(/^CONTAINS\s*\(([^)]*)\)$/i);
  if (cm) {
    const args = cm[1]!.split(",").map((s) => s.trim());
    if (args.length !== 2) unsupported(query, `CONTAINS needs 2 args: '${t}'`);
    return { kind: "contains", field: fieldName(args[0]!, query), valueRef: parseValueRef(args[1]!, query) };
  }

  // comparison: c.field <op> <value>
  const ops: Comparator[] = ["!=", "<=", ">=", "=", "<", ">"];
  for (const op of ops) {
    const idx = t.indexOf(op);
    if (idx > 0) {
      // avoid matching "<=" as "<": only accept if the exact op sits here
      const lhs = t.slice(0, idx).trim();
      const rhs = t.slice(idx + op.length).trim();
      // guard: if op is "<" but next char is "=", skip (handled by "<=" earlier)
      if ((op === "<" || op === ">") && t[idx + 1] === "=") continue;
      if (!lhs.startsWith("c.")) continue;
      return {
        kind: "cmp",
        field: fieldName(lhs, query),
        op,
        valueRef: parseValueRef(rhs, query),
      };
    }
  }

  unsupported(query, `unrecognised condition '${t}'`);
}

function parseQuery(query: string): ParsedQuery {
  // Normalise whitespace (but keep it; we still need word boundaries).
  const q = query.trim().replace(/\s+/g, " ");
  const upper = q.toUpperCase();
  if (!upper.startsWith("SELECT ")) unsupported(query, "must start with SELECT");

  // Locate FROM c (the only supported source alias).
  const fromIdx = upper.indexOf(" FROM C");
  if (fromIdx < 0) unsupported(query, "must contain FROM c");
  let selectClause = q.slice(7, fromIdx).trim();

  // TOP <n>
  let top: number | null = null;
  const topM = selectClause.match(/^TOP\s+(\d+)\s+(.*)$/i);
  if (topM) {
    top = Number(topM[1]);
    selectClause = topM[2]!.trim();
  }

  // projection
  let projection: ParsedQuery["projection"];
  if (selectClause === "*") {
    projection = { kind: "all" };
  } else if (/^VALUE\s+COUNT\s*\(\s*1\s*\)$/i.test(selectClause)) {
    projection = { kind: "count" };
  } else {
    // comma-separated c.field list
    const fields = selectClause.split(",").map((s) => fieldName(s.trim(), query));
    projection = { kind: "fields", fields };
  }

  // Remainder after "FROM c"
  const rest = q.slice(fromIdx + " FROM C".length).trim();
  const restUpper = rest.toUpperCase();

  // WHERE … (up to ORDER BY / OFFSET / end)
  let where: CondNode | null = null;
  let orderBy: ParsedQuery["orderBy"] = null;
  let offsetToken: string | null = null;
  let limitToken: string | null = null;

  // Carve out the optional tail clauses by index, in canonical order.
  const orderIdx = restUpper.indexOf("ORDER BY ");
  const offsetIdx = restUpper.indexOf("OFFSET ");

  let whereEnd = rest.length;
  if (orderIdx >= 0) whereEnd = Math.min(whereEnd, orderIdx);
  else if (offsetIdx >= 0) whereEnd = Math.min(whereEnd, offsetIdx);

  if (restUpper.startsWith("WHERE ")) {
    const whereText = rest.slice("WHERE ".length, whereEnd).trim();
    where = parseConditions(whereText, query);
  } else if (whereEnd !== 0 && rest.slice(0, whereEnd).trim().length > 0) {
    unsupported(query, `unexpected tokens before ORDER BY/OFFSET: '${rest.slice(0, whereEnd).trim()}'`);
  }

  if (orderIdx >= 0) {
    const afterOrder = rest.slice(orderIdx + "ORDER BY ".length);
    const ofIdx = afterOrder.toUpperCase().indexOf("OFFSET ");
    const orderText = (ofIdx >= 0 ? afterOrder.slice(0, ofIdx) : afterOrder).trim();
    const om = orderText.match(/^c\.([A-Za-z0-9_]+)(?:\s+(ASC|DESC))?$/i);
    if (!om) unsupported(query, `ORDER BY supports a single c.<field> [ASC|DESC]: '${orderText}'`);
    orderBy = { field: om[1]!, dir: (om[2]?.toUpperCase() as "ASC" | "DESC") ?? "ASC" };
    if (ofIdx >= 0) {
      [offsetToken, limitToken] = parseOffsetLimit(afterOrder.slice(ofIdx), query);
    }
  } else if (offsetIdx >= 0) {
    [offsetToken, limitToken] = parseOffsetLimit(rest.slice(offsetIdx), query);
  }

  return { projection, where, orderBy, top, offsetToken, limitToken };
}

/**
 * Parse an `OFFSET <n> LIMIT <m>` clause into raw tokens (integer string or
 * "@param"). Tokens are resolved against the bound params at evaluation time —
 * the app uses a literal OFFSET and a literal-or-@param LIMIT.
 */
function parseOffsetLimit(text: string, query: string): [offset: string, limit: string | null] {
  const m = text.match(/^OFFSET\s+(\S+)(?:\s+LIMIT\s+(\S+))?$/i);
  if (!m) unsupported(query, `bad OFFSET/LIMIT clause '${text}'`);
  const off = m[1]!;
  if (!off.startsWith("@") && !/^\d+$/.test(off)) {
    unsupported(query, `OFFSET must be an integer or @param: '${off}'`);
  }
  const lim = m[2] ?? null;
  if (lim !== null && !lim.startsWith("@") && !/^\d+$/.test(lim)) {
    unsupported(query, `LIMIT must be an integer or @param: '${lim}'`);
  }
  return [off, lim];
}

/** Resolve an OFFSET/LIMIT token (literal int or @param) to a number. */
function resolveCountToken(
  token: string | null,
  params: Map<string, unknown>,
  fallback: number,
): number {
  if (token === null) return fallback;
  if (token.startsWith("@")) {
    const v = params.get(token);
    return typeof v === "number" ? v : fallback;
  }
  return Number(token);
}

// --- condition evaluation ----------------------------------------------------

function resolveValue(ref: ValueRef, params: Map<string, unknown>): unknown {
  if (ref.ref === "literal") return ref.value;
  if (!params.has(ref.name)) {
    // Unbound param ⇒ undefined (Cosmos would error, but binding is the app's
    // job; treat as no-match like a missing value).
    return undefined;
  }
  return params.get(ref.name);
}

function compareValues(a: unknown, b: unknown, op: Comparator): boolean {
  // Faithful semantics: a missing field (undefined) never matches an
  // equality/relational predicate (Cosmos returns no row for `c.x = @p` when x
  // is absent). Same when the bound param is undefined.
  if (op === "=") return a !== undefined && b !== undefined && a === b;
  if (op === "!=") {
    // Cosmos: c.x != @p matches rows where x is present AND differs.
    return a !== undefined && a !== b;
  }
  if (a === undefined || b === undefined) return false;
  if (typeof a === "number" && typeof b === "number") {
    switch (op) {
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      case ">=": return a >= b;
    }
  }
  if (typeof a === "string" && typeof b === "string") {
    const c = a < b ? -1 : a > b ? 1 : 0;
    switch (op) {
      case "<": return c < 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case ">=": return c >= 0;
    }
  }
  // Mixed/unsupported types for relational compare → no match (Cosmos type
  // ordering is exotic; the app never relies on it).
  return false;
}

function evalCond(node: CondNode, doc: StoredDoc, params: Map<string, unknown>): boolean {
  switch (node.kind) {
    case "true":
      return true;
    case "and":
      return evalCond(node.left, doc, params) && evalCond(node.right, doc, params);
    case "or":
      return evalCond(node.left, doc, params) || evalCond(node.right, doc, params);
    case "cmp":
      return compareValues(doc[node.field], resolveValue(node.valueRef, params), node.op);
    case "contains": {
      const hay = doc[node.field];
      const needle = resolveValue(node.valueRef, params);
      return typeof hay === "string" && typeof needle === "string" && hay.includes(needle);
    }
    case "array_contains_field": {
      const arr = doc[node.field];
      const needle = resolveValue(node.valueRef, params);
      return Array.isArray(arr) && arr.some((el) => el === needle);
    }
    case "array_contains_param": {
      const arr = params.get(node.paramName);
      const val = doc[node.field];
      return Array.isArray(arr) && val !== undefined && arr.some((el) => el === val);
    }
  }
}

function orderValueCompare(a: unknown, b: unknown): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1; // undefined sorts first (stable, deterministic)
  if (b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Run a parsed query over a set of candidate docs (already pk-scoped). */
function runQuery(parsed: ParsedQuery, rawParams: Map<string, unknown>, docs: StoredDoc[]): unknown[] {
  // WHERE
  let rows = parsed.where ? docs.filter((d) => evalCond(parsed.where!, d, rawParams)) : docs.slice();

  // ORDER BY
  if (parsed.orderBy) {
    const { field, dir } = parsed.orderBy;
    rows.sort((x, y) => {
      const c = orderValueCompare(x[field], y[field]);
      return dir === "DESC" ? -c : c;
    });
  }

  // TOP (applied before OFFSET/LIMIT — but the app never combines them)
  if (parsed.top !== null) {
    rows = rows.slice(0, parsed.top);
  }

  // OFFSET / LIMIT (resolve literal-or-@param tokens against bound params)
  if (parsed.offsetToken !== null || parsed.limitToken !== null) {
    const offset = resolveCountToken(parsed.offsetToken, rawParams, 0);
    const limit = resolveCountToken(parsed.limitToken, rawParams, Number.POSITIVE_INFINITY);
    rows = rows.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
  }

  // PROJECTION
  if (parsed.projection.kind === "count") {
    return [rows.length];
  }
  if (parsed.projection.kind === "fields") {
    const fields = parsed.projection.fields;
    return rows.map((d) => {
      const out: Record<string, unknown> = {};
      for (const f of fields) if (d[f] !== undefined) out[f] = d[f];
      return out;
    });
  }
  // SELECT * → return deep clones so callers can't mutate the store in place.
  return rows.map((d) => structuredClone(d));
}

// =============================================================================
// Container factory
// =============================================================================

export interface InMemoryContainerOptions {
  /** e.g. "/fsmrora" (chats), "/username", "/sessionId". Defaults to "/id". */
  partitionKeyPath?: string;
}

export interface InMemoryContainerHandle {
  /** The double, typed as a real `Container` for injection. */
  container: Container;
  /** Read-only snapshot of all stored docs (deep-cloned). For test assertions. */
  dump(): StoredDoc[];
  /** Insert/overwrite a doc directly (bypasses validation). Stamps etag/ts if absent. */
  seed(doc: StoredDoc): void;
  /** Number of stored docs. */
  size(): number;
}

/** Compute the partition-key VALUE for a doc given the key path (e.g. "/username"). */
function pkValueOf(doc: StoredDoc, partitionKeyPath: string): unknown {
  const prop = partitionKeyPath.replace(/^\//, "");
  return doc[prop];
}

function storageKey(pk: unknown, id: string): string {
  // JSON-encode pk so distinct types don't collide (1 vs "1").
  return `${JSON.stringify(pk ?? null)} ${id}`;
}

function applyPatch(target: StoredDoc, ops: PatchOperation[]): void {
  for (const op of ops) {
    // Patch paths are JSON-pointer-ish "/field"; the app only ever patches
    // top-level scalar fields, so we support a single "/<field>" segment.
    const path = (op as { path: string }).path;
    const field = path.replace(/^\//, "");
    switch (op.op) {
      case "set":
      case "replace":
        target[field] = (op as { value: unknown }).value;
        break;
      case "add":
        target[field] = (op as { value: unknown }).value;
        break;
      case "remove":
        delete target[field];
        break;
      case "incr": {
        const cur = typeof target[field] === "number" ? (target[field] as number) : 0;
        target[field] = cur + (op as { value: number }).value;
        break;
      }
      default:
        throw new Error(`inMemoryCosmosContainer: unsupported patch op '${(op as { op: string }).op}'`);
    }
  }
}

/**
 * Build an in-memory `Container` double.
 *
 * @param seedDocs Optional initial docs (each gets an id/etag/ts stamped if missing).
 * @param options  `{ partitionKeyPath }` — the container's partition key path.
 */
export function makeInMemoryContainer(
  seedDocs: StoredDoc[] = [],
  options: InMemoryContainerOptions = {},
): InMemoryContainerHandle {
  const partitionKeyPath = options.partitionKeyPath ?? "/id";
  // Single flat store keyed by (pk,id). Cross-partition queries scan all values;
  // point ops resolve by exact (pk,id) — a wrong pk → miss, mirroring Cosmos.
  const store = new Map<string, StoredDoc>();

  function put(doc: StoredDoc): StoredDoc {
    const pk = pkValueOf(doc, partitionKeyPath);
    store.set(storageKey(pk, doc.id!), doc);
    return doc;
  }

  for (const d of seedDocs) {
    const doc: StoredDoc = { ...d };
    if (doc.id === undefined) doc.id = freshId();
    if (doc._etag === undefined) doc._etag = freshEtag();
    if (doc._ts === undefined) doc._ts = nowTs();
    put(doc);
  }

  // --- items.* ---------------------------------------------------------------

  const items = {
    async create(body: StoredDoc) {
      const doc: StoredDoc = structuredClone(body);
      if (doc.id === undefined) doc.id = freshId();
      const pk = pkValueOf(doc, partitionKeyPath);
      const key = storageKey(pk, doc.id);
      if (store.has(key)) {
        throw cosmosError(409, `Entity with the specified id already exists (id=${doc.id})`);
      }
      doc._etag = freshEtag();
      doc._ts = nowTs();
      put(doc);
      return { resource: structuredClone(doc), statusCode: 201 };
    },

    async upsert(body: StoredDoc, requestOptions?: { accessCondition?: { type?: string; condition?: string } }) {
      const doc: StoredDoc = structuredClone(body);
      if (doc.id === undefined) doc.id = freshId();
      const pk = pkValueOf(doc, partitionKeyPath);
      const key = storageKey(pk, doc.id);
      const existing = store.get(key);

      // IfMatch precondition (the `updateChatDocument` conditional-write path):
      // a supplied condition that differs from the STORED etag → 412.
      const ifMatch = requestOptions?.accessCondition?.condition;
      if (ifMatch !== undefined) {
        if (!existing || existing._etag !== ifMatch) {
          throw cosmosError(412, "Precondition failed (IfMatch _etag mismatch)");
        }
      }
      doc._etag = freshEtag();
      doc._ts = nowTs();
      put(doc);
      return { resource: structuredClone(doc), statusCode: existing ? 200 : 201 };
    },

    query(specOrString: string | SqlQuerySpec, _options?: { partitionKey?: unknown }) {
      const queryText = typeof specOrString === "string" ? specOrString : specOrString.query;
      const paramList: SqlParameter[] =
        typeof specOrString === "string" ? [] : specOrString.parameters ?? [];
      const params = new Map<string, unknown>();
      for (const p of paramList) params.set(p.name, p.value);

      // Partition scoping: if a partitionKey option is given (and not undefined),
      // restrict the scan to that partition; otherwise cross-partition scan ALL.
      const pkOpt = _options?.partitionKey;
      const candidates: StoredDoc[] = [];
      for (const d of store.values()) {
        if (pkOpt !== undefined && pkValueOf(d, partitionKeyPath) !== pkOpt) continue;
        candidates.push(d);
      }

      const parsed = parseQuery(queryText);
      const compute = (): unknown[] => runQuery(parsed, params, candidates);

      let consumed = false;
      return {
        async fetchAll() {
          return { resources: compute() };
        },
        async fetchNext() {
          if (consumed) return { resources: [], hasMoreResults: false };
          consumed = true;
          // Single-page iterator — all results in one batch (the app never
          // paginates the double; continuation isn't modelled).
          return { resources: compute(), hasMoreResults: false };
        },
        // Async-iterable form (`for await (const page of iterator)`) — single page.
        async *getAsyncIterator() {
          yield { resources: compute() };
        },
      };
    },
  };

  // --- item(id, pk).* --------------------------------------------------------

  function item(id: string, partitionKeyValue?: unknown) {
    const findKey = (): string | null => {
      // When a pk is supplied, resolve EXACTLY by (pk,id) — a wrong pk misses.
      if (partitionKeyValue !== undefined) {
        const key = storageKey(partitionKeyValue, id);
        return store.has(key) ? key : null;
      }
      // No pk supplied → look up by id across partitions (Cosmos requires pk for
      // point ops, but some callers pass it positionally; we tolerate id-only).
      for (const [k, d] of store.entries()) if (d.id === id) return k;
      return null;
    };

    return {
      async read() {
        const key = findKey();
        // Faithful: the SDK SWALLOWS 404 on reads → resource: undefined.
        if (!key) return { resource: undefined, statusCode: 404 };
        return { resource: structuredClone(store.get(key)!), statusCode: 200 };
      },

      async replace(body: StoredDoc, options?: { accessCondition?: { type?: string; condition?: string } }) {
        const key = findKey();
        if (!key) throw cosmosError(404, `Item not found (id=${id})`);
        const existing = store.get(key)!;
        const ifMatch = options?.accessCondition?.condition;
        if (ifMatch !== undefined && existing._etag !== ifMatch) {
          throw cosmosError(412, "Precondition failed (IfMatch _etag mismatch)");
        }
        const doc: StoredDoc = structuredClone(body);
        doc.id = id;
        doc._etag = freshEtag();
        doc._ts = nowTs();
        // replace keeps the partition (pk fields come from the body).
        store.delete(key);
        put(doc);
        return { resource: structuredClone(doc), statusCode: 200 };
      },

      async delete() {
        const key = findKey();
        if (!key) throw cosmosError(404, `Item not found (id=${id})`);
        store.delete(key);
        return { resource: undefined, statusCode: 204 };
      },

      async patch(body: { operations: PatchOperation[] } | PatchOperation[]) {
        const key = findKey();
        if (!key) throw cosmosError(404, `Item not found (id=${id})`);
        const ops = Array.isArray(body) ? body : body.operations;
        const doc = store.get(key)!;
        applyPatch(doc, ops);
        doc._etag = freshEtag();
        doc._ts = nowTs();
        return { resource: structuredClone(doc), statusCode: 200 };
      },
    };
  }

  // The structural surface we implement is a strict subset of `Container`.
  // Cast through `unknown` once, here, so every call site stays fully typed.
  const container = { items, item } as unknown as Container;

  return {
    container,
    dump: () => Array.from(store.values()).map((d) => structuredClone(d)),
    seed: (doc: StoredDoc) => {
      const copy: StoredDoc = { ...doc };
      if (copy.id === undefined) copy.id = freshId();
      if (copy._etag === undefined) copy._etag = freshEtag();
      if (copy._ts === undefined) copy._ts = nowTs();
      put(copy);
    },
    size: () => store.size,
  };
}
