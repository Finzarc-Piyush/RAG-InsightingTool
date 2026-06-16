/**
 * Wave CS3 · Registry manifest generator (the "what's wired" index).
 *
 * Cold-start initiative Piece 3. Emits docs/index/registries.generated.md: the
 * complete list of agent tools, HTTP routes, and skills — the three canonical
 * registries (CLAUDE.md invariants #8). It collapses the verified worst-case
 * cold-start lookup ("what tools exist?" = 5 tool calls + 2 failed greps,
 * because tool names sit on the line AFTER `registry.register(` and 16 live in
 * delegated files) into a single read.
 *
 * STATIC extraction — does NOT execute registerDefaultTools (that would drag in
 * DuckDB / web-search / env side-effects). The output is a pure function of
 * source, so it is committed and CI-gated with `git diff --exit-code`: change a
 * registry, forget to regenerate, red build. Duplicate tool names (the boot
 * fatal of invariant #8) are surfaced inline.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const SERVER = join(REPO_ROOT, "server");
const OUT_REL = "docs/index/registries.generated.md";

function read(abs: string): string {
  return readFileSync(abs, "utf8");
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}
function lsTs(absDir: string): string[] {
  try {
    return readdirSync(absDir).filter((f) => f.endsWith(".ts")).sort();
  } catch {
    return [];
  }
}

interface Tool {
  name: string;
  description: string;
  file: string;
}

/** Every `registry.register("name", ...)` across runtime/tools/*.ts. */
function extractTools(): { tools: Tool[]; duplicates: string[] } {
  const dir = join(SERVER, "lib/agents/runtime/tools");
  const tools: Tool[] = [];
  for (const f of lsTs(dir)) {
    const text = read(join(dir, f));
    const chunks = text.split("registry.register(");
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const nameM = chunk.match(/["']([a-z][a-z0-9_]+)["']/);
      if (!nameM) continue;
      const descM = chunk.match(/description:\s*["'`]([^"'`]+)/);
      tools.push({
        name: nameM[1]!,
        description: truncate((descM?.[1] ?? "").replace(/\s+/g, " ").trim(), 140),
        file: `server/lib/agents/runtime/tools/${f}`,
      });
    }
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const t of tools) {
    if (seen.has(t.name)) duplicates.push(t.name);
    seen.add(t.name);
  }
  return { tools, duplicates };
}

interface RouteGroup {
  prefix: string;
  file: string;
  handlers: { method: string; path: string }[];
}

/** Mount table (routes/index.ts) × handlers in each mounted module. */
function extractRoutes(): RouteGroup[] {
  const indexText = read(join(SERVER, "routes/index.ts"));
  const importMap = new Map<string, string>(); // var -> file stem
  for (const m of indexText.matchAll(/^import\s+(\w+)\s+from\s+["']\.\/([\w.]+)\.js["']/gm)) {
    importMap.set(m[1]!, m[2]!);
  }
  // Collect (prefix, var) mount entries from BOTH mount forms:
  //  - API-7 helper form: `mount('<subpath>', <router>)` → mounted at `/api<subpath>`
  //    (the helper also adds a `/api/v1<subpath>` alias resolving to the same
  //    handlers; the registry lists the canonical `/api` prefix only).
  //  - Legacy explicit form: `app.use('/api/x', <router>)`.
  // The `mount` helper's own body (`app.use(`/api${path}`, …)`) uses template
  // literals, so the legacy single/double-quote regex never matches it → no
  // double-counting.
  const mounts: { prefix: string; varName: string }[] = [];
  for (const m of indexText.matchAll(/\bmount\(\s*["'`]([^"'`]*)["'`]\s*,\s*(\w+)\s*\)/g)) {
    // `m[1]` is "" for a bare `mount('', router)`, which yields `/api` — the
    // template literal is always truthy, so no `|| "/api"` fallback is needed.
    mounts.push({ prefix: `/api${m[1]!}`, varName: m[2]! });
  }
  for (const m of indexText.matchAll(/app\.use\(\s*["']([^"']+)["']\s*,\s*(\w+)\s*\)/g)) {
    mounts.push({ prefix: m[1]!, varName: m[2]! });
  }

  const groups: RouteGroup[] = [];
  for (const { prefix, varName } of mounts) {
    const stem = importMap.get(varName);
    if (!stem) continue;
    let text: string;
    try {
      text = read(join(SERVER, "routes", `${stem}.ts`));
    } catch {
      continue;
    }
    const handlers: { method: string; path: string }[] = [];
    for (const h of text.matchAll(/\b(?:router|app)\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g)) {
      const sub = h[2]!;
      const full = `${prefix}${sub.startsWith("/") ? "" : "/"}${sub}`.replace(/\/{2,}/g, "/");
      handlers.push({ method: h[1]!.toUpperCase(), path: full });
    }
    handlers.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    groups.push({ prefix, file: `server/routes/${stem}.ts`, handlers });
  }
  return groups;
}

interface SkillEntry {
  name: string;
  file: string;
}

/** Resolve the top-level skill name (`const skill = { name: SKILL_NAME }`), following the const. */
function resolveSkillName(text: string, file: string): string {
  const block = text.match(/const\s+skill\s*:\s*AnalysisSkill\s*=\s*\{([\s\S]{0,400})/);
  const scope = block?.[1] ?? text;
  const field = scope.match(/\bname:\s*([A-Za-z_$][\w$]*|["'`][^"'`]+["'`])/);
  if (field) {
    const tok = field[1]!;
    if (/^["'`]/.test(tok)) return tok.slice(1, -1);
    const constM = text.match(new RegExp(`(?:const|let)\\s+${tok}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`));
    if (constM) return constM[1]!;
  }
  return file.replace(/\.ts$/, "");
}

/** Modules that self-register via registerSkill(...) (skills/index.ts side-effect imports). */
function extractSkills(): SkillEntry[] {
  const dir = join(SERVER, "lib/agents/runtime/skills");
  const out: SkillEntry[] = [];
  for (const f of lsTs(dir)) {
    if (f === "index.ts" || f === "registry.ts" || f === "types.ts") continue;
    const text = read(join(dir, f));
    if (!/registerSkill\(/.test(text)) continue;
    out.push({ name: resolveSkillName(text, f), file: `server/lib/agents/runtime/skills/${f}` });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function render(): string {
  const { tools, duplicates } = extractTools();
  const routes = extractRoutes();
  const skills = extractSkills();
  const handlerCount = routes.reduce((s, g) => s + g.handlers.length, 0);

  const lines: string[] = [
    "<!-- AUTO-GENERATED by server/scripts/generate-registries.ts. Do not edit by hand. -->",
    "<!-- Regenerate: npm --prefix server run gen:registries · CI fails if this drifts. -->",
    "",
    "# Registry manifest — agent tools, HTTP routes, skills",
    "",
    "The three canonical registries (CLAUDE.md invariant #8). One read instead of grepping 17 files.",
    "",
    `## Agent tools (${tools.length})`,
    "",
  ];
  if (duplicates.length) {
    lines.push(`> ⚠ DUPLICATE tool name(s) — fatal at boot (invariant #8): ${duplicates.join(", ")}`, "");
  }
  lines.push("| Tool | Description | Source |", "|---|---|---|");
  for (const t of tools) {
    lines.push(`| \`${t.name}\` | ${t.description || "—"} | ${t.file} |`);
  }

  lines.push("", `## HTTP routes (${handlerCount} handlers across ${routes.length} modules)`, "");
  for (const g of routes) {
    lines.push(`### ${g.file} — mounted at \`${g.prefix}\` (${g.handlers.length})`);
    for (const h of g.handlers) lines.push(`- \`${h.method}\` ${h.path}`);
    lines.push("");
  }

  lines.push(`## Skills (${skills.length})`, "");
  for (const s of skills) lines.push(`- \`${s.name}\` — ${s.file}`);
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const outAbs = join(REPO_ROOT, OUT_REL);
  mkdirSync(dirname(outAbs), { recursive: true });
  const content = render();
  writeFileSync(outAbs, content, "utf8");
  const tools = (content.match(/^\| `/gm) ?? []).length;
  console.log(`generate-registries: wrote ${OUT_REL} (${content.split("\n").length} lines, ${tools} tool rows)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { extractTools, extractRoutes, extractSkills, render };
