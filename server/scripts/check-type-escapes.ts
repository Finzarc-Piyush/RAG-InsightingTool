/**
 * EX16 / TYPE-4 · Type-escape ratchet.
 *
 * Counts the two most dangerous TypeScript escape hatches — `as any` and
 * `as unknown as` — across the server runtime source (excluding tests) and
 * fails if the total EXCEEDS a committed baseline. The baseline can only be
 * lowered: every wave that removes casts should drop BASELINE to the new count,
 * so the number ratchets toward zero and never silently regrows. This is the
 * machine-checked half of "stop the any-bleed" (the other half is the ESLint
 * no-explicit-any warning).
 *
 * Run: npm run check:type-escapes  (wired into CI, blocking).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// Lower this as casts are removed — never raise it. (201 on 2026-06-15;
// lowered to 189 on 2026-06-16 after TYPE-6 removed 12 `as unknown as` casts.)
const BASELINE = 188;

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = [
  "lib",
  "models",
  "controllers",
  "services",
  "routes",
  "middleware",
  "utils",
];

const AS_ANY = /\bas any\b/g;
const AS_UNKNOWN_AS = /\bas unknown as\b/g;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (extname(full) === ".ts" && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

const files: string[] = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);

let asAny = 0;
let asUnknownAs = 0;
const offenders: Array<{ file: string; asAny: number; asUnknownAs: number }> = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const a = (src.match(AS_ANY) || []).length;
  const u = (src.match(AS_UNKNOWN_AS) || []).length;
  // `as unknown as` also matches `as any`? No — distinct strings. But `as any`
  // inside `as unknown as X as any` would double count; acceptable for a ratchet.
  asAny += a;
  asUnknownAs += u;
  if (a + u > 0) offenders.push({ file: f.replace(ROOT, ""), asAny: a, asUnknownAs: u });
}

const total = asAny + asUnknownAs;
console.log(`Type escapes — as any: ${asAny}, as unknown as: ${asUnknownAs}, total: ${total} (baseline ${BASELINE})`);

if (total > BASELINE) {
  console.error(
    `\n❌ Type-escape count ${total} exceeds baseline ${BASELINE}. ` +
      `New 'as any' / 'as unknown as' casts are not allowed — type the value properly ` +
      `(zod parse at boundaries, a concrete interface on hot paths). Top offenders:`,
  );
  offenders
    .sort((x, y) => y.asAny + y.asUnknownAs - (x.asAny + x.asUnknownAs))
    .slice(0, 15)
    .forEach((o) => console.error(`  ${o.file}: ${o.asAny} as-any, ${o.asUnknownAs} as-unknown-as`));
  process.exit(1);
}

if (total < BASELINE) {
  console.log(
    `✅ Below baseline by ${BASELINE - total}. Lower BASELINE in scripts/check-type-escapes.ts to ${total} to lock in the win.`,
  );
} else {
  console.log("✅ At baseline — no new type escapes.");
}
