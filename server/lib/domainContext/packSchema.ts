/**
 * WD1 · Frontmatter parser + zod schema for domain packs.
 *
 * Lightweight YAML frontmatter (key: value lines only — we don't need nested
 * structures). Avoids a yaml dependency. If a pack file has unsupported syntax
 * (lists, multi-line strings) the schema validation will surface a clear error.
 */

import { z } from "zod";
import type { DomainPack, PackCategory } from "./types.js";

const FRONTMATTER_FENCE = "---";

const PackCategoryEnum = z.enum([
  "products",
  "industry",
  "competition",
  "seasonality",
  "events",
  "glossary",
]);

export const PackFrontmatterSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case (lowercase, digits, dashes)"),
  title: z.string().min(1),
  category: PackCategoryEnum,
  priority: z.number().int().min(0),
  enabledByDefault: z.boolean(),
  version: z.string().min(1),
});

export type PackFrontmatter = z.infer<typeof PackFrontmatterSchema>;

export class PackParseError extends Error {
  constructor(
    public readonly file: string,
    message: string
  ) {
    super(`${file}: ${message}`);
    this.name = "PackParseError";
  }
}

function parseScalar(raw: string): string | number | boolean {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

function splitFrontmatter(source: string, file: string): { fm: string; body: string } {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    throw new PackParseError(file, "missing opening --- fence");
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new PackParseError(file, "missing closing --- fence");
  }
  return {
    fm: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n").trimStart(),
  };
}

function parseFrontmatterBlock(block: string, file: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) {
      throw new PackParseError(file, `invalid frontmatter line: "${rawLine}"`);
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    out[key] = parseScalar(value);
  }
  return out;
}

export interface ParsedPackInput {
  /** Filename only (e.g. "marico-company-profile.md") — for error messages. */
  file: string;
  source: string;
}

export function parsePack(input: ParsedPackInput): DomainPack {
  const { fm, body } = splitFrontmatter(input.source, input.file);
  const raw = parseFrontmatterBlock(fm, input.file);
  const fmParsed = PackFrontmatterSchema.safeParse(raw);
  if (!fmParsed.success) {
    throw new PackParseError(
      input.file,
      `invalid frontmatter: ${fmParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }
  const fileId = input.file.replace(/\.md$/, "");
  if (fmParsed.data.id !== fileId) {
    throw new PackParseError(
      input.file,
      `frontmatter id "${fmParsed.data.id}" must match filename "${fileId}"`
    );
  }
  if (!body.trim().length) {
    throw new PackParseError(input.file, "empty pack body");
  }
  return {
    id: fmParsed.data.id,
    title: fmParsed.data.title,
    category: fmParsed.data.category as PackCategory,
    priority: fmParsed.data.priority,
    enabledByDefault: fmParsed.data.enabledByDefault,
    version: fmParsed.data.version,
    body,
    approxTokens: Math.ceil(body.length / 4),
  };
}
