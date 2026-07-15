import { resolve } from "node:path";

const ERROR_PREFIX = "[job radar browser]";

const LIMITS = {
  LINKEDIN_BOOTSTRAP_MAX_RESULTS: 200,
  LINKEDIN_INCREMENTAL_MAX_RESULTS: 100,
  LINKEDIN_MAX_DETAILS: 80,
  GOOGLE_MAX_QUERIES: 8,
  GOOGLE_MAX_PAGES: 2,
} as const;

export interface BrowserDiscoveryConfig {
  enabled: boolean;
  profilePath: string;
  statePath: string;
  linkedinSearchUrls: string[];
  linkedinBootstrapMaxResults: number;
  linkedinIncrementalMaxResults: number;
  linkedinMaxDetails: number;
  googleMaxQueries: number;
  googleMaxPages: number;
}

function parseLinkedInSearchUrls(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const urls = value
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const value of urls) {
    try {
      const url = new URL(value);
      const isJobsSearch =
        url.pathname === "/jobs/search" || url.pathname === "/jobs/search/";

      if (
        url.origin !== "https://www.linkedin.com" ||
        url.username ||
        url.password ||
        !isJobsSearch
      ) {
        throw new Error("invalid LinkedIn search URL");
      }
    } catch {
      throw new Error(
        `${ERROR_PREFIX} LINKEDIN_SEARCH_URLS must contain only https://www.linkedin.com/jobs/search URLs.`,
      );
    }
  }

  return urls;
}

function parseLimit(
  env: NodeJS.ProcessEnv,
  name: keyof typeof LIMITS,
): number {
  const value = env[name]?.trim();
  const maximum = LIMITS[name];

  if (!value) return maximum;

  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${ERROR_PREFIX} ${name} must be between 1 and ${maximum}.`);
  }

  return parsed;
}

export function getBrowserDiscoveryConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): BrowserDiscoveryConfig {
  return {
    enabled: env.JOB_RADAR_BROWSER_DISCOVERY === "1",
    profilePath: resolve(
      cwd,
      env.JOB_RADAR_BROWSER_PROFILE_PATH?.trim() || ".data/browser-profile",
    ),
    statePath: resolve(
      cwd,
      env.JOB_RADAR_BROWSER_STATE_PATH?.trim() || ".data/browser-state.json",
    ),
    linkedinSearchUrls: parseLinkedInSearchUrls(env.LINKEDIN_SEARCH_URLS),
    linkedinBootstrapMaxResults: parseLimit(
      env,
      "LINKEDIN_BOOTSTRAP_MAX_RESULTS",
    ),
    linkedinIncrementalMaxResults: parseLimit(
      env,
      "LINKEDIN_INCREMENTAL_MAX_RESULTS",
    ),
    linkedinMaxDetails: parseLimit(env, "LINKEDIN_MAX_DETAILS"),
    googleMaxQueries: parseLimit(env, "GOOGLE_MAX_QUERIES"),
    googleMaxPages: parseLimit(env, "GOOGLE_MAX_PAGES"),
  };
}
