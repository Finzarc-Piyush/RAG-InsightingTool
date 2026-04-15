/**
 * Extracts the filename from a Content-Disposition header value.
 * Prefers quoted filename= (RFC 2183); falls back to unquoted token.
 */
export function parseFilenameFromContentDisposition(
  header: string | null | undefined
): string | null {
  if (!header || typeof header !== "string") return null;

  const quoted = /\bfilename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted && quoted[1] !== undefined) {
    const name = quoted[1].trim();
    return name.length > 0 ? name : null;
  }

  const unquoted = /\bfilename\s*=\s*([^;\s]+)/i.exec(header);
  if (unquoted?.[1]) {
    const name = unquoted[1].replace(/^['"]|['"]$/g, "").trim();
    return name.length > 0 ? name : null;
  }

  return null;
}
