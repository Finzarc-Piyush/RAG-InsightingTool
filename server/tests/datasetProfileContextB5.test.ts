import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { inferDatasetProfile } from "../lib/datasetProfile.js";
import { installLlmStub, clearLlmStub } from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";

/**
 * Wave B5 · Pins that `inferDatasetProfile` threads optional
 * `permanentContext` and `domainContext` into the LLM payload at upload
 * time. The audit identified that the LLM had `ambiguousCurrencyColumns`
 * (WF8) but no domain / user-context to ground a currency override —
 * e.g. "$" in a Marico-VN dataset should resolve to VND if the domain
 * pack mentions Vietnam, but pre-B5 the LLM had no way to know.
 */

const sampleRows = [
  { Region: "Off VN", Product: "PARACHUTE", Sales: "$12,345,000" },
  { Region: "Off VN", Product: "NIHAR", Sales: "$8,234,000" },
];

afterEach(() => {
  clearLlmStub();
});

describe("Wave B5 · inferDatasetProfile threads optional context fields", () => {
  it("permanentContext appears in the LLM user content when provided", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.DATASET_PROFILE]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return {
          shortDescription: "Marico Vietnam sales",
          dateColumns: [],
          suggestedQuestions: ["What's MARICO's regional share?"],
        };
      },
    });
    await inferDatasetProfile(sampleRows, {
      fileName: "marico-vn.csv",
      timeoutMs: 2000,
      permanentContext:
        "this is Marico Vietnam data; all figures in VND; always exclude internal-only brands",
    });
    assert.ok(
      lastUser.includes("userContext"),
      `expected userContext field in profile payload; got: ${lastUser.slice(0, 400)}`
    );
    assert.ok(
      lastUser.includes("Marico Vietnam"),
      "expected the permanent-context content in payload"
    );
  });

  it("domainContext appears in the LLM user content when provided", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.DATASET_PROFILE]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return {
          shortDescription: "Marico haircare sales",
          dateColumns: [],
          suggestedQuestions: ["MAT by brand?"],
        };
      },
    });
    await inferDatasetProfile(sampleRows, {
      fileName: "haircare.csv",
      timeoutMs: 2000,
      domainContext:
        "<<DOMAIN PACK: marico-haircare>>\nKey brands: PARACHUTE, NIHAR, SETWET. MAT = Moving Annual Total.\n<</DOMAIN PACK>>",
    });
    assert.ok(
      lastUser.includes("domainContext"),
      `expected domainContext field in profile payload; got: ${lastUser.slice(0, 400)}`
    );
    assert.ok(
      lastUser.includes("PARACHUTE"),
      "expected domain-pack content in payload"
    );
  });

  it("ABSENT context fields DO NOT leak (clean baseline)", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.DATASET_PROFILE]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return {
          shortDescription: "Sales by region",
          dateColumns: [],
          suggestedQuestions: ["Total revenue?"],
        };
      },
    });
    await inferDatasetProfile(sampleRows, { fileName: "plain.csv", timeoutMs: 2000 });
    assert.ok(
      !lastUser.includes("userContext"),
      "no userContext field when permanentContext absent"
    );
    assert.ok(
      !lastUser.includes("domainContext"),
      "no domainContext field when domainContext absent"
    );
  });

  it("system prompt mentions userContext and domainContext as optional input fields (source-level)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.resolve(here, "..", "lib", "datasetProfile.ts"),
      "utf8"
    );
    assert.match(
      src,
      /"userContext"/,
      "system prompt should mention userContext as optional input"
    );
    assert.match(
      src,
      /"domainContext"/,
      "system prompt should mention domainContext as optional input"
    );
  });

  it("backwards-compat: omitting context fields works (pre-B5 signature)", async () => {
    installLlmStub({
      [LLM_PURPOSE.DATASET_PROFILE]: () => ({
        shortDescription: "Sales by region",
        dateColumns: [],
        suggestedQuestions: ["Top regions?"],
      }),
    });
    const result = await inferDatasetProfile(sampleRows, { timeoutMs: 2000 });
    assert.equal(result.shortDescription, "Sales by region");
  });
});
