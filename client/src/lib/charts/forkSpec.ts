/**
 * Fork URL spec encoding. WC2.7.
 *
 * Encodes a ChartSpecV2 (minus inline data) into a URL-safe hash so
 * the /explore route can recreate the chart. Inline data is *omitted*
 * from the hash — large row arrays make URLs unusable; the Explorer
 * pulls rows from <RawDataProvider> via the source.sessionId
 * reference instead.
 */

import type { ChartSpecV2 } from "@/shared/schema";

function safeBase64Encode(s: string): string {
  if (typeof btoa === "function") {
    return btoa(unescape(encodeURIComponent(s)));
  }
  return s;
}

function safeBase64Decode(s: string): string {
  if (typeof atob === "function") {
    return decodeURIComponent(escape(atob(s)));
  }
  return s;
}

export function encodeSpecToHash(spec: ChartSpecV2): string {
  // Strip inline data — keep the encoding contract, not the rows.
  const stripped: ChartSpecV2 = {
    ...spec,
    source:
      spec.source.kind === "inline"
        ? { kind: "inline", rows: [] }
        : spec.source,
  };
  const json = JSON.stringify(stripped);
  return safeBase64Encode(json);
}

export function decodeSpecFromHash(hash: string): ChartSpecV2 | null {
  if (!hash) return null;
  try {
    const json = safeBase64Decode(hash);
    const parsed = JSON.parse(json);
    if (typeof parsed === "object" && parsed && parsed.version === 2) {
      return parsed as ChartSpecV2;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the relative URL for the Explorer view. */
export function explorerUrlFromSpec(spec: ChartSpecV2): string {
  return `/explore#spec=${encodeSpecToHash(spec)}`;
}
