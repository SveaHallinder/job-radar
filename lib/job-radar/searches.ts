import type { SearchSpec } from "./types";

// Built-in queries used when the user hasn't configured any searches yet, so a
// fresh install still returns results. Each connector layers its own source
// specifics on top (e.g. Jooble adds a default location).
export const DEFAULT_SEARCH_KEYWORDS = ["sales", "marketing"];

// Normalize the distinct, non-empty keyword strings a source should query. Falls
// back to the built-in keywords when no searches are configured.
export function keywordsFromSearches(searches: SearchSpec[] | undefined): string[] {
  const configured = (searches ?? [])
    .map((search) => search.keywords.trim())
    .filter(Boolean);
  const unique = [...new Set(configured)];
  return unique.length ? unique : DEFAULT_SEARCH_KEYWORDS;
}

// Build a valid https://www.linkedin.com/jobs/search/ URL from a search. The
// LinkedIn connector later layers recency (f_TPR) and remote (f_WT) filters on
// top, but we set f_WT here too so the intent is explicit.
export function buildLinkedInSearchUrl(spec: SearchSpec): string {
  const url = new URL("https://www.linkedin.com/jobs/search/");
  url.searchParams.set("keywords", spec.keywords.trim());
  const location = spec.location.trim();
  if (location) url.searchParams.set("location", location);
  if (spec.remoteOnly) url.searchParams.set("f_WT", "2");
  return url.toString();
}
