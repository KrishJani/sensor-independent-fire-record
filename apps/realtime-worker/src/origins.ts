/**
 * ALLOWED_ORIGINS: comma-separated. Each entry is an exact origin ("https://nasa-fire-web.pages.dev",
 * "http://localhost:5173") or a single-label wildcard "https://*.nasa-fire-web.pages.dev", which
 * matches exactly one DNS label before the suffix (Cloudflare Pages preview / branch URLs) over
 * https only. Nothing else is a wildcard; there is no "*" for any origin.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | null | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  const o = origin.toLowerCase();
  for (const entry of allowed) {
    if (entry === o) return true;
    const m = /^https:\/\/\*\.([a-z0-9.-]+)$/.exec(entry);
    if (!m || !o.startsWith("https://")) continue;
    const host = o.slice("https://".length);
    const suffix = "." + m[1];
    if (host.endsWith(suffix) && LABEL.test(host.slice(0, -suffix.length))) return true;
  }
  return false;
}
