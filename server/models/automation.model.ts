/**
 * Automation Model
 *
 * Persists "Save as Automation" recipes captured from completed chat
 * sessions, listed and re-runnable from the start screen. Container is
 * partitioned by `/username` (mirrors `dashboards`).
 *
 * Reads / writes are unconditional ground-truth: no merge logic, no
 * cross-user sharing in v1. Writes happen at three points:
 *   • createAutomation     — POST /api/automations (capture)
 *   • touchAutomationLastRun — at the end of a successful replay
 *   • deleteAutomation     — DELETE /api/automations/:id
 */

import type {
  Automation,
  AutomationSummary,
} from "../shared/schema.js";
import { waitForAutomationsContainer } from "./database.config.js";
import { logger } from "../lib/logger.js";

const sanitiseId = (raw: string) =>
  raw
    .replace(/[^a-zA-Z0-9-_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);

/** Mirrors `chat.model.ts` defensive normalization: Cosmos partition keys
 *  must be byte-stable across writes/reads. Azure AD typically returns
 *  lowercase UPNs but we normalize to remove any tenant-specific drift. */
const normaliseUsername = (raw: string): string => raw.trim().toLowerCase();

/** Cosmos hard limit is 2 MiB per document. Match the chat-model error
 *  threshold (1.9 MiB) so users get a friendly error before the SDK
 *  throws a raw 413. Recipes with many turns × charts approach this. */
const COSMOS_DOC_SIZE_ERROR_BYTES = 1_900_000;
const COSMOS_DOC_SIZE_WARN_BYTES = 1_500_000;

export class AutomationDocSizeError extends Error {
  readonly bytes: number;
  readonly automationName: string;
  constructor(bytes: number, automationName: string) {
    super(
      `Automation "${automationName}" is ${bytes} bytes — too large to persist (Cosmos 2 MB limit). Capture a shorter chat or split the analysis into smaller automations.`
    );
    this.name = "AutomationDocSizeError";
    this.bytes = bytes;
    this.automationName = automationName;
  }
}

const assertAutomationSizeUnderLimit = (a: Automation): void => {
  const bytes = Buffer.byteLength(JSON.stringify(a), "utf8");
  if (bytes >= COSMOS_DOC_SIZE_ERROR_BYTES) {
    throw new AutomationDocSizeError(bytes, a.name);
  }
  if (bytes >= COSMOS_DOC_SIZE_WARN_BYTES) {
    logger.warn(
      `⚠️ automation doc size ${bytes} bytes (id=${a.id}, recipe=${a.recipe.length} turns) — approaching Cosmos 2 MB limit`
    );
  }
};

/**
 * Create a new automation. Throws if a same-username + same-name automation
 * already exists (case-insensitive trim) — mirrors `createDashboard`.
 */
export const createAutomation = async (
  draft: Omit<Automation, "id" | "createdAt" | "runCount" | "lastRunAt">
): Promise<Automation> => {
  const container = await waitForAutomationsContainer();

  // Normalise the partition-key field at the write boundary. Every read
  // path lowercases, so writes must too — mismatched casing = silent 404.
  const username = normaliseUsername(draft.username);
  const existing = await listAutomationsByUser(username);
  const dup = existing.find(
    (a) =>
      a.name.toLowerCase().trim() === draft.name.toLowerCase().trim()
  );
  if (dup) {
    throw new Error(
      `An automation named "${draft.name}" already exists. Pick a different name.`
    );
  }

  const timestamp = Date.now();
  const id = `automation_${sanitiseId(draft.name)}_${timestamp}`;
  const automation: Automation = {
    ...draft,
    id,
    username,
    createdAt: new Date(timestamp).toISOString(),
    runCount: 0,
  };

  assertAutomationSizeUnderLimit(automation);

  const { resource } = await container.items.create(automation);
  return resource as unknown as Automation;
};

export const getAutomationById = async (
  id: string,
  username: string
): Promise<Automation | null> => {
  try {
    const container = await waitForAutomationsContainer();
    const { resource } = await container
      .item(id, normaliseUsername(username))
      .read();
    if (!resource) return null;
    const automation = resource as unknown as Automation;
    if (automation.username?.toLowerCase() !== normaliseUsername(username)) {
      return null;
    }
    return automation;
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code === 404) return null;
    throw error;
  }
};

export const listAutomationsByUser = async (
  username: string
): Promise<Automation[]> => {
  try {
    const container = await waitForAutomationsContainer();
    const { resources } = await container.items
      .query(
        {
          query: "SELECT * FROM c WHERE c.username = @username",
          parameters: [{ name: "@username", value: normaliseUsername(username) }],
        },
        { partitionKey: normaliseUsername(username) }
      )
      .fetchAll();
    const list = (resources ?? []) as unknown as Automation[];
    return list.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  } catch (error) {
    logger.error("[automation.model] listAutomationsByUser failed:", error);
    return [];
  }
};

export const summariseAutomation = (a: Automation): AutomationSummary => ({
  id: a.id,
  name: a.name,
  description: a.description,
  sourceFileName: a.sourceFileName,
  createdAt: a.createdAt,
  lastRunAt: a.lastRunAt,
  runCount: a.runCount,
  recipeLength: a.recipe.length,
  expectedColumnCount: a.expectedSchema.finalColumns.length,
});

export const listAutomationSummariesByUser = async (
  username: string
): Promise<AutomationSummary[]> => {
  const list = await listAutomationsByUser(username);
  return list.map(summariseAutomation);
};

/**
 * Stamp the automation as just-run. Bumps `runCount` and sets
 * `lastRunAt` to now. Best-effort — failure to touch should not surface
 * to the user; the replay already succeeded by the time this runs.
 */
export const touchAutomationLastRun = async (
  id: string,
  username: string
): Promise<void> => {
  try {
    const container = await waitForAutomationsContainer();
    const automation = await getAutomationById(id, username);
    if (!automation) return;
    const updated: Automation = {
      ...automation,
      lastRunAt: new Date().toISOString(),
      runCount: (automation.runCount ?? 0) + 1,
    };
    await container.item(id, normaliseUsername(username)).replace(updated);
  } catch (error) {
    logger.warn("[automation.model] touchAutomationLastRun failed:", error);
  }
};

export const deleteAutomation = async (
  id: string,
  username: string
): Promise<void> => {
  const container = await waitForAutomationsContainer();
  const existing = await getAutomationById(id, username);
  if (!existing) {
    throw new Error("Automation not found");
  }
  await container.item(id, normaliseUsername(username)).delete();
};
