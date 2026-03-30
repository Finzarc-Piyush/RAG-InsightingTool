import { MODEL } from "../openai.js";

/**
 * Optional deployment for insight-heavy calls (defaults to main MODEL).
 * Set INSIGHT_MODEL to the same value as AZURE_OPENAI_DEPLOYMENT_NAME if you use one deployment.
 */
export function getInsightModel(): string {
  const m = process.env.INSIGHT_MODEL?.trim();
  return m || MODEL;
}

export function getInsightTemperature(): number {
  const raw = process.env.INSIGHT_TEMPERATURE;
  if (raw === undefined || raw === "") return 0.45;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.45;
}

export function getInsightTemperatureConservative(): number {
  const raw = process.env.INSIGHT_TEMPERATURE_CONSERVATIVE;
  if (raw === undefined || raw === "") return 0.35;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.35;
}

export function getBatchInsightTemperature(): number {
  const raw = process.env.INSIGHT_BATCH_TEMPERATURE;
  if (raw === undefined || raw === "") return 0.55;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.55;
}
