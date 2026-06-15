/**
 * EX21 / CFG-1 · Boot-time environment validation.
 *
 * Before this, required credentials (Cosmos, Blob, Azure OpenAI, Azure AD) were
 * validated LAZILY — each subsystem threw only on its first use, deep inside a
 * request, with a one-variable-at-a-time message. A misconfigured deploy would
 * boot "successfully" and then 500 on the first real call.
 *
 * `assertRequiredEnv()` (called once from createApp) checks the whole credential
 * cluster up front and, in a production-like environment, throws a SINGLE
 * aggregated error listing every missing variable. In dev/test it warns and
 * continues (so a local run without, say, Snowflake still works).
 *
 * This is the first step of "one typed config": new subsystems should read
 * their config here rather than reaching into process.env directly.
 */
import { logger } from "../lib/logger.js";

interface RequiredVar {
  name: string;
  group: string;
  /** Only required when this returns true (default: always). */
  requiredWhen?: () => boolean;
}

/**
 * The credential cluster the app cannot function without in production. RAG
 * (AZURE_SEARCH_*) is intentionally NOT here — it is validated by
 * `assertAgenticRagConfiguration()` against the AGENTIC_LOOP_ENABLED contract.
 */
const REQUIRED: RequiredVar[] = [
  { name: "COSMOS_ENDPOINT", group: "Cosmos DB" },
  { name: "COSMOS_KEY", group: "Cosmos DB" },
  { name: "AZURE_STORAGE_ACCOUNT_NAME", group: "Azure Blob Storage" },
  { name: "AZURE_STORAGE_ACCOUNT_KEY", group: "Azure Blob Storage" },
  { name: "AZURE_OPENAI_ENDPOINT", group: "Azure OpenAI" },
  { name: "AZURE_OPENAI_API_KEY", group: "Azure OpenAI" },
  { name: "AZURE_OPENAI_DEPLOYMENT_NAME", group: "Azure OpenAI" },
  // Azure AD auth is required UNLESS the dev bypass is explicitly on.
  {
    name: "AZURE_AD_TENANT_ID",
    group: "Azure AD auth",
    requiredWhen: () => process.env.DISABLE_AUTH !== "true",
  },
  {
    name: "AZURE_AD_CLIENT_ID",
    group: "Azure AD auth",
    requiredWhen: () => process.env.DISABLE_AUTH !== "true",
  },
];

function isProductionLike(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL;
}

/**
 * Validate required env once at boot. Throws (fail-fast) in production-like
 * environments with an aggregated message; warns and continues in dev/test.
 */
export function assertRequiredEnv(): void {
  const missing = REQUIRED.filter(
    (v) => (v.requiredWhen ? v.requiredWhen() : true) && !process.env[v.name]?.trim(),
  );
  if (missing.length === 0) return;

  const byGroup = new Map<string, string[]>();
  for (const v of missing) {
    const list = byGroup.get(v.group) ?? [];
    list.push(v.name);
    byGroup.set(v.group, list);
  }
  const detail = [...byGroup.entries()]
    .map(([group, names]) => `  ${group}: ${names.join(", ")}`)
    .join("\n");
  const msg = `Missing required environment variable(s):\n${detail}`;

  if (isProductionLike()) {
    throw new Error(
      `[env] ${msg}\nSet them in the deploy environment (server/server.env locally). ` +
        `Set DISABLE_AUTH=true only for local dev to relax the Azure AD requirement.`,
    );
  }
  logger.warn(
    `⚠️ [env] ${msg}\n(dev/test — continuing; these will fail on first use of the affected subsystem)`,
  );
}
