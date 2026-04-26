/**
 * W3.11 · Live A/B replayer for golden questions.
 *
 * Replays the corpus produced by `seed-golden-questions.ts` against the
 * currently-running chat-stream endpoint. Writes per-question metrics +
 * the assistant answer to a JSON file labeled by the operator.
 *
 * Workflow:
 *   1. Start the server in config A (e.g. `OPENAI_MODEL_MINI_RAMP_PLANNER=0`).
 *   2. `npx tsx server/scripts/llm-golden-replay.ts --label baseline`
 *   3. Restart the server in config B.
 *   4. `npx tsx server/scripts/llm-golden-replay.ts --label candidate`
 *   5. `npx tsx server/scripts/llm-golden-diff.ts baseline candidate`
 *
 * The replayer hits the local chat endpoint via fetch — runs against any
 * deployment, no internal coupling. Authentication is bypassed when the
 * server has `DISABLE_AUTH=true`; otherwise the script honors `REPLAY_BEARER`
 * + `REPLAY_USER_EMAIL` env vars for token + identity.
 */

import "../loadEnv.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  goldenCorpusSchema,
  type GoldenQuestion,
} from "../tests/fixtures/goldenQuestions.schema.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, "..", "tests", "fixtures");
const RESULTS_DIR = path.join(__dirname, "..", "tmp");
const CORPUS_PATH = path.join(FIXTURES_DIR, "golden-questions.json");

interface CliArgs {
  label: string;
  serverUrl: string;
  limit: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  let label = "unlabeled";
  let serverUrl = process.env.REPLAY_SERVER_URL || "http://localhost:3002";
  let limit = Infinity;
  let timeoutMs = 240_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label" && argv[i + 1]) label = argv[++i];
    else if (a === "--server" && argv[i + 1]) serverUrl = argv[++i];
    else if (a === "--limit" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    } else if (a === "--timeout" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) timeoutMs = Math.floor(n);
    }
  }
  return { label, serverUrl, limit, timeoutMs };
}

interface ReplayMetric {
  id: string;
  question: string;
  shape: GoldenQuestion["shape"];
  sessionId: string;
  status: "ok" | "error" | "timeout";
  httpStatus?: number;
  latencyMs: number;
  answer?: string;
  chartCount?: number;
  outcome?: string;
  errorMessage?: string;
}

/**
 * Parse one SSE chunk into a list of `{event, data}` records. Tolerant of the
 * variants the server emits — some events have `data: ...` only, some have
 * `event: name\\ndata: ...`.
 */
function parseSseFrame(frame: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  let event = "message";
  let dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return out;
  const raw = dataLines.join("\n");
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* leave as string */
  }
  out.push({ event, data });
  return out;
}

async function replayOne(
  q: GoldenQuestion,
  serverUrl: string,
  timeoutMs: number
): Promise<ReplayMetric> {
  const started = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.REPLAY_BEARER) headers.Authorization = `Bearer ${process.env.REPLAY_BEARER}`;
  if (process.env.REPLAY_USER_EMAIL) headers["X-User-Email"] = process.env.REPLAY_USER_EMAIL;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: q.sessionId, message: q.question }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    return {
      id: q.id,
      question: q.question,
      shape: q.shape,
      sessionId: q.sessionId,
      status: controller.signal.aborted ? "timeout" : "error",
      latencyMs: Date.now() - started,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok || !res.body) {
    clearTimeout(t);
    return {
      id: q.id,
      question: q.question,
      shape: q.shape,
      sessionId: q.sessionId,
      status: "error",
      httpStatus: res.status,
      latencyMs: Date.now() - started,
      errorMessage: await res.text().catch(() => `HTTP ${res.status}`),
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer: string | undefined;
  let chartCount: number | undefined;
  let outcome: string | undefined;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame.trim()) continue;
        for (const ev of parseSseFrame(frame)) {
          if (ev.event === "response" && ev.data && typeof ev.data === "object") {
            const d = ev.data as { answer?: string; charts?: unknown[]; cached?: boolean };
            answer = d.answer;
            chartCount = Array.isArray(d.charts) ? d.charts.length : 0;
            outcome = d.cached ? "cached" : "ok";
          } else if (ev.event === "response_charts" && ev.data && typeof ev.data === "object") {
            const d = ev.data as { charts?: unknown[] };
            if (Array.isArray(d.charts)) chartCount = d.charts.length;
          } else if (ev.event === "error" && ev.data && typeof ev.data === "object") {
            outcome = "error";
            answer = (ev.data as { message?: string }).message;
          }
        }
      }
    }
  } finally {
    clearTimeout(t);
  }

  return {
    id: q.id,
    question: q.question,
    shape: q.shape,
    sessionId: q.sessionId,
    status: "ok",
    httpStatus: res.status,
    latencyMs: Date.now() - started,
    answer,
    chartCount,
    outcome,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `🎯 golden-replay: label=${args.label} server=${args.serverUrl} limit=${args.limit === Infinity ? "all" : args.limit}`
  );

  const raw = await fs.readFile(CORPUS_PATH, "utf8");
  const parsed = goldenCorpusSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error(`❌ corpus failed schema validation: ${parsed.error.message}`);
    process.exit(1);
  }
  const corpus = parsed.data;
  if (corpus.questions.length === 0) {
    console.warn("⚠️ corpus is empty — run `npm run seed-golden-questions` first.");
    process.exit(0);
  }
  const questions = corpus.questions.slice(0, args.limit);

  const metrics: ReplayMetric[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    process.stdout.write(`[${i + 1}/${questions.length}] ${q.id} ... `);
    const m = await replayOne(q, args.serverUrl, args.timeoutMs);
    metrics.push(m);
    process.stdout.write(`${m.status} (${m.latencyMs}ms)\n`);
  }

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `golden-replay-${args.label}.json`);
  const summary = {
    label: args.label,
    serverUrl: args.serverUrl,
    generatedAt: Date.now(),
    corpusVersion: corpus.version,
    corpusBaselineConfig: corpus.baselineConfig,
    questionCount: questions.length,
    okCount: metrics.filter((m) => m.status === "ok").length,
    errorCount: metrics.filter((m) => m.status === "error").length,
    timeoutCount: metrics.filter((m) => m.status === "timeout").length,
    totalLatencyMs: metrics.reduce((s, m) => s + m.latencyMs, 0),
    metrics,
  };
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`✅ wrote ${outPath}`);
  console.log(
    `   ok=${summary.okCount} error=${summary.errorCount} timeout=${summary.timeoutCount} total_latency=${(summary.totalLatencyMs / 1000).toFixed(1)}s`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
